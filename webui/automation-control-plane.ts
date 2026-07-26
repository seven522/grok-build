import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

import {
  nextDueAt,
  parseAutomationSchedule,
  type AutomationSchedule,
} from './automation-schedule.ts'
import type { TaskEventLedger } from './task-event-ledger.ts'

/**
 * P3A deliberately owns scheduling and durable handoff only.  It never opens
 * an ACP session, starts a Runner, sends a prompt, or grants a tool
 * permission.  The renderer must bind a real task.created/run.started receipt
 * before it can mark a queued run as dispatched.
 */
export const AUTOMATION_CONTROL_SCHEMA = 'runbuild.automation-control.v1' as const

export type AutomationExecutionPolicy = {
  permission: 'manual-current'
  maxPendingRuns: number
  maxAttempts: number
  retryDelayMinutes: number
  maxRunsPerDay: number
  maxWallClockMinutes: number
  tokenBudget: 'unsupported'
}

export type AutomationDefinition = {
  id: string
  revision: number
  name: string
  instruction: string
  projectId: string | null
  schedule: AutomationSchedule
  enabled: boolean
  nextDueAt: string | null
  policy: AutomationExecutionPolicy
  createdAt: string
  updatedAt: string
  migratedFromLegacy?: true
}

export type AutomationRunState =
  | 'queued'
  | 'claimed'
  | 'prepared'
  | 'dispatch_unconfirmed'
  | 'dispatched'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'budget_exhausted'
  | 'cancelled'

export type AutomationRunTrigger = 'manual' | 'schedule' | 'retry' | 'replay'

export type AutomationRunAuditKind =
  | 'queued'
  | 'claim.acquired'
  | 'claim.expired'
  | 'task.bound'
  | 'dispatch.prepared'
  | 'dispatch.confirmed'
  | 'settled.verified'
  | 'settled.failed'
  | 'settled.blocked'
  | 'settled.cancelled'
  | 'retry.queued'
  | 'budget.blocked'
  | 'released'

export type AutomationRunAudit = {
  id: string
  sequence: number
  at: string
  kind: AutomationRunAuditKind
  detail?: string
}

type AutomationClaim = {
  id: string
  clientId: string
  expiresAt: string
}

type AutomationRun = {
  id: string
  automationId: string
  occurrenceKey: string
  trigger: AutomationRunTrigger
  state: AutomationRunState
  attempt: number
  scheduledFor: string | null
  availableAt: string | null
  replayOf: string | null
  retryOf: string | null
  projectId: string | null
  instruction: string
  policy: AutomationExecutionPolicy
  claim: AutomationClaim | null
  taskId: string | null
  agentRunId: string | null
  taskCreatedEventId: string | null
  runStartedEventId: string | null
  deadlineAt: string | null
  createdAt: string
  updatedAt: string
  audit: AutomationRunAudit[]
}

export type AutomationRunView = Omit<AutomationRun, 'instruction'>

type AutomationOperation = {
  id: string
  kind: string
  fingerprint: string
  targetKind: 'automation' | 'run'
  targetId: string
  recordedAt: string
}

type AutomationControlFile = {
  schema: typeof AUTOMATION_CONTROL_SCHEMA
  automations: AutomationDefinition[]
  runs: AutomationRun[]
  operations: AutomationOperation[]
}

export class AutomationControlValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AutomationControlValidationError'
  }
}

export class AutomationControlConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AutomationControlConflictError'
  }
}

const MAX_STATE_BYTES = 8 * 1024 * 1024
const MAX_AUTOMATIONS = 512
const MAX_RUNS = 8_000
const MAX_AUDIT_EVENTS = 64
const MAX_OPERATIONS = 4_096
const MAX_BODY_BYTES = 256 * 1024
const MAX_NAME_BYTES = 300
const MAX_INSTRUCTION_BYTES = 48 * 1024
const MAX_IDENTIFIER_LENGTH = 256
const MAX_CLIENT_ID_LENGTH = 256
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const CONTROL = /[\u0000-\u001f\u007f]/

const DEFAULT_POLICY: AutomationExecutionPolicy = {
  permission: 'manual-current',
  maxPendingRuns: 1,
  maxAttempts: 2,
  retryDelayMinutes: 5,
  maxRunsPerDay: 12,
  maxWallClockMinutes: 45,
  tokenBudget: 'unsupported',
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
const object = (value: unknown, label: string) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AutomationControlValidationError(`${label} 必须是对象`)
  return value as Record<string, unknown>
}
const string = (value: unknown, label: string, maximumBytes = MAX_IDENTIFIER_LENGTH) => {
  if (typeof value !== 'string') throw new AutomationControlValidationError(`${label} 无效`)
  const normalized = value.trim()
  if (!normalized || normalized.includes('\0') || CONTROL.test(normalized) || Buffer.byteLength(normalized, 'utf8') > maximumBytes) {
    throw new AutomationControlValidationError(`${label} 无效`)
  }
  return normalized
}
const identifier = (value: unknown, label: string, nullable = false): string | null => {
  if (nullable && value === null) return null
  const normalized = string(value, label)
  if (normalized.includes('/') || normalized.includes('\\')) throw new AutomationControlValidationError(`${label} 无效`)
  return normalized
}
const timestamp = (value: unknown, label: string) => {
  if (typeof value !== 'string') throw new AutomationControlValidationError(`${label} 无效`)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) throw new AutomationControlValidationError(`${label} 无效`)
  return parsed.toISOString()
}
const optionalTimestamp = (value: unknown, label: string) => value === null ? null : timestamp(value, label)
const integer = (value: unknown, label: string, minimum: number, maximum: number) => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new AutomationControlValidationError(`${label} 无效`)
  return Number(value)
}
const operationId = (value: unknown) => {
  if (value === undefined || value === null || value === '') return `system:${randomUUID()}`
  if (typeof value !== 'string' || !OPERATION_ID.test(value)) throw new AutomationControlValidationError('operationId 无效')
  return value
}
const clientId = (value: unknown) => string(value, '客户端标识', MAX_CLIENT_ID_LENGTH)
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (!value || typeof value !== 'object') throw new AutomationControlValidationError('幂等输入无效')
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

