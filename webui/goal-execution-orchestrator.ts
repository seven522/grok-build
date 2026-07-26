import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename } from 'node:fs/promises'
import path from 'node:path'

/**
 * A deliberately local, effect-free execution record for the P2 coding loop.
 *
 * This module records intent, plan progress, verifier receipts, cancellation,
 * and recovery instructions.  It never starts a process, calls an ACP agent,
 * or contacts a model/provider.  Callers must wire those effects separately
 * and feed back only stable identifiers and independent verifier receipts.
 */
export const GOAL_EXECUTION_SCHEMA = 'runbuild.goal-execution.v1' as const

export type ExecutionGrantScope = {
  principalId: string
  grantIds: string[]
}

export type GoalExecutionScope = {
  taskId: string
  projectId: string | null
  auth: ExecutionGrantScope
}

export type GoalPlanState = 'pending' | 'running' | 'verifying' | 'verified' | 'blocked' | 'failed' | 'cancelled'
export type GoalRunState = 'planning' | 'executing' | 'verifying' | 'verified' | 'blocked' | 'failed' | 'cancelling' | 'cancelled' | 'recovering'
export type GoalRecoveryState = 'active' | 'interrupted' | 'cancel_requested'

export type GoalPlanStep = {
  id: string
  label: string
  state: GoalPlanState
  createdAt: string
  updatedAt: string
}

export type GoalVerifierReceipt = {
  id: string
  verifierId: string
  authority: 'independent_verifier'
  planStepId: string
  status: 'passed' | 'failed' | 'blocked'
  checkedAt: string
  evidenceIds: string[]
  summary: string
}

export type GoalExecutionEventKind =
  | 'run.created'
  | 'plan.step.started'
  | 'agent.claimed'
  | 'verifier.passed'
  | 'verifier.failed'
  | 'verifier.blocked'
  | 'run.disconnected'
  | 'run.recovery.planned'
  | 'cancel.requested'
  | 'cancel.acknowledged'

export type GoalExecutionEvent = {
  id: string
  sequence: number
  at: string
  kind: GoalExecutionEventKind
  planStepId?: string
}

export type GoalExecutionRun = {
  version: 1
  id: string
  goal: string
  scope: GoalExecutionScope
  state: GoalRunState
  recovery: {
    state: GoalRecoveryState
    attempts: number
    lastDisconnectedAt?: string
  }
  plan: GoalPlanStep[]
  verifierReceipts: GoalVerifierReceipt[]
  events: GoalExecutionEvent[]
  createdAt: string
  updatedAt: string
}

export type GoalRunProjection = {
  runId: string
  state: GoalRunState
  recovery: GoalRecoveryState
  plan: {
    pending: number
    running: number
    verifying: number
    verified: number
    blocked: number
    failed: number
    cancelled: number
  }
  independentVerifierReceiptCount: number
  completionAccepted: boolean
  activity: Array<{
    id: string
    sequence: number
    at: string
    tone: 'info' | 'success' | 'warning' | 'error'
    text: string
  }>
}

export type GoalRecoveryAction = {
  kind: 'resume_goal_execution' | 'resume_then_cancel'
  runId: string
}

export type GoalExecutionCreateInput = {
  operationId: string
  scope: GoalExecutionScope
  goal: string
  plan: readonly { id: string; label: string }[]
}

export type GoalPlanUpdateInput = {
  operationId: string
  runId: string
  scope: GoalExecutionScope
  planStepId: string
}

export type GoalVerifierUpdateInput = GoalPlanUpdateInput & {
  receipt: GoalVerifierReceipt
}

export type GoalRecoveryUpdateInput = {
  operationId: string
  runId: string
  scope: GoalExecutionScope
}

export class GoalExecutionValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoalExecutionValidationError'
  }
}

export class GoalExecutionConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoalExecutionConflictError'
  }
}

export class GoalExecutionScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoalExecutionScopeError'
  }
}

type StoredOperation = {
  id: string
  kind: string
  fingerprint: string
  runId: string
  recordedAt: string
}

type GoalExecutionFile = {
  schema: typeof GOAL_EXECUTION_SCHEMA
  runs: GoalExecutionRun[]
  operations: StoredOperation[]
}

export type GoalExecutionOrchestrator = ReturnType<typeof createGoalExecutionOrchestrator>

const MAX_IDENTIFIER_LENGTH = 256
const MAX_GOAL_BYTES = 64 * 1024
const MAX_PLAN_STEPS = 48
const MAX_EVENT_COUNT = 1_024
const MAX_OPERATION_COUNT = 4_096
const MAX_STATE_BYTES = 8 * 1024 * 1024
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : ''

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

const canonicalJson = (value: unknown): string => {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new GoalExecutionValidationError('幂等操作内容无效')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  throw new GoalExecutionValidationError('幂等操作内容无效')
}

const identifier = (value: unknown, label: string, nullable = false): string | null => {
  if (nullable && value === null) return null
  if (
    typeof value !== 'string'
    || !value
    || value.length > MAX_IDENTIFIER_LENGTH
    || CONTROL_CHARACTERS.test(value)
    || value.includes('/')
    || value.includes('\\')
  ) throw new GoalExecutionValidationError(`${label} 无效`)
  return value
}

const operationId = (value: unknown) => {
  if (typeof value !== 'string' || !operationIdPattern.test(value)) throw new GoalExecutionValidationError('operationId 无效')
  return value
}

const text = (value: unknown, label: string, maximumBytes: number) => {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new GoalExecutionValidationError(`${label} 无效`)
  }
  return value.trim()
}

const canonicalTimestamp = (value: unknown, label: string) => {
  if (typeof value !== 'string') throw new GoalExecutionValidationError(`${label} 无效`)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) throw new GoalExecutionValidationError(`${label} 无效`)
  return parsed.toISOString()
}

const normalizedGrantIds = (value: unknown) => {
  if (!Array.isArray(value) || value.length > 128) throw new GoalExecutionValidationError('授权范围无效')
  const grants = value.map((entry) => identifier(entry, '授权标识') as string).sort()
  if (new Set(grants).size !== grants.length) throw new GoalExecutionValidationError('授权标识重复')
  return grants
}

const normalizedScope = (value: unknown): GoalExecutionScope => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoalExecutionValidationError('执行范围无效')
  const record = value as Record<string, unknown>
  if (!record.auth || typeof record.auth !== 'object' || Array.isArray(record.auth)) throw new GoalExecutionValidationError('授权范围无效')
  const auth = record.auth as Record<string, unknown>
  return {
    taskId: identifier(record.taskId, 'taskId') as string,
    projectId: identifier(record.projectId, 'projectId', true),
    auth: {
      principalId: identifier(auth.principalId, '授权主体') as string,
      grantIds: normalizedGrantIds(auth.grantIds),
    },
  }
}

const scopeMatches = (stored: GoalExecutionScope, requested: GoalExecutionScope) => (
  stored.taskId === requested.taskId
  && stored.projectId === requested.projectId
  && stored.auth.principalId === requested.auth.principalId
  && requested.auth.grantIds.every((grant) => stored.auth.grantIds.includes(grant))
)

const planState = (value: unknown): GoalPlanState => {
  if (value === 'pending' || value === 'running' || value === 'verifying' || value === 'verified' || value === 'blocked' || value === 'failed' || value === 'cancelled') return value
  throw new GoalExecutionValidationError('计划步骤状态无效')
}

const runState = (value: unknown): GoalRunState => {
  if (value === 'planning' || value === 'executing' || value === 'verifying' || value === 'verified' || value === 'blocked' || value === 'failed' || value === 'cancelling' || value === 'cancelled' || value === 'recovering') return value
  throw new GoalExecutionValidationError('目标运行状态无效')
}

const recoveryState = (value: unknown): GoalRecoveryState => {
  if (value === 'active' || value === 'interrupted' || value === 'cancel_requested') return value
  throw new GoalExecutionValidationError('恢复状态无效')
}

const eventKind = (value: unknown): GoalExecutionEventKind => {
  if (
    value === 'run.created'
    || value === 'plan.step.started'
    || value === 'agent.claimed'
    || value === 'verifier.passed'
    || value === 'verifier.failed'
    || value === 'verifier.blocked'
    || value === 'run.disconnected'
    || value === 'run.recovery.planned'
    || value === 'cancel.requested'
    || value === 'cancel.acknowledged'
  ) return value
  throw new GoalExecutionValidationError('执行事件类型无效')
}