const policy = (value: unknown): AutomationExecutionPolicy => {
  if (value === undefined || value === null) return { ...DEFAULT_POLICY }
  const input = object(value, '自动化预算')
  const permission = input.permission === undefined ? DEFAULT_POLICY.permission : input.permission
  const tokenBudget = input.tokenBudget === undefined ? DEFAULT_POLICY.tokenBudget : input.tokenBudget
  if (permission !== 'manual-current') throw new AutomationControlValidationError('P3A 只允许执行前确认')
  if (tokenBudget !== 'unsupported') throw new AutomationControlValidationError('当前版本不能强制 token 预算')
  return {
    permission: 'manual-current',
    maxPendingRuns: input.maxPendingRuns === undefined ? DEFAULT_POLICY.maxPendingRuns : integer(input.maxPendingRuns, '待处理上限', 1, 16),
    maxAttempts: input.maxAttempts === undefined ? DEFAULT_POLICY.maxAttempts : integer(input.maxAttempts, '最大尝试次数', 1, 8),
    retryDelayMinutes: input.retryDelayMinutes === undefined ? DEFAULT_POLICY.retryDelayMinutes : integer(input.retryDelayMinutes, '重试延迟', 1, 24 * 60),
    maxRunsPerDay: input.maxRunsPerDay === undefined ? DEFAULT_POLICY.maxRunsPerDay : integer(input.maxRunsPerDay, '每日运行上限', 1, 128),
    maxWallClockMinutes: input.maxWallClockMinutes === undefined ? DEFAULT_POLICY.maxWallClockMinutes : integer(input.maxWallClockMinutes, '运行时长上限', 1, 24 * 60),
    tokenBudget: 'unsupported',
  }
}

const normalizedDefinition = (value: unknown): AutomationDefinition => {
  const input = object(value, '自动化定义')
  const revision = integer(input.revision, '自动化版本', 1, Number.MAX_SAFE_INTEGER)
  const enabled = input.enabled === true || input.enabled === false ? input.enabled : (() => { throw new AutomationControlValidationError('自动化启用状态无效') })()
  const next = input.nextDueAt === null ? null : timestamp(input.nextDueAt, '下次触发时间')
  const migratedFromLegacy = input.migratedFromLegacy === undefined ? undefined : input.migratedFromLegacy === true ? true : (() => { throw new AutomationControlValidationError('自动化迁移状态无效') })()
  return {
    id: identifier(input.id, '自动化标识') as string,
    revision,
    name: string(input.name, '自动化名称', MAX_NAME_BYTES),
    instruction: string(input.instruction, '自动化指令', MAX_INSTRUCTION_BYTES),
    projectId: identifier(input.projectId, '项目标识', true),
    schedule: parseAutomationSchedule(input.schedule),
    enabled,
    nextDueAt: next,
    policy: policy(input.policy),
    createdAt: timestamp(input.createdAt, '自动化创建时间'),
    updatedAt: timestamp(input.updatedAt, '自动化更新时间'),
    ...(migratedFromLegacy ? { migratedFromLegacy } : {}),
  }
}