const normalizedPlan = (value: unknown, now: string): GoalPlanStep[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PLAN_STEPS) throw new GoalExecutionValidationError('任务计划无效')
  const plan = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new GoalExecutionValidationError('任务计划步骤无效')
    const item = entry as Record<string, unknown>
    return {
      id: identifier(item.id, '计划步骤标识') as string,
      label: text(item.label, '计划步骤说明', 2 * 1024),
      state: 'pending' as const,
      createdAt: now,
      updatedAt: now,
    }
  })
  if (new Set(plan.map((step) => step.id)).size !== plan.length) throw new GoalExecutionValidationError('计划步骤标识重复')
  return plan
}

const normalizedReceipt = (value: unknown, expectedStepId: string): GoalVerifierReceipt => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoalExecutionValidationError('验证收据无效')
  const receipt = value as Record<string, unknown>
  if (receipt.authority !== 'independent_verifier') throw new GoalExecutionValidationError('验证收据必须来自独立验证器')
  const status = receipt.status
  if (status !== 'passed' && status !== 'failed' && status !== 'blocked') throw new GoalExecutionValidationError('验证收据状态无效')
  const evidenceIds = normalizedGrantIds(receipt.evidenceIds)
  if (!evidenceIds.length) throw new GoalExecutionValidationError('验证收据缺少证据标识')
  const planStepId = identifier(receipt.planStepId, '验证计划步骤') as string
  if (planStepId !== expectedStepId) throw new GoalExecutionValidationError('验证收据范围与计划步骤不一致')
  return {
    id: identifier(receipt.id, '验证收据标识') as string,
    verifierId: identifier(receipt.verifierId, '验证器标识') as string,
    authority: 'independent_verifier',
    planStepId,
    status,
    checkedAt: canonicalTimestamp(receipt.checkedAt, '验证检查时间'),
    evidenceIds,
    summary: text(receipt.summary, '验证收据摘要', 8 * 1024),
  }
}

const normalizedEvent = (value: unknown): GoalExecutionEvent => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoalExecutionValidationError('执行事件无效')
  const event = value as Record<string, unknown>
  const sequence = event.sequence
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) throw new GoalExecutionValidationError('执行事件序号无效')
  const planStepId = event.planStepId === undefined ? undefined : identifier(event.planStepId, '执行事件计划步骤') as string
  return {
    id: identifier(event.id, '执行事件标识') as string,
    sequence,
    at: canonicalTimestamp(event.at, '执行事件时间'),
    kind: eventKind(event.kind),
    ...(planStepId ? { planStepId } : {}),
  }
}

const normalizedStoredPlan = (value: unknown): GoalPlanStep[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PLAN_STEPS) throw new GoalExecutionValidationError('任务计划无效')
  const plan = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new GoalExecutionValidationError('任务计划步骤无效')
    const step = entry as Record<string, unknown>
    return {
      id: identifier(step.id, '计划步骤标识') as string,
      label: text(step.label, '计划步骤说明', 2 * 1024),
      state: planState(step.state),
      createdAt: canonicalTimestamp(step.createdAt, '计划步骤创建时间'),
      updatedAt: canonicalTimestamp(step.updatedAt, '计划步骤更新时间'),
    }
  })
  if (new Set(plan.map((step) => step.id)).size !== plan.length) throw new GoalExecutionValidationError('计划步骤标识重复')
  return plan
}

const normalizedStoredReceipt = (value: unknown, planIds: Set<string>) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoalExecutionValidationError('验证收据无效')
  const receipt = value as Record<string, unknown>
  const planStepId = identifier(receipt.planStepId, '验证计划步骤') as string
  if (!planIds.has(planStepId)) throw new GoalExecutionValidationError('验证收据引用未知计划步骤')
  return normalizedReceipt(receipt, planStepId)
}

const normalizedStoredRun = (value: unknown): GoalExecutionRun => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoalExecutionValidationError('目标运行记录无效')
  const run = value as Record<string, unknown>
  if (run.version !== 1) throw new GoalExecutionValidationError('目标运行记录版本无效')
  if (!run.recovery || typeof run.recovery !== 'object' || Array.isArray(run.recovery)) throw new GoalExecutionValidationError('恢复记录无效')
  const recovery = run.recovery as Record<string, unknown>
  const attempts = recovery.attempts
  if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0) throw new GoalExecutionValidationError('恢复尝试次数无效')
  const plan = normalizedStoredPlan(run.plan)
  const planIds = new Set(plan.map((step) => step.id))
  if (!Array.isArray(run.verifierReceipts)) throw new GoalExecutionValidationError('验证收据列表无效')
  const verifierReceipts = run.verifierReceipts.map((entry) => normalizedStoredReceipt(entry, planIds))
  if (new Set(verifierReceipts.map((entry) => entry.id)).size !== verifierReceipts.length) throw new GoalExecutionValidationError('验证收据标识重复')
  if (!Array.isArray(run.events) || run.events.length > MAX_EVENT_COUNT) throw new GoalExecutionValidationError('执行事件列表无效')
  const events = run.events.map(normalizedEvent)
  if (events.some((event, index) => event.sequence !== index + 1)) throw new GoalExecutionValidationError('执行事件序号不连续')
  const state = runState(run.state)
  const result: GoalExecutionRun = {
    version: 1,
    id: identifier(run.id, '目标运行标识') as string,
    goal: text(run.goal, '目标', MAX_GOAL_BYTES),
    scope: normalizedScope(run.scope),
    state,
    recovery: {
      state: recoveryState(recovery.state),
      attempts,
      ...(recovery.lastDisconnectedAt === undefined ? {} : { lastDisconnectedAt: canonicalTimestamp(recovery.lastDisconnectedAt, '断连时间') }),
    },
    plan,
    verifierReceipts,
    events,
    createdAt: canonicalTimestamp(run.createdAt, '目标运行创建时间'),
    updatedAt: canonicalTimestamp(run.updatedAt, '目标运行更新时间'),
  }
  const stepHasIndependentReceipt = (step: GoalPlanStep) => result.verifierReceipts.some((receipt) => (
    receipt.planStepId === step.id && receipt.authority === 'independent_verifier' && receipt.status === 'passed' && receipt.evidenceIds.length > 0
  ))
  const verifiedStepsHaveReceipts = result.plan.filter((step) => step.state === 'verified').every(stepHasIndependentReceipt)
  const independentlyVerified = result.plan.every((step) => (
    step.state === 'verified'
    && stepHasIndependentReceipt(step)
  ))
  if (!verifiedStepsHaveReceipts) {
    throw new GoalExecutionValidationError('已验证计划步骤缺少独立验证收据')
  }
  if (result.state === 'verified' && !independentlyVerified) throw new GoalExecutionValidationError('目标运行不能在缺少独立验证收据时标记成功')
  return result
}

const normalizedStoredOperation = (value: unknown): StoredOperation => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoalExecutionValidationError('幂等操作记录无效')
  const operation = value as Record<string, unknown>
  if (typeof operation.kind !== 'string' || !operation.kind) throw new GoalExecutionValidationError('幂等操作类型无效')
  if (typeof operation.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(operation.fingerprint)) throw new GoalExecutionValidationError('幂等操作指纹无效')
  return {
    id: operationId(operation.id),
    kind: operation.kind,
    fingerprint: operation.fingerprint,
    runId: identifier(operation.runId, '幂等操作目标运行') as string,
    recordedAt: canonicalTimestamp(operation.recordedAt, '幂等操作时间'),
  }
}

const emptyFile = (): GoalExecutionFile => ({ schema: GOAL_EXECUTION_SCHEMA, runs: [], operations: [] })

const normalizedFile = (value: unknown): GoalExecutionFile => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoalExecutionValidationError('目标执行状态文件无效')
  const file = value as Record<string, unknown>
  if (file.schema !== GOAL_EXECUTION_SCHEMA || !Array.isArray(file.runs) || !Array.isArray(file.operations)) throw new GoalExecutionValidationError('目标执行状态文件 schema 无效')
  const runs = file.runs.map(normalizedStoredRun)
  const operations = file.operations.map(normalizedStoredOperation)
  if (new Set(runs.map((run) => run.id)).size !== runs.length) throw new GoalExecutionValidationError('目标运行标识重复')
  if (new Set(operations.map((operation) => operation.id)).size !== operations.length) throw new GoalExecutionValidationError('幂等操作标识重复')
  if (operations.some((operation) => !runs.some((run) => run.id === operation.runId))) throw new GoalExecutionValidationError('幂等操作引用未知目标运行')
  return { schema: GOAL_EXECUTION_SCHEMA, runs, operations }
}