const runState = (value: unknown): AutomationRunState => {
  const allowed: AutomationRunState[] = ['queued', 'claimed', 'prepared', 'dispatch_unconfirmed', 'dispatched', 'retry_wait', 'succeeded', 'failed', 'blocked', 'budget_exhausted', 'cancelled']
  if (typeof value !== 'string' || !allowed.includes(value as AutomationRunState)) throw new AutomationControlValidationError('自动化运行状态无效')
  return value as AutomationRunState
}
const runTrigger = (value: unknown): AutomationRunTrigger => {
  if (value === 'manual' || value === 'schedule' || value === 'retry' || value === 'replay') return value
  throw new AutomationControlValidationError('自动化触发来源无效')
}
const auditKind = (value: unknown): AutomationRunAuditKind => {
  const allowed: AutomationRunAuditKind[] = ['queued', 'claim.acquired', 'claim.expired', 'task.bound', 'dispatch.prepared', 'dispatch.confirmed', 'settled.verified', 'settled.failed', 'settled.blocked', 'settled.cancelled', 'retry.queued', 'budget.blocked', 'released']
  if (typeof value !== 'string' || !allowed.includes(value as AutomationRunAuditKind)) throw new AutomationControlValidationError('自动化审计事件无效')
  return value as AutomationRunAuditKind
}
const normalizedAudit = (value: unknown): AutomationRunAudit => {
  const input = object(value, '自动化审计事件')
  const sequence = integer(input.sequence, '自动化审计序号', 1, MAX_AUDIT_EVENTS)
  const detail = input.detail === undefined ? undefined : string(input.detail, '自动化审计说明', 2 * 1024)
  return {
    id: identifier(input.id, '自动化审计标识') as string,
    sequence,
    at: timestamp(input.at, '自动化审计时间'),
    kind: auditKind(input.kind),
    ...(detail ? { detail } : {}),
  }
}
const normalizedClaim = (value: unknown): AutomationClaim | null => {
  if (value === null) return null
  const input = object(value, '自动化领取记录')
  return {
    id: identifier(input.id, '领取标识') as string,
    clientId: clientId(input.clientId),
    expiresAt: timestamp(input.expiresAt, '领取过期时间'),
  }
}
const normalizedRun = (value: unknown): AutomationRun => {
  const input = object(value, '自动化运行记录')
  const audit = Array.isArray(input.audit) ? input.audit.map(normalizedAudit) : (() => { throw new AutomationControlValidationError('自动化审计记录无效') })()
  if (!audit.length || audit.length > MAX_AUDIT_EVENTS || audit.some((entry, index) => entry.sequence !== index + 1)) throw new AutomationControlValidationError('自动化审计序号无效')
  const attempt = integer(input.attempt, '自动化尝试次数', 1, 8)
  return {
    id: identifier(input.id, '自动化运行标识') as string,
    automationId: identifier(input.automationId, '自动化标识') as string,
    occurrenceKey: string(input.occurrenceKey, '自动化运行幂等键', 1_024),
    trigger: runTrigger(input.trigger),
    state: runState(input.state),
    attempt,
    scheduledFor: optionalTimestamp(input.scheduledFor, '计划触发时间'),
    availableAt: optionalTimestamp(input.availableAt, '可用时间'),
    replayOf: input.replayOf === null ? null : identifier(input.replayOf, '重放来源') as string,
    retryOf: input.retryOf === null ? null : identifier(input.retryOf, '重试来源') as string,
    projectId: identifier(input.projectId, '项目标识', true),
    instruction: string(input.instruction, '自动化指令', MAX_INSTRUCTION_BYTES),
    policy: policy(input.policy),
    claim: normalizedClaim(input.claim),
    taskId: input.taskId === null ? null : identifier(input.taskId, '任务标识') as string,
    agentRunId: input.agentRunId === null ? null : identifier(input.agentRunId, 'Agent 回合标识') as string,
    taskCreatedEventId: input.taskCreatedEventId === null ? null : identifier(input.taskCreatedEventId, '任务创建收据') as string,
    runStartedEventId: input.runStartedEventId === null ? null : identifier(input.runStartedEventId, '回合启动收据') as string,
    deadlineAt: optionalTimestamp(input.deadlineAt, '运行预算截止时间'),
    createdAt: timestamp(input.createdAt, '自动化运行创建时间'),
    updatedAt: timestamp(input.updatedAt, '自动化运行更新时间'),
    audit,
  }
}
const normalizedOperation = (value: unknown): AutomationOperation => {
  const input = object(value, '自动化幂等操作')
  if (typeof input.id !== 'string' || !OPERATION_ID.test(input.id)) throw new AutomationControlValidationError('operationId 无效')
  if (typeof input.kind !== 'string' || !input.kind || input.kind.length > 128) throw new AutomationControlValidationError('幂等操作类型无效')
  if (typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint)) throw new AutomationControlValidationError('幂等操作指纹无效')
  if (input.targetKind !== 'automation' && input.targetKind !== 'run') throw new AutomationControlValidationError('幂等目标类型无效')
  return {
    id: input.id,
    kind: input.kind,
    fingerprint: input.fingerprint,
    targetKind: input.targetKind,
    targetId: identifier(input.targetId, '幂等目标标识') as string,
    recordedAt: timestamp(input.recordedAt, '幂等操作时间'),
  }
}
const emptyState = (): AutomationControlFile => ({ schema: AUTOMATION_CONTROL_SCHEMA, automations: [], runs: [], operations: [] })
const normalizedState = (value: unknown): AutomationControlFile => {
  const input = object(value, '自动化控制状态')
  if (input.schema !== AUTOMATION_CONTROL_SCHEMA || !Array.isArray(input.automations) || !Array.isArray(input.runs) || !Array.isArray(input.operations)) {
    throw new AutomationControlValidationError('自动化控制状态 schema 无效')
  }
  if (input.automations.length > MAX_AUTOMATIONS || input.runs.length > MAX_RUNS || input.operations.length > MAX_OPERATIONS) throw new AutomationControlValidationError('自动化控制状态超过限制')
  const automations = input.automations.map(normalizedDefinition)
  const runs = input.runs.map(normalizedRun)
  const operations = input.operations.map(normalizedOperation)
  if (new Set(automations.map((entry) => entry.id)).size !== automations.length) throw new AutomationControlValidationError('自动化标识重复')
  if (new Set(runs.map((entry) => entry.id)).size !== runs.length) throw new AutomationControlValidationError('自动化运行标识重复')
  if (new Set(runs.map((entry) => entry.occurrenceKey)).size !== runs.length) throw new AutomationControlValidationError('自动化运行幂等键重复')
  if (new Set(operations.map((entry) => entry.id)).size !== operations.length) throw new AutomationControlValidationError('幂等操作标识重复')
  if (runs.some((run) => !automations.some((automation) => automation.id === run.automationId))) throw new AutomationControlValidationError('自动化运行引用未知定义')
  if (operations.some((operation) => operation.targetKind === 'automation'
    ? !automations.some((automation) => automation.id === operation.targetId)
    : !runs.some((run) => run.id === operation.targetId))) throw new AutomationControlValidationError('幂等操作引用未知目标')
  return { schema: AUTOMATION_CONTROL_SCHEMA, automations, runs, operations }
}

const viewRun = (run: AutomationRun): AutomationRunView => {
  const { instruction: _instruction, ...view } = clone(run)
  return view
}
const findAutomation = (state: AutomationControlFile, automationId: unknown) => {
  const id = identifier(automationId, '自动化标识') as string
  const automation = state.automations.find((entry) => entry.id === id)
  if (!automation) throw new AutomationControlConflictError('自动化不存在')
  return automation
}
const findRun = (state: AutomationControlFile, runId: unknown) => {
  const id = identifier(runId, '自动化运行标识') as string
  const run = state.runs.find((entry) => entry.id === id)
  if (!run) throw new AutomationControlConflictError('自动化运行不存在')
  return run
}
const isPending = (run: AutomationRun) => ['queued', 'claimed', 'prepared', 'dispatch_unconfirmed', 'dispatched', 'retry_wait'].includes(run.state)
const isTerminal = (run: AutomationRun) => ['succeeded', 'failed', 'blocked', 'budget_exhausted', 'cancelled'].includes(run.state)
const localDay = (iso: string) => {
  const date = new Date(iso)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
const sameLocalDay = (left: string, right: string) => localDay(left) === localDay(right)
const appendAudit = (run: AutomationRun, kind: AutomationRunAuditKind, at: string, detail?: string) => {
  if (run.audit.length >= MAX_AUDIT_EVENTS) {
    run.audit.splice(0, run.audit.length - MAX_AUDIT_EVENTS + 1)
    run.audit.forEach((event, index) => { event.sequence = index + 1 })
  }
  const sequence = run.audit.length ? run.audit[run.audit.length - 1].sequence + 1 : 1
  run.audit.push({
    id: `aut_evt_${hash(`${run.id}\u0000${sequence}\u0000${kind}`).slice(0, 32)}`,
    sequence,
    at,
    kind,
    ...(detail ? { detail: detail.slice(0, 2_024) } : {}),
  })
}
const dueString = (schedule: AutomationSchedule, now: Date) => {
  const due = nextDueAt(schedule, now)
  return due ? due.toISOString() : null
}

type CreateAutomationInput = {
  operationId?: unknown
  name?: unknown
  instruction?: unknown
  projectId?: unknown
  schedule?: unknown
  policy?: unknown
}

type UpdateAutomationInput = CreateAutomationInput & { enabled?: unknown }

const creationInput = (input: unknown) => {
  const body = object(input, '自动化请求') as CreateAutomationInput
  const schedule = body.schedule === undefined ? parseAutomationSchedule({ kind: 'manual' }) : parseAutomationSchedule(body.schedule)
  return {
    operationId: operationId(body.operationId),
    name: string(body.name, '名称', MAX_NAME_BYTES),
    instruction: string(body.instruction, '指令', MAX_INSTRUCTION_BYTES),
    projectId: identifier(body.projectId ?? null, '项目标识', true),
    schedule,
    policy: policy(body.policy),
  }
}

const operationTarget = (state: AutomationControlFile, operation: AutomationOperation) => operation.targetKind === 'automation'
  ? findAutomation(state, operation.targetId)
  : findRun(state, operation.targetId)

const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new AutomationControlValidationError('请求内容超过 256KB')
    chunks.push(buffer)
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, '请求内容') } catch (error) {
    if (error instanceof AutomationControlValidationError) throw error
    throw new AutomationControlValidationError('请求内容必须是 JSON 对象')
  }
}
const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}