const runIsTerminal = (run: GoalExecutionRun) => run.state === 'verified' || run.state === 'blocked' || run.state === 'failed' || run.state === 'cancelled'

const hasPassedReceipt = (run: GoalExecutionRun, planStepId: string) => run.verifierReceipts.some((receipt) => (
  receipt.planStepId === planStepId
  && receipt.authority === 'independent_verifier'
  && receipt.status === 'passed'
  && receipt.evidenceIds.length > 0
))

const deriveRunState = (run: GoalExecutionRun): GoalRunState => {
  if (run.state === 'cancelling' || run.state === 'cancelled') return run.state
  if (run.plan.every((step) => step.state === 'verified' && hasPassedReceipt(run, step.id))) return 'verified'
  if (run.plan.some((step) => step.state === 'failed')) return 'failed'
  if (run.plan.some((step) => step.state === 'blocked')) return 'blocked'
  if (run.plan.some((step) => step.state === 'verifying')) return 'verifying'
  if (run.plan.some((step) => step.state === 'running')) return 'executing'
  return 'planning'
}

const assertScope = (run: GoalExecutionRun, scope: unknown) => {
  const requested = normalizedScope(scope)
  if (!scopeMatches(run.scope, requested)) throw new GoalExecutionScopeError('目标运行不属于当前任务、项目或授权范围')
  return requested
}

const findRun = (file: GoalExecutionFile, runIdValue: unknown) => {
  const runId = identifier(runIdValue, '目标运行标识') as string
  const run = file.runs.find((item) => item.id === runId)
  if (!run) throw new GoalExecutionConflictError('目标运行不存在')
  return run
}

const findStep = (run: GoalExecutionRun, stepIdValue: unknown) => {
  const stepId = identifier(stepIdValue, '计划步骤标识') as string
  const step = run.plan.find((item) => item.id === stepId)
  if (!step) throw new GoalExecutionConflictError('计划步骤不存在')
  return step
}

const appendEvent = (run: GoalExecutionRun, kind: GoalExecutionEventKind, at: string, planStepId?: string) => {
  if (run.events.length >= MAX_EVENT_COUNT) throw new GoalExecutionConflictError('执行事件数量超过限制')
  const sequence = run.events.length + 1
  run.events.push({
    id: `goal_evt_${hash(`${run.id}\u0000${sequence}\u0000${kind}`).slice(0, 32)}`,
    sequence,
    at,
    kind,
    ...(planStepId ? { planStepId } : {}),
  })
}

const eventProjection = (event: GoalExecutionEvent, plan: readonly GoalPlanStep[]) => {
  const number = event.planStepId ? plan.findIndex((step) => step.id === event.planStepId) + 1 : 0
  const step = number > 0 ? `步骤 ${number}` : '任务'
  const copy: Record<GoalExecutionEventKind, { tone: 'info' | 'success' | 'warning' | 'error'; text: string }> = {
    'run.created': { tone: 'info', text: '已创建可验证执行计划。' },
    'plan.step.started': { tone: 'info', text: `${step} 已开始执行。` },
    'agent.claimed': { tone: 'warning', text: `${step} 已收到 Agent 回报，等待独立验证。` },
    'verifier.passed': { tone: 'success', text: `${step} 已获得独立验证收据。` },
    'verifier.failed': { tone: 'error', text: `${step} 的独立验证未通过。` },
    'verifier.blocked': { tone: 'warning', text: `${step} 的独立验证被阻塞。` },
    'run.disconnected': { tone: 'warning', text: '执行连接中断，等待恢复。' },
    'run.recovery.planned': { tone: 'info', text: '已生成可恢复执行指令。' },
    'cancel.requested': { tone: 'warning', text: '已请求停止执行。' },
    'cancel.acknowledged': { tone: 'warning', text: '执行已确认停止。' },
  }
  return { id: event.id, sequence: event.sequence, at: event.at, ...copy[event.kind] }
}

/**
 * Safe UI/telemetry projection.  It intentionally excludes the goal text,
 * plan labels, verifier summaries/evidence, auth grants, and any Agent prose.
 */
export const projectGoalExecutionRun = (run: GoalExecutionRun, limit = 32): GoalRunProjection => {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 32
  const counts = {
    pending: 0,
    running: 0,
    verifying: 0,
    verified: 0,
    blocked: 0,
    failed: 0,
    cancelled: 0,
  }
  for (const step of run.plan) counts[step.state] += 1
  return {
    runId: run.id,
    state: run.state,
    recovery: run.recovery.state,
    plan: counts,
    independentVerifierReceiptCount: run.verifierReceipts.filter((receipt) => receipt.authority === 'independent_verifier').length,
    completionAccepted: run.state === 'verified' && run.plan.every((step) => step.state === 'verified' && hasPassedReceipt(run, step.id)),
    activity: run.events.slice(-boundedLimit).reverse().map((event) => eventProjection(event, run.plan)),
  }
}

export function createGoalExecutionOrchestrator(options: {
  storageDir: string
  now?: () => Date
  idFactory?: () => string
}) {
  const storageDir = path.resolve(options.storageDir)
  const statePath = path.join(storageDir, 'goal-executions.json')
  const now = options.now ?? (() => new Date())
  const idFactory = options.idFactory ?? randomUUID
  let operationQueue: Promise<void> = Promise.resolve()

  const timestamp = () => now().toISOString()

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationQueue.then(operation, operation)
    operationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  const ensureStorage = async () => {
    await mkdir(storageDir, { recursive: true, mode: 0o700 })
    const metadata = await lstat(storageDir)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new GoalExecutionValidationError('目标执行存储目录不安全')
    try { await chmod(storageDir, 0o700) } catch { /* Filesystems without POSIX permissions are still supported. */ }
  }

  const readState = async (): Promise<GoalExecutionFile> => {
    await ensureStorage()
    try {
      const metadata = await lstat(statePath)
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_STATE_BYTES || (metadata.mode & 0o077) !== 0) {
        throw new GoalExecutionValidationError('目标执行状态文件不安全')
      }
      return normalizedFile(JSON.parse(await readFile(statePath, 'utf8')) as unknown)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return emptyFile()
      throw error
    }
  }

  const persistState = async (state: GoalExecutionFile) => {
    await ensureStorage()
    const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
    const handle = await open(temporaryPath, 'w', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, statePath)
    try { await chmod(statePath, 0o600) } catch { /* Filesystems without POSIX permissions are still supported. */ }
  }

  const mutate = async (
    operation: { id: unknown; kind: string; fingerprintInput: unknown },
    action: (state: GoalExecutionFile, nowAt: string) => GoalExecutionRun,
  ) => serialize(async () => {
    const id = operationId(operation.id)
    const fingerprint = hash(canonicalJson(operation.fingerprintInput))
    const state = await readState()
    const previous = state.operations.find((entry) => entry.id === id)
    if (previous) {
      if (previous.kind !== operation.kind || previous.fingerprint !== fingerprint) throw new GoalExecutionConflictError('operationId 已用于不同更新')
      return clone(findRun(state, previous.runId))
    }
    const result = action(state, timestamp())
    state.operations.push({ id, kind: operation.kind, fingerprint, runId: result.id, recordedAt: timestamp() })
    if (state.operations.length > MAX_OPERATION_COUNT) state.operations.splice(0, state.operations.length - MAX_OPERATION_COUNT)
    await persistState(state)
    return clone(result)
  })

  const createRun = async (input: GoalExecutionCreateInput) => {
    const scope = normalizedScope(input.scope)
    const goal = text(input.goal, '目标', MAX_GOAL_BYTES)
    const initialAt = timestamp()
    const plan = normalizedPlan(input.plan, initialAt)
    const runId = `goal_run_${identifier(idFactory(), '目标运行随机标识')}`
    return mutate(
      {
        id: input.operationId,
        kind: 'run.create',
        fingerprintInput: { scope, goal, plan: plan.map(({ id, label }) => ({ id, label })) },
      },
      (state, nowAt) => {
        if (state.runs.some((run) => run.id === runId)) throw new GoalExecutionConflictError('目标运行标识冲突')
        const run: GoalExecutionRun = {
          version: 1,
          id: runId,
          goal,
          scope,
          state: 'planning',
          recovery: { state: 'active', attempts: 0 },
          plan: plan.map((step) => ({ ...step, createdAt: nowAt, updatedAt: nowAt })),
          verifierReceipts: [],
          events: [],
          createdAt: nowAt,
          updatedAt: nowAt,
        }
        appendEvent(run, 'run.created', nowAt)
        state.runs.push(run)
        return run
      },
    )
  }

  const startPlanStep = (input: GoalPlanUpdateInput) => mutate(
    {
      id: input.operationId,
      kind: 'plan.start',
      fingerprintInput: { runId: input.runId, scope: normalizedScope(input.scope), planStepId: input.planStepId },
    },
    (state, nowAt) => {
      const run = findRun(state, input.runId)
      assertScope(run, input.scope)
      if (runIsTerminal(run) || run.state === 'cancelling') throw new GoalExecutionConflictError('终态或取消中的目标运行不能开始计划步骤')
      const step = findStep(run, input.planStepId)
      if (step.state === 'pending') {
        step.state = 'running'
        step.updatedAt = nowAt
        run.recovery = { state: 'active', attempts: run.recovery.attempts }
        run.state = 'executing'
        appendEvent(run, 'plan.step.started', nowAt, step.id)
      } else if (step.state !== 'running') {
        throw new GoalExecutionConflictError('计划步骤不能再次开始')
      }
      run.updatedAt = nowAt
      return run
    },
  )

  /**
   * An Agent can only say that a step is ready for verification.  `prose` is
   * intentionally not persisted and cannot move a plan step to `verified`.
   */
  const recordAgentClaim = (input: GoalPlanUpdateInput & { claimId: string; prose?: unknown }) => mutate(
    {
      id: input.operationId,
      kind: 'agent.claim',
      fingerprintInput: { runId: input.runId, scope: normalizedScope(input.scope), planStepId: input.planStepId, claimId: identifier(input.claimId, 'Agent 回报标识') },
    },
    (state, nowAt) => {
      const run = findRun(state, input.runId)
      assertScope(run, input.scope)
      if (runIsTerminal(run) || run.state === 'cancelling') throw new GoalExecutionConflictError('终态或取消中的目标运行不能接受 Agent 回报')
      const step = findStep(run, input.planStepId)
      if (step.state === 'running') {
        step.state = 'verifying'
        step.updatedAt = nowAt
        run.state = 'verifying'
        appendEvent(run, 'agent.claimed', nowAt, step.id)
      } else if (step.state !== 'verifying') {
        throw new GoalExecutionConflictError('仅执行中的计划步骤可以请求验证')
      }
      run.updatedAt = nowAt
      return run
    },
  )

  const recordVerifierReceipt = (input: GoalVerifierUpdateInput) => mutate(
    {
      id: input.operationId,
      kind: 'verifier.record',
      fingerprintInput: {
        runId: input.runId,
        scope: normalizedScope(input.scope),
        planStepId: input.planStepId,
        receipt: input.receipt,
      },
    },
    (state, nowAt) => {
      const run = findRun(state, input.runId)
      assertScope(run, input.scope)
      if (runIsTerminal(run) || run.state === 'cancelling') throw new GoalExecutionConflictError('终态或取消中的目标运行不能记录验证收据')
      const step = findStep(run, input.planStepId)
      if (step.state !== 'verifying') throw new GoalExecutionConflictError('计划步骤尚未等待验证')
      const receipt = normalizedReceipt(input.receipt, step.id)
      if (run.verifierReceipts.some((item) => item.id === receipt.id)) throw new GoalExecutionConflictError('验证收据标识已存在')
      run.verifierReceipts.push(receipt)
      if (receipt.status === 'passed') {
        step.state = 'verified'
        appendEvent(run, 'verifier.passed', nowAt, step.id)
      } else if (receipt.status === 'failed') {
        step.state = 'failed'
        appendEvent(run, 'verifier.failed', nowAt, step.id)
      } else {
        step.state = 'blocked'
        appendEvent(run, 'verifier.blocked', nowAt, step.id)
      }
      step.updatedAt = nowAt
      run.state = deriveRunState(run)
      run.updatedAt = nowAt
      return run
    },
  )

  const markDisconnected = (input: GoalRecoveryUpdateInput) => mutate(
    {
      id: input.operationId,
      kind: 'run.disconnected',
      fingerprintInput: { runId: input.runId, scope: normalizedScope(input.scope) },
    },
    (state, nowAt) => {
      const run = findRun(state, input.runId)
      assertScope(run, input.scope)
      if (runIsTerminal(run)) throw new GoalExecutionConflictError('终态目标运行不需要恢复')
      const cancelRequested = run.state === 'cancelling' || run.recovery.state === 'cancel_requested'
      run.recovery = {
        state: cancelRequested ? 'cancel_requested' : 'interrupted',
        attempts: run.recovery.attempts + 1,
        lastDisconnectedAt: nowAt,
      }
      if (!cancelRequested) run.state = 'recovering'
      appendEvent(run, 'run.disconnected', nowAt)
      run.updatedAt = nowAt
      return run
    },
  )

  const recoverRun = async (input: GoalRecoveryUpdateInput): Promise<{ run: GoalExecutionRun; action: GoalRecoveryAction }> => {
    const run = await mutate(
      {
        id: input.operationId,
        kind: 'run.recover',
        fingerprintInput: { runId: input.runId, scope: normalizedScope(input.scope) },
      },
      (state, nowAt) => {
        const current = findRun(state, input.runId)
        assertScope(current, input.scope)
        if (runIsTerminal(current)) throw new GoalExecutionConflictError('终态目标运行不能恢复')
        if (current.recovery.state === 'active' && current.state !== 'recovering') throw new GoalExecutionConflictError('目标运行没有待恢复连接')
        const cancelling = current.state === 'cancelling' || current.recovery.state === 'cancel_requested'
        current.recovery = { state: cancelling ? 'cancel_requested' : 'active', attempts: current.recovery.attempts }
        if (!cancelling) current.state = deriveRunState(current)
        appendEvent(current, 'run.recovery.planned', nowAt)
        current.updatedAt = nowAt
        return current
      },
    )
    return {
      run,
      action: { kind: run.state === 'cancelling' || run.recovery.state === 'cancel_requested' ? 'resume_then_cancel' : 'resume_goal_execution', runId: run.id },
    }
  }

  const requestCancellation = (input: GoalRecoveryUpdateInput) => mutate(
    {
      id: input.operationId,
      kind: 'cancel.request',
      fingerprintInput: { runId: input.runId, scope: normalizedScope(input.scope) },
    },
    (state, nowAt) => {
      const run = findRun(state, input.runId)
      assertScope(run, input.scope)
      if (runIsTerminal(run)) throw new GoalExecutionConflictError('终态目标运行不能取消')
      if (run.state !== 'cancelling') {
        run.state = 'cancelling'
        run.recovery = { state: 'cancel_requested', attempts: run.recovery.attempts }
        appendEvent(run, 'cancel.requested', nowAt)
      }
      run.updatedAt = nowAt
      return run
    },
  )

  const acknowledgeCancellation = (input: GoalRecoveryUpdateInput) => mutate(
    {
      id: input.operationId,
      kind: 'cancel.acknowledge',
      fingerprintInput: { runId: input.runId, scope: normalizedScope(input.scope) },
    },
    (state, nowAt) => {
      const run = findRun(state, input.runId)
      assertScope(run, input.scope)
      if (run.state !== 'cancelling') throw new GoalExecutionConflictError('目标运行没有待确认的取消请求')
      for (const step of run.plan) {
        if (step.state === 'pending' || step.state === 'running' || step.state === 'verifying') {
          step.state = 'cancelled'
          step.updatedAt = nowAt
        }
      }
      run.state = 'cancelled'
      run.recovery = { state: 'active', attempts: run.recovery.attempts }
      appendEvent(run, 'cancel.acknowledged', nowAt)
      run.updatedAt = nowAt
      return run
    },
  )

  const getRun = async (input: { runId: string; scope: GoalExecutionScope }) => serialize(async () => {
    const state = await readState()
    const run = findRun(state, input.runId)
    assertScope(run, input.scope)
    return clone(run)
  })

  const listRecoverableRuns = async (scope: GoalExecutionScope) => serialize(async () => {
    const requested = normalizedScope(scope)
    const state = await readState()
    return state.runs
      .filter((run) => !runIsTerminal(run) && scopeMatches(run.scope, requested))
      .map(clone)
  })

  return {
    statePath,
    createRun,
    startPlanStep,
    recordAgentClaim,
    recordVerifierReceipt,
    markDisconnected,
    recoverRun,
    requestCancellation,
    acknowledgeCancellation,
    getRun,
    listRecoverableRuns,
  }
}