export type AutomationControlPlane = ReturnType<typeof createAutomationControlPlane>

export function createAutomationControlPlane(options: {
  storageDir: string
  legacyStatePath?: string
  projectExists: (projectId: string) => Promise<boolean>
  taskEventLedger?: TaskEventLedger
  now?: () => Date
  idFactory?: () => string
  claimLeaseMs?: number
  schedulerTickMs?: number
}) {
  const storageDir = path.resolve(options.storageDir)
  const statePath = path.join(storageDir, 'automation-control.json')
  const legacyStatePath = options.legacyStatePath ? path.resolve(options.legacyStatePath) : null
  const now = options.now ?? (() => new Date())
  const idFactory = options.idFactory ?? randomUUID
  const claimLeaseMs = options.claimLeaseMs ?? 10 * 60 * 1_000
  const schedulerTickMs = options.schedulerTickMs ?? 30_000
  let mutationQueue: Promise<void> = Promise.resolve()
  let scheduler: NodeJS.Timeout | null = null
  let acceptingMutations = true

  const nowIso = () => now().toISOString()
  const serialize = <T>(action: () => Promise<T>) => {
    const result = mutationQueue.then(action, action)
    mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }
  const assertAccepting = () => {
    if (!acceptingMutations) throw new AutomationControlConflictError('自动化控制面正在停止')
  }
  const ensureStorage = async () => {
    await mkdir(storageDir, { recursive: true, mode: 0o700 })
    const metadata = await lstat(storageDir)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new AutomationControlValidationError('自动化存储目录不安全')
    try { await chmod(storageDir, 0o700) } catch { /* Non-POSIX filesystems still receive type checks. */ }
  }
  const legacyDefinitions = async (at: string): Promise<AutomationDefinition[]> => {
    if (!legacyStatePath) return []
    try {
      const metadata = await lstat(legacyStatePath)
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_STATE_BYTES) throw new AutomationControlValidationError('旧自动化状态文件不安全')
      const input = JSON.parse(await readFile(legacyStatePath, 'utf8')) as unknown
      if (!Array.isArray(input)) return []
      const existingIds = new Set<string>()
      return input.flatMap((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
        const legacy = entry as Record<string, unknown>
        try {
          const baseId = typeof legacy.id === 'string' && legacy.id.trim() && !legacy.id.includes('/') && !legacy.id.includes('\\')
            ? legacy.id.trim().slice(0, MAX_IDENTIFIER_LENGTH)
            : `legacy_${hash(`${index}\u0000${String(legacy.name ?? '')}`).slice(0, 24)}`
          const id = existingIds.has(baseId) ? `${baseId}_${index}` : baseId
          existingIds.add(id)
          return [{
            id,
            revision: 1,
            name: string(legacy.name, '旧自动化名称', MAX_NAME_BYTES),
            instruction: string(legacy.instruction, '旧自动化指令', MAX_INSTRUCTION_BYTES),
            projectId: null,
            schedule: parseAutomationSchedule({ kind: 'manual' }),
            enabled: true,
            nextDueAt: null,
            policy: { ...DEFAULT_POLICY },
            createdAt: typeof legacy.createdAt === 'string' && !Number.isNaN(new Date(legacy.createdAt).valueOf()) ? new Date(legacy.createdAt).toISOString() : at,
            updatedAt: typeof legacy.updatedAt === 'string' && !Number.isNaN(new Date(legacy.updatedAt).valueOf()) ? new Date(legacy.updatedAt).toISOString() : at,
            migratedFromLegacy: true as const,
          }]
        } catch { return [] }
      }).slice(0, MAX_AUTOMATIONS)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return []
      throw error
    }
  }
  const persist = async (state: AutomationControlFile) => {
    const normalized = normalizedState(state)
    await ensureStorage()
    const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      try { await chmod(temporaryPath, 0o600) } catch { /* restrictive creation mode remains the fallback */ }
      await rename(temporaryPath, statePath)
      try { await chmod(statePath, 0o600) } catch { /* best-effort on non-POSIX filesystems */ }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }
  const readState = async (): Promise<AutomationControlFile> => {
    await ensureStorage()
    try {
      const metadata = await lstat(statePath)
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_STATE_BYTES || (metadata.mode & 0o077) !== 0) {
        throw new AutomationControlValidationError('自动化控制状态文件不安全')
      }
      return normalizedState(JSON.parse(await readFile(statePath, 'utf8')) as unknown)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      const initial = emptyState()
      initial.automations = await legacyDefinitions(nowIso())
      await persist(initial)
      return initial
    }
  }
  const mutate = async <T extends AutomationDefinition | AutomationRun>(
    operation: { id: string; kind: string; fingerprintInput: unknown; targetKind: 'automation' | 'run' },
    action: (state: AutomationControlFile, at: string) => T,
  ): Promise<T> => serialize(async () => {
    assertAccepting()
    const state = await readState()
    const fingerprint = hash(canonicalJson(operation.fingerprintInput))
    const previous = state.operations.find((entry) => entry.id === operation.id)
    if (previous) {
      if (previous.kind !== operation.kind || previous.fingerprint !== fingerprint || previous.targetKind !== operation.targetKind) {
        throw new AutomationControlConflictError('operationId 已用于不同更新')
      }
      return clone(operationTarget(state, previous) as T)
    }
    const result = action(state, nowIso())
    state.operations.push({
      id: operation.id,
      kind: operation.kind,
      fingerprint,
      targetKind: operation.targetKind,
      targetId: result.id,
      recordedAt: nowIso(),
    })
    if (state.operations.length > MAX_OPERATIONS) state.operations.splice(0, state.operations.length - MAX_OPERATIONS)
    await persist(state)
    return clone(result)
  })
  const assertProject = async (projectId: string | null) => {
    if (projectId && !(await options.projectExists(projectId))) throw new AutomationControlConflictError('自动化所属项目不存在')
  }
  const countDailyRuns = (state: AutomationControlFile, automationId: string, at: string) => state.runs.filter((run) => run.automationId === automationId && sameLocalDay(run.createdAt, at)).length
  const pendingRuns = (state: AutomationControlFile, automationId: string) => state.runs.filter((run) => run.automationId === automationId && isPending(run))
  const makeRun = (input: {
    automation: AutomationDefinition
    at: string
    trigger: AutomationRunTrigger
    occurrenceKey: string
    scheduledFor?: string | null
    availableAt?: string | null
    replayOf?: string | null
    retryOf?: string | null
    attempt?: number
    state?: AutomationRunState
  }) => {
    const state = input.state ?? 'queued'
    const run: AutomationRun = {
      id: `aut_run_${identifier(idFactory(), '自动化运行随机标识')}`,
      automationId: input.automation.id,
      occurrenceKey: input.occurrenceKey,
      trigger: input.trigger,
      state,
      attempt: input.attempt ?? 1,
      scheduledFor: input.scheduledFor ?? null,
      availableAt: input.availableAt ?? null,
      replayOf: input.replayOf ?? null,
      retryOf: input.retryOf ?? null,
      projectId: input.automation.projectId,
      instruction: input.automation.instruction,
      policy: clone(input.automation.policy),
      claim: null,
      taskId: null,
      agentRunId: null,
      taskCreatedEventId: null,
      runStartedEventId: null,
      deadlineAt: null,
      createdAt: input.at,
      updatedAt: input.at,
      audit: [],
    }
    appendAudit(run, state === 'budget_exhausted' ? 'budget.blocked' : 'queued', input.at)
    return run
  }
  const createAutomation = async (input: unknown) => {
    const parsed = creationInput(input)
    await assertProject(parsed.projectId)
    const definitionId = `aut_${identifier(idFactory(), '自动化随机标识')}`
    return mutate({
      id: parsed.operationId,
      kind: 'automation.create',
      targetKind: 'automation',
      fingerprintInput: { name: parsed.name, instruction: parsed.instruction, projectId: parsed.projectId, schedule: parsed.schedule, policy: parsed.policy },
    }, (state, at) => {
      if (state.automations.length >= MAX_AUTOMATIONS) throw new AutomationControlConflictError('自动化数量超过限制')
      if (state.automations.some((automation) => automation.id === definitionId)) throw new AutomationControlConflictError('自动化标识冲突')
      const automation: AutomationDefinition = {
        id: definitionId,
        revision: 1,
        name: parsed.name,
        instruction: parsed.instruction,
        projectId: parsed.projectId,
        schedule: parsed.schedule,
        enabled: true,
        nextDueAt: dueString(parsed.schedule, new Date(at)),
        policy: parsed.policy,
        createdAt: at,
        updatedAt: at,
      }
      state.automations.push(automation)
      return automation
    })
  }
  const updateAutomation = async (automationId: string, input: unknown) => {
    const body = object(input, '自动化更新') as UpdateAutomationInput
    const parsedOperationId = operationId(body.operationId)
    const projectId = body.projectId === undefined ? undefined : identifier(body.projectId, '项目标识', true)
    if (projectId !== undefined) await assertProject(projectId)
    const changedSchedule = body.schedule === undefined ? undefined : parseAutomationSchedule(body.schedule)
    const changedPolicy = body.policy === undefined ? undefined : policy(body.policy)
    const changedEnabled = body.enabled === undefined ? undefined : body.enabled === true || body.enabled === false ? body.enabled : (() => { throw new AutomationControlValidationError('自动化启用状态无效') })()
    const changedName = body.name === undefined ? undefined : string(body.name, '名称', MAX_NAME_BYTES)
    const changedInstruction = body.instruction === undefined ? undefined : string(body.instruction, '指令', MAX_INSTRUCTION_BYTES)
    return mutate({
      id: parsedOperationId,
      kind: 'automation.update',
      targetKind: 'automation',
      fingerprintInput: { automationId, name: changedName, instruction: changedInstruction, projectId, schedule: changedSchedule, policy: changedPolicy, enabled: changedEnabled },
    }, (state, at) => {
      const automation = findAutomation(state, automationId)
      const schedule = changedSchedule ?? automation.schedule
      const enabled = changedEnabled ?? automation.enabled
      automation.name = changedName ?? automation.name
      automation.instruction = changedInstruction ?? automation.instruction
      automation.projectId = projectId === undefined ? automation.projectId : projectId
      automation.schedule = schedule
      automation.policy = changedPolicy ?? automation.policy
      automation.enabled = enabled
      automation.nextDueAt = !enabled
        ? null
        : changedSchedule !== undefined || changedEnabled === true
          ? dueString(schedule, new Date(at))
          : automation.nextDueAt
      automation.revision += 1
      automation.updatedAt = at
      return automation
    })
  }
  const enqueue = async (automationId: string, input: unknown = {}) => {
    const body = object(input, '自动化入队请求')
    const op = operationId(body.operationId)
    return mutate({
      id: op,
      kind: 'run.enqueue',
      targetKind: 'run',
      fingerprintInput: { automationId, source: 'manual' },
    }, (state, at) => {
      const automation = findAutomation(state, automationId)
      if (!automation.enabled) throw new AutomationControlConflictError('自动化已暂停，不能入队')
      if (pendingRuns(state, automation.id).length >= automation.policy.maxPendingRuns) throw new AutomationControlConflictError('已有待处理运行，请先处理或取消')
      if (countDailyRuns(state, automation.id, at) >= automation.policy.maxRunsPerDay) {
        const blocked = makeRun({ automation, at, trigger: 'manual', occurrenceKey: `manual:${automation.id}:${op}`, state: 'budget_exhausted' })
        state.runs.push(blocked)
        return blocked
      }
      if (state.runs.length >= MAX_RUNS) throw new AutomationControlConflictError('自动化运行历史超过限制')
      const run = makeRun({ automation, at, trigger: 'manual', occurrenceKey: `manual:${automation.id}:${op}` })
      state.runs.push(run)
      return run
    })
  }
  const replay = async (runId: string, input: unknown = {}) => {
    const body = object(input, '自动化重放请求')
    const op = operationId(body.operationId)
    return mutate({
      id: op,
      kind: 'run.replay',
      targetKind: 'run',
      fingerprintInput: { runId, source: 'replay' },
    }, (state, at) => {
      const source = findRun(state, runId)
      const automation = findAutomation(state, source.automationId)
      if (!automation.enabled) throw new AutomationControlConflictError('自动化已暂停，不能重放')
      if (pendingRuns(state, automation.id).length >= automation.policy.maxPendingRuns) throw new AutomationControlConflictError('已有待处理运行，请先处理或取消')
      const run = makeRun({
        automation,
        at,
        trigger: 'replay',
        occurrenceKey: `replay:${source.id}:${op}`,
        replayOf: source.id,
      })
      state.runs.push(run)
      return run
    })
  }
  const claim = async (runId: string, input: unknown) => {
    const body = object(input, '自动化领取请求')
    const op = operationId(body.operationId)
    const owner = clientId(body.clientId)
    const before = await serialize(async () => {
      const state = await readState()
      const run = findRun(state, runId)
      return clone(run)
    })
    await assertProject(before.projectId)
    const run = await mutate({
      id: op,
      kind: 'run.claim',
      targetKind: 'run',
      fingerprintInput: { runId, clientId: owner },
    }, (state, at) => {
      const current = findRun(state, runId)
      if (current.state !== 'queued') throw new AutomationControlConflictError('自动化运行当前不能领取')
      current.state = 'claimed'
      current.claim = {
        id: `claim_${identifier(idFactory(), '领取随机标识')}`,
        clientId: owner,
        expiresAt: new Date(new Date(at).getTime() + claimLeaseMs).toISOString(),
      }
      current.updatedAt = at
      appendAudit(current, 'claim.acquired', at)
      return current
    })
    return {
      run: viewRun(run),
      launch: {
        projectId: run.projectId,
        instruction: run.instruction,
        claimId: run.claim?.id ?? '',
        permission: 'manual-current' as const,
      },
    }
  }
  const assertClaim = (run: AutomationRun, owner: string, claimId: unknown, at: string) => {
    const requestedClaimId = identifier(claimId, '领取标识') as string
    if (!run.claim || run.claim.clientId !== owner || run.claim.id !== requestedClaimId) throw new AutomationControlConflictError('自动化运行不属于当前窗口')
    if (new Date(run.claim.expiresAt).getTime() <= new Date(at).getTime()) throw new AutomationControlConflictError('自动化领取已过期，请重新领取')
  }
  const lookupEvent = async (taskId: string, eventId: string) => {
    if (!options.taskEventLedger) throw new AutomationControlConflictError('任务账本不可用，无法交接自动化')
    const event = await options.taskEventLedger.findByEventId({ taskId, eventId })
    if (!event) throw new AutomationControlConflictError('找不到真实任务账本收据')
    return event
  }
  const bindTask = async (runId: string, input: unknown) => {
    const body = object(input, '自动化任务绑定请求')
    const op = operationId(body.operationId)
    const owner = clientId(body.clientId)
    const taskId = identifier(body.taskId, '任务标识') as string
    const taskCreatedEventId = identifier(body.taskCreatedEventId, '任务创建收据') as string
    const receipt = await lookupEvent(taskId, taskCreatedEventId)
    if (receipt.type !== 'task.created') throw new AutomationControlConflictError('自动化只能绑定真实 task.created 收据')
    const run = await mutate({
      id: op,
      kind: 'run.bind-task',
      targetKind: 'run',
      fingerprintInput: { runId, clientId: owner, taskId, taskCreatedEventId },
    }, (state, at) => {
      const current = findRun(state, runId)
      assertClaim(current, owner, body.claimId, at)
      if (current.state !== 'claimed') throw new AutomationControlConflictError('自动化运行尚未等待任务绑定')
      if (receipt.projectId !== current.projectId) throw new AutomationControlConflictError('任务项目范围与自动化不一致')
      current.state = 'prepared'
      current.taskId = taskId
      current.taskCreatedEventId = taskCreatedEventId
      current.updatedAt = at
      appendAudit(current, 'task.bound', at)
      return current
    })
    return viewRun(run)
  }
  const prepareDispatch = async (runId: string, input: unknown) => {
    const body = object(input, '自动化派发准备请求')
    const op = operationId(body.operationId)
    const owner = clientId(body.clientId)
    const taskId = identifier(body.taskId, '任务标识') as string
    const agentRunId = identifier(body.agentRunId, 'Agent 回合标识') as string
    const runStartedEventId = identifier(body.runStartedEventId, '回合启动收据') as string
    const receipt = await lookupEvent(taskId, runStartedEventId)
    if (receipt.type !== 'run.started' || receipt.runId !== agentRunId || receipt.payload.automationRunId !== runId) {
      throw new AutomationControlConflictError('自动化只能绑定带 automationRunId 的真实 run.started 收据')
    }
    const run = await mutate({
      id: op,
      kind: 'run.prepare-dispatch',
      targetKind: 'run',
      fingerprintInput: { runId, clientId: owner, taskId, agentRunId, runStartedEventId },
    }, (state, at) => {
      const current = findRun(state, runId)
      assertClaim(current, owner, body.claimId, at)
      if (current.state !== 'prepared' || current.taskId !== taskId) throw new AutomationControlConflictError('自动化运行尚未完成任务准备')
      current.state = 'dispatch_unconfirmed'
      current.agentRunId = agentRunId
      current.runStartedEventId = runStartedEventId
      current.deadlineAt = new Date(new Date(at).getTime() + current.policy.maxWallClockMinutes * 60_000).toISOString()
      current.updatedAt = at
      appendAudit(current, 'dispatch.prepared', at)
      return current
    })
    return viewRun(run)
  }
  const confirmDispatch = async (runId: string, input: unknown) => {
    const body = object(input, '自动化派发确认请求')
    const op = operationId(body.operationId)
    const owner = clientId(body.clientId)
    const taskId = identifier(body.taskId, '任务标识') as string
    const agentRunId = identifier(body.agentRunId, 'Agent 回合标识') as string
    const run = await mutate({
      id: op,
      kind: 'run.confirm-dispatch',
      targetKind: 'run',
      fingerprintInput: { runId, clientId: owner, taskId, agentRunId },
    }, (state, at) => {
      const current = findRun(state, runId)
      assertClaim(current, owner, body.claimId, at)
      if (current.state !== 'dispatch_unconfirmed' || current.taskId !== taskId || current.agentRunId !== agentRunId) {
        throw new AutomationControlConflictError('自动化运行没有待确认的派发')
      }
      current.state = 'dispatched'
      current.updatedAt = at
      appendAudit(current, 'dispatch.confirmed', at)
      return current
    })
    return viewRun(run)
  }
  const release = async (runId: string, input: unknown) => {
    const body = object(input, '自动化释放请求')
    const op = operationId(body.operationId)
    const owner = clientId(body.clientId)
    const run = await mutate({
      id: op,
      kind: 'run.release',
      targetKind: 'run',
      fingerprintInput: { runId, clientId: owner },
    }, (state, at) => {
      const current = findRun(state, runId)
      assertClaim(current, owner, body.claimId, at)
      if (current.state !== 'claimed') throw new AutomationControlConflictError('已创建任务的自动化不能释放，请取消或在该任务中继续')
      current.state = 'queued'
      current.claim = null
      current.updatedAt = at
      appendAudit(current, 'released', at)
      return current
    })
    return viewRun(run)
  }
  const cancel = async (runId: string, input: unknown = {}) => {
    const body = object(input, '自动化取消请求')
    const op = operationId(body.operationId)
    const run = await mutate({
      id: op,
      kind: 'run.cancel',
      targetKind: 'run',
      fingerprintInput: { runId },
    }, (state, at) => {
      const current = findRun(state, runId)
      if (!['queued', 'claimed', 'prepared', 'dispatch_unconfirmed', 'retry_wait'].includes(current.state)) {
        throw new AutomationControlConflictError('已派发的自动化必须在真实任务中停止')
      }
      current.state = 'cancelled'
      current.claim = null
      current.updatedAt = at
      appendAudit(current, 'settled.cancelled', at)
      return current
    })
    return viewRun(run)
  }
  const readTaskEvents = async (taskId: string) => {
    if (!options.taskEventLedger) throw new AutomationControlConflictError('任务账本不可用，无法核对自动化结果')
    const events = [] as Awaited<ReturnType<TaskEventLedger['read']>>['events']
    let afterSequence = 0
    for (let pages = 0; pages < 128; pages += 1) {
      const page = await options.taskEventLedger.read({ taskId, afterSequence, limit: 1_000 })
      events.push(...page.events)
      if (!page.events.length || page.events.length < 1_000) break
      afterSequence = page.events[page.events.length - 1].sequence
    }
    return events
  }
  const reconcile = async (runId: string, input: unknown = {}) => {
    const body = object(input, '自动化核对请求')
    const op = operationId(body.operationId)
    const snapshot = await serialize(async () => {
      const state = await readState()
      return clone(findRun(state, runId))
    })
    if (!snapshot.taskId || !snapshot.agentRunId) return viewRun(snapshot)
    const events = await readTaskEvents(snapshot.taskId)
    const started = events.find((event) => event.type === 'run.started'
      && event.runId === snapshot.agentRunId
      && event.payload.automationRunId === snapshot.id)
    if (!started) return viewRun(snapshot)
    const terminal = [...events].reverse().find((event) => (
      event.runId === snapshot.agentRunId
      && (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled')
    ))
    if (!terminal) return viewRun(snapshot)
    const verified = events.some((event) => event.type === 'verification.recorded'
      && event.runId === snapshot.agentRunId
      && event.payload.status === 'verified')
    return mutate({
      id: op,
      kind: 'run.reconcile',
      targetKind: 'run',
      fingerprintInput: { runId, taskId: snapshot.taskId, agentRunId: snapshot.agentRunId, terminalEventId: terminal.eventId, verified },
    }, (state, at) => {
      const current = findRun(state, runId)
      if (isTerminal(current)) return current
      const currentTerminal = terminal.type
      if (currentTerminal === 'run.completed' && verified) {
        current.state = 'succeeded'
        current.claim = null
        current.updatedAt = at
        appendAudit(current, 'settled.verified', at)
        return current
      }
      if (currentTerminal === 'run.completed') {
        current.state = 'blocked'
        current.claim = null
        current.updatedAt = at
        appendAudit(current, 'settled.blocked', at, '任务已完成，但未发现独立验证收据')
        return current
      }
      if (currentTerminal === 'run.cancelled') {
        current.state = 'cancelled'
        current.claim = null
        current.updatedAt = at
        appendAudit(current, 'settled.cancelled', at)
        return current
      }
      current.state = 'failed'
      current.claim = null
      current.updatedAt = at
      appendAudit(current, 'settled.failed', at)
      const automation = findAutomation(state, current.automationId)
      if (current.attempt < current.policy.maxAttempts && countDailyRuns(state, automation.id, at) < current.policy.maxRunsPerDay) {
        const retry = makeRun({
          automation,
          at,
          trigger: 'retry',
          occurrenceKey: `retry:${current.id}:${current.attempt + 1}`,
          retryOf: current.id,
          attempt: current.attempt + 1,
          availableAt: new Date(new Date(at).getTime() + current.policy.retryDelayMinutes * 60_000).toISOString(),
          state: 'retry_wait',
        })
        appendAudit(retry, 'retry.queued', at)
        state.runs.push(retry)
      }
      return current
    }).then(viewRun)
  }
  const tick = async () => serialize(async () => {
    if (!acceptingMutations) return { changed: false, queued: 0 }
    const state = await readState()
    const at = nowIso()
    const instant = new Date(at)
    let changed = false
    let queued = 0
    for (const run of state.runs) {
      if ((run.state === 'claimed' || run.state === 'prepared') && run.claim && new Date(run.claim.expiresAt).getTime() <= instant.getTime()) {
        const hadPreparedTask = run.state === 'prepared'
        run.state = 'queued'
        run.claim = null
        if (hadPreparedTask) {
          // No run.started receipt exists for a prepared handoff.  The old
          // empty ACP task remains harmless, while the durable automation may
          // be safely reviewed in a fresh task after an app/window crash.
          run.taskId = null
          run.taskCreatedEventId = null
        }
        run.updatedAt = at
        appendAudit(run, 'claim.expired', at)
        changed = true
      }
      if (run.state === 'retry_wait' && run.availableAt && new Date(run.availableAt).getTime() <= instant.getTime()) {
        run.state = 'queued'
        run.availableAt = null
        run.updatedAt = at
        appendAudit(run, 'queued', at)
        changed = true
      }
      if (run.state === 'dispatched' && run.deadlineAt && new Date(run.deadlineAt).getTime() <= instant.getTime()) {
        run.state = 'blocked'
        run.claim = null
        run.updatedAt = at
        appendAudit(run, 'budget.blocked', at, '达到本地运行时长预算；未自动中断真实 Agent 任务')
        changed = true
      }
    }
    for (const automation of state.automations) {
      if (!automation.enabled || automation.schedule.kind === 'manual' || !automation.nextDueAt) continue
      const due = new Date(automation.nextDueAt)
      if (Number.isNaN(due.getTime()) || due.getTime() > instant.getTime()) continue
      const occurrenceKey = `schedule:${automation.id}:${automation.nextDueAt}`
      const existing = state.runs.some((run) => run.occurrenceKey === occurrenceKey)
      const isBudgeted = countDailyRuns(state, automation.id, at) >= automation.policy.maxRunsPerDay
      const isBacklogged = pendingRuns(state, automation.id).length >= automation.policy.maxPendingRuns
      if (!existing && state.runs.length < MAX_RUNS) {
        const run = makeRun({
          automation,
          at,
          trigger: 'schedule',
          occurrenceKey,
          scheduledFor: automation.nextDueAt,
          state: isBudgeted || isBacklogged ? 'budget_exhausted' : 'queued',
        })
        if (isBacklogged) appendAudit(run, 'budget.blocked', at, '已有待处理运行，已合并本次遗漏触发')
        state.runs.push(run)
        queued += isBudgeted || isBacklogged ? 0 : 1
        changed = true
      }
      // Coalesce missed intervals/daily runs to one durable receipt.  Starting
      // from the current clock prevents a restart from replaying a backlog.
      automation.nextDueAt = dueString(automation.schedule, instant)
      automation.updatedAt = at
      changed = true
    }
    if (changed) await persist(state)
    return { changed, queued }
  })
  const listAutomations = async () => serialize(async () => (await readState()).automations.map(clone).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)))
  const listRuns = async (filters: { automationId?: string; taskId?: string; limit?: number } = {}) => serialize(async () => {
    const limit = filters.limit === undefined ? 100 : integer(filters.limit, '运行列表限制', 1, 500)
    const state = await readState()
    if (filters.automationId) findAutomation(state, filters.automationId)
    return state.runs
      .filter((run) => !filters.automationId || run.automationId === filters.automationId)
      .filter((run) => !filters.taskId || run.taskId === filters.taskId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(viewRun)
  })
  const start = async () => {
    acceptingMutations = true
    await tick()
    if (scheduler) return
    scheduler = setInterval(() => { void tick().catch(() => undefined) }, schedulerTickMs)
    scheduler.unref()
  }
  const stop = async () => {
    acceptingMutations = false
    if (scheduler) clearInterval(scheduler)
    scheduler = null
    await mutationQueue
  }
  const middleware = async (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname
    const method = request.method ?? 'GET'
    const respond = async (action: () => Promise<unknown>, status = 200) => {
      try { sendJson(response, status, await action()) } catch (error) {
        const message = error instanceof Error ? error.message : '自动化控制失败'
        const code = error instanceof AutomationControlValidationError ? 400 : error instanceof AutomationControlConflictError ? 409 : 500
        sendJson(response, code, { error: message })
      }
    }
    if (pathname === '/api/automations' && method === 'GET') {
      await respond(async () => ({ automations: await listAutomations() }))
      return
    }
    if (pathname === '/api/automations' && method === 'POST') {
      await respond(async () => ({ automation: await createAutomation(await readBody(request)) }), 201)
      return
    }
    const automationAction = pathname.match(/^\/api\/automations\/([^/]+)\/(enqueue|pause|resume)$/)
    if (automationAction && method === 'POST') {
      const [, automationId, action] = automationAction
      if (action === 'enqueue') {
        await respond(async () => ({ run: viewRun(await enqueue(automationId, await readBody(request))) }), 201)
      } else {
        await respond(async () => ({ automation: await updateAutomation(automationId, { ...(await readBody(request)), enabled: action === 'resume' }) }))
      }
      return
    }
    const automationMatch = pathname.match(/^\/api\/automations\/([^/]+)$/)
    if (automationMatch && method === 'PATCH') {
      await respond(async () => ({ automation: await updateAutomation(automationMatch[1], await readBody(request)) }))
      return
    }
    if (pathname === '/api/automation-runs' && method === 'GET') {
      await respond(async () => ({ runs: await listRuns({
        automationId: url.searchParams.get('automationId') || undefined,
        taskId: url.searchParams.get('taskId') || undefined,
        limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
      }) }))
      return
    }
    const runAction = pathname.match(/^\/api\/automation-runs\/([^/]+)\/(claim|bind-task|prepare-dispatch|confirm-dispatch|release|cancel|reconcile|replay)$/)
    if (runAction && method === 'POST') {
      const [, runId, action] = runAction
      if (action === 'claim') await respond(async () => await claim(runId, await readBody(request)))
      else if (action === 'bind-task') await respond(async () => ({ run: await bindTask(runId, await readBody(request)) }))
      else if (action === 'prepare-dispatch') await respond(async () => ({ run: await prepareDispatch(runId, await readBody(request)) }))
      else if (action === 'confirm-dispatch') await respond(async () => ({ run: await confirmDispatch(runId, await readBody(request)) }))
      else if (action === 'release') await respond(async () => ({ run: await release(runId, await readBody(request)) }))
      else if (action === 'cancel') await respond(async () => ({ run: await cancel(runId, await readBody(request)) }))
      else if (action === 'reconcile') await respond(async () => ({ run: await reconcile(runId, await readBody(request)) }))
      else await respond(async () => ({ run: viewRun(await replay(runId, await readBody(request))) }), 201)
      return
    }
    next()
  }

  return {
    storageDir,
    statePath,
    listAutomations,
    listRuns,
    createAutomation,
    updateAutomation,
    enqueue,
    replay,
    claim,
    bindTask,
    prepareDispatch,
    confirmDispatch,
    release,
    cancel,
    reconcile,
    tick,
    start,
    stop,
    middleware,
  }
}

export const automationControlPlaneMiddleware = (controlPlane: AutomationControlPlane) => controlPlane.middleware
