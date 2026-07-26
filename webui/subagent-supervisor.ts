import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename } from 'node:fs/promises'
import path from 'node:path'

import type { GoalExecutionScope } from './goal-execution-orchestrator.ts'

/**
 * Durable, transport-neutral child-agent supervision.
 *
 * The supervisor deliberately does not invoke an ACP client, shell command,
 * or model provider.  It derives a child scope from its parent boundary,
 * records recovery/cancellation intent, and returns safe resume instructions
 * for an outer effect adapter to handle.
 */
export const SUBAGENT_SUPERVISOR_SCHEMA = 'runbuild.subagent-supervisor.v1' as const

export type SubagentExecutionMode = 'synchronous' | 'asynchronous'
export type SubagentState = 'running' | 'awaiting_parent_verification' | 'reconnecting' | 'cancelling' | 'cancelled' | 'failed'
export type SubagentRecoveryState = 'active' | 'interrupted' | 'cancel_requested'

export type SubagentEventKind =
  | 'subagent.started'
  | 'subagent.reported'
  | 'subagent.disconnected'
  | 'subagent.recovery.planned'
  | 'subagent.cancel.requested'
  | 'subagent.cancel.acknowledged'
  | 'subagent.failed'

export type SubagentEvent = {
  id: string
  sequence: number
  at: string
  kind: SubagentEventKind
}

export type SubagentRun = {
  version: 1
  id: string
  parentRunId: string
  /** The immutable authority boundary owned by the parent task/run. */
  parentScope: GoalExecutionScope
  /** Same task/project/principal as parent; grants may only be narrowed. */
  scope: GoalExecutionScope
  executionMode: SubagentExecutionMode
  state: SubagentState
  recovery: {
    state: SubagentRecoveryState
    attempts: number
    lastDisconnectedAt?: string
    /** The non-terminal state to restore after a transport-only reconnect. */
    resumeState?: 'running' | 'awaiting_parent_verification'
  }
  events: SubagentEvent[]
  createdAt: string
  updatedAt: string
}

export type SubagentProjection = {
  subagentRunId: string
  parentRunId: string
  executionMode: SubagentExecutionMode
  state: SubagentState
  recovery: SubagentRecoveryState
  activity: Array<{
    id: string
    sequence: number
    at: string
    tone: 'info' | 'success' | 'warning' | 'error'
    text: string
  }>
}

export type SubagentParentBoundary = {
  parentRunId: string
  parentScope: GoalExecutionScope
}

export type StartSubagentInput = SubagentParentBoundary & {
  operationId: string
  requestedGrantIds?: readonly string[]
  executionMode?: SubagentExecutionMode
}

export type SubagentUpdateInput = SubagentParentBoundary & {
  operationId: string
  subagentRunId: string
}

export type SubagentRecoveryAction = {
  kind: 'resume_subagent' | 'resume_then_cancel_subagent'
  subagentRunId: string
  parentRunId: string
  executionMode: SubagentExecutionMode
}

export class SubagentSupervisorValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubagentSupervisorValidationError'
  }
}

export class SubagentSupervisorConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubagentSupervisorConflictError'
  }
}

export class SubagentParentBoundaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubagentParentBoundaryError'
  }
}

type StoredOperation = {
  id: string
  kind: string
  fingerprint: string
  subagentRunId: string
  recordedAt: string
}

type SupervisorFile = {
  schema: typeof SUBAGENT_SUPERVISOR_SCHEMA
  runs: SubagentRun[]
  operations: StoredOperation[]
}

export type SubagentSupervisor = ReturnType<typeof createSubagentSupervisor>

const MAX_IDENTIFIER_LENGTH = 256
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
    if (!Number.isFinite(value)) throw new SubagentSupervisorValidationError('幂等操作内容无效')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  throw new SubagentSupervisorValidationError('幂等操作内容无效')
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
  ) throw new SubagentSupervisorValidationError(`${label} 无效`)
  return value
}

const operationId = (value: unknown) => {
  if (typeof value !== 'string' || !operationIdPattern.test(value)) throw new SubagentSupervisorValidationError('operationId 无效')
  return value
}

const canonicalTimestamp = (value: unknown, label: string) => {
  if (typeof value !== 'string') throw new SubagentSupervisorValidationError(`${label} 无效`)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) throw new SubagentSupervisorValidationError(`${label} 无效`)
  return parsed.toISOString()
}

const normalizedGrantIds = (value: unknown) => {
  if (!Array.isArray(value) || value.length > 128) throw new SubagentSupervisorValidationError('授权范围无效')
  const grants = value.map((entry) => identifier(entry, '授权标识') as string).sort()
  if (new Set(grants).size !== grants.length) throw new SubagentSupervisorValidationError('授权标识重复')
  return grants
}

const normalizedScope = (value: unknown): GoalExecutionScope => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SubagentSupervisorValidationError('执行范围无效')
  const record = value as Record<string, unknown>
  if (!record.auth || typeof record.auth !== 'object' || Array.isArray(record.auth)) throw new SubagentSupervisorValidationError('授权范围无效')
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

const exactScope = (left: GoalExecutionScope, right: GoalExecutionScope) => (
  left.taskId === right.taskId
  && left.projectId === right.projectId
  && left.auth.principalId === right.auth.principalId
  && left.auth.grantIds.length === right.auth.grantIds.length
  && left.auth.grantIds.every((grant, index) => grant === right.auth.grantIds[index])
)

const executionMode = (value: unknown): SubagentExecutionMode => {
  if (value === 'synchronous' || value === 'asynchronous') return value
  throw new SubagentSupervisorValidationError('子代理执行模式无效')
}

const subagentState = (value: unknown): SubagentState => {
  if (value === 'running' || value === 'awaiting_parent_verification' || value === 'reconnecting' || value === 'cancelling' || value === 'cancelled' || value === 'failed') return value
  throw new SubagentSupervisorValidationError('子代理状态无效')
}

const recoveryState = (value: unknown): SubagentRecoveryState => {
  if (value === 'active' || value === 'interrupted' || value === 'cancel_requested') return value
  throw new SubagentSupervisorValidationError('子代理恢复状态无效')
}

const resumeState = (value: unknown): 'running' | 'awaiting_parent_verification' => {
  if (value === 'running' || value === 'awaiting_parent_verification') return value
  throw new SubagentSupervisorValidationError('子代理恢复目标状态无效')
}

const eventKind = (value: unknown): SubagentEventKind => {
  if (
    value === 'subagent.started'
    || value === 'subagent.reported'
    || value === 'subagent.disconnected'
    || value === 'subagent.recovery.planned'
    || value === 'subagent.cancel.requested'
    || value === 'subagent.cancel.acknowledged'
    || value === 'subagent.failed'
  ) return value
  throw new SubagentSupervisorValidationError('子代理事件类型无效')
}

const normalizedEvent = (value: unknown): SubagentEvent => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SubagentSupervisorValidationError('子代理事件无效')
  const event = value as Record<string, unknown>
  if (typeof event.sequence !== 'number' || !Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new SubagentSupervisorValidationError('子代理事件序号无效')
  return {
    id: identifier(event.id, '子代理事件标识') as string,
    sequence: event.sequence,
    at: canonicalTimestamp(event.at, '子代理事件时间'),
    kind: eventKind(event.kind),
  }
}

const normalizedStoredRun = (value: unknown): SubagentRun => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SubagentSupervisorValidationError('子代理运行记录无效')
  const run = value as Record<string, unknown>
  if (run.version !== 1 || !run.recovery || typeof run.recovery !== 'object' || Array.isArray(run.recovery)) throw new SubagentSupervisorValidationError('子代理运行记录版本或恢复信息无效')
  const recovery = run.recovery as Record<string, unknown>
  if (typeof recovery.attempts !== 'number' || !Number.isSafeInteger(recovery.attempts) || recovery.attempts < 0) throw new SubagentSupervisorValidationError('子代理恢复次数无效')
  const parentScope = normalizedScope(run.parentScope)
  const scope = normalizedScope(run.scope)
  if (
    scope.taskId !== parentScope.taskId
    || scope.projectId !== parentScope.projectId
    || scope.auth.principalId !== parentScope.auth.principalId
    || scope.auth.grantIds.some((grant) => !parentScope.auth.grantIds.includes(grant))
  ) throw new SubagentSupervisorValidationError('子代理范围不能超出父任务范围')
  if (!Array.isArray(run.events) || run.events.length > MAX_EVENT_COUNT) throw new SubagentSupervisorValidationError('子代理事件列表无效')
  const events = run.events.map(normalizedEvent)
  if (events.some((event, index) => event.sequence !== index + 1)) throw new SubagentSupervisorValidationError('子代理事件序号不连续')
  return {
    version: 1,
    id: identifier(run.id, '子代理运行标识') as string,
    parentRunId: identifier(run.parentRunId, '父目标运行标识') as string,
    parentScope,
    scope,
    executionMode: executionMode(run.executionMode),
    state: subagentState(run.state),
    recovery: {
      state: recoveryState(recovery.state),
      attempts: recovery.attempts,
      ...(recovery.lastDisconnectedAt === undefined ? {} : { lastDisconnectedAt: canonicalTimestamp(recovery.lastDisconnectedAt, '子代理断连时间') }),
      ...(recovery.resumeState === undefined ? {} : { resumeState: resumeState(recovery.resumeState) }),
    },
    events,
    createdAt: canonicalTimestamp(run.createdAt, '子代理创建时间'),
    updatedAt: canonicalTimestamp(run.updatedAt, '子代理更新时间'),
  }
}

const normalizedStoredOperation = (value: unknown): StoredOperation => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SubagentSupervisorValidationError('子代理幂等操作无效')
  const operation = value as Record<string, unknown>
  if (typeof operation.kind !== 'string' || !operation.kind) throw new SubagentSupervisorValidationError('子代理幂等操作类型无效')
  if (typeof operation.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(operation.fingerprint)) throw new SubagentSupervisorValidationError('子代理幂等操作指纹无效')
  return {
    id: operationId(operation.id),
    kind: operation.kind,
    fingerprint: operation.fingerprint,
    subagentRunId: identifier(operation.subagentRunId, '子代理幂等操作目标') as string,
    recordedAt: canonicalTimestamp(operation.recordedAt, '子代理幂等操作时间'),
  }
}

const emptyFile = (): SupervisorFile => ({ schema: SUBAGENT_SUPERVISOR_SCHEMA, runs: [], operations: [] })

const normalizedFile = (value: unknown): SupervisorFile => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SubagentSupervisorValidationError('子代理状态文件无效')
  const file = value as Record<string, unknown>
  if (file.schema !== SUBAGENT_SUPERVISOR_SCHEMA || !Array.isArray(file.runs) || !Array.isArray(file.operations)) throw new SubagentSupervisorValidationError('子代理状态文件 schema 无效')
  const runs = file.runs.map(normalizedStoredRun)
  const operations = file.operations.map(normalizedStoredOperation)
  if (new Set(runs.map((run) => run.id)).size !== runs.length) throw new SubagentSupervisorValidationError('子代理运行标识重复')
  if (new Set(operations.map((operation) => operation.id)).size !== operations.length) throw new SubagentSupervisorValidationError('子代理幂等操作标识重复')
  if (operations.some((operation) => !runs.some((run) => run.id === operation.subagentRunId))) throw new SubagentSupervisorValidationError('子代理幂等操作引用未知运行')
  return { schema: SUBAGENT_SUPERVISOR_SCHEMA, runs, operations }
}

const isTerminal = (run: SubagentRun) => run.state === 'cancelled' || run.state === 'failed'

const findRun = (file: SupervisorFile, subagentRunIdValue: unknown) => {
  const subagentRunId = identifier(subagentRunIdValue, '子代理运行标识') as string
  const run = file.runs.find((entry) => entry.id === subagentRunId)
  if (!run) throw new SubagentSupervisorConflictError('子代理运行不存在')
  return run
}

const assertParentBoundary = (run: SubagentRun, input: Pick<SubagentParentBoundary, 'parentRunId' | 'parentScope'>) => {
  const parentRunId = identifier(input.parentRunId, '父目标运行标识') as string
  const parentScope = normalizedScope(input.parentScope)
  if (run.parentRunId !== parentRunId || !exactScope(run.parentScope, parentScope)) {
    throw new SubagentParentBoundaryError('子代理不属于当前父任务、项目或授权边界')
  }
  return parentScope
}

const appendEvent = (run: SubagentRun, kind: SubagentEventKind, at: string) => {
  if (run.events.length >= MAX_EVENT_COUNT) throw new SubagentSupervisorConflictError('子代理事件数量超过限制')
  const sequence = run.events.length + 1
  run.events.push({
    id: `sub_evt_${hash(`${run.id}\u0000${sequence}\u0000${kind}`).slice(0, 32)}`,
    sequence,
    at,
    kind,
  })
}

const eventProjection = (event: SubagentEvent) => {
  const copy: Record<SubagentEventKind, { tone: 'info' | 'success' | 'warning' | 'error'; text: string }> = {
    'subagent.started': { tone: 'info', text: '子代理已在父任务边界内启动。' },
    'subagent.reported': { tone: 'warning', text: '子代理已回报，等待父任务独立验证。' },
    'subagent.disconnected': { tone: 'warning', text: '子代理连接中断，等待恢复。' },
    'subagent.recovery.planned': { tone: 'info', text: '已生成子代理恢复指令。' },
    'subagent.cancel.requested': { tone: 'warning', text: '已请求停止子代理。' },
    'subagent.cancel.acknowledged': { tone: 'warning', text: '子代理已确认停止。' },
    'subagent.failed': { tone: 'error', text: '子代理运行失败。' },
  }
  return { id: event.id, sequence: event.sequence, at: event.at, ...copy[event.kind] }
}

/**
 * Safe inspector feed.  It does not expose task goals, prompts, agent prose,
 * parent/child grant identifiers, or any tool/provider details.
 */
export const projectSubagentRun = (run: SubagentRun, limit = 24): SubagentProjection => {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 24
  return {
    subagentRunId: run.id,
    parentRunId: run.parentRunId,
    executionMode: run.executionMode,
    state: run.state,
    recovery: run.recovery.state,
    activity: run.events.slice(-boundedLimit).reverse().map(eventProjection),
  }
}

export function createSubagentSupervisor(options: {
  storageDir: string
  now?: () => Date
  idFactory?: () => string
}) {
  const storageDir = path.resolve(options.storageDir)
  const statePath = path.join(storageDir, 'subagent-supervisor.json')
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
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new SubagentSupervisorValidationError('子代理存储目录不安全')
    try { await chmod(storageDir, 0o700) } catch { /* Filesystems without POSIX permissions are still supported. */ }
  }

  const readState = async (): Promise<SupervisorFile> => {
    await ensureStorage()
    try {
      const metadata = await lstat(statePath)
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_STATE_BYTES || (metadata.mode & 0o077) !== 0) {
        throw new SubagentSupervisorValidationError('子代理状态文件不安全')
      }
      return normalizedFile(JSON.parse(await readFile(statePath, 'utf8')) as unknown)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return emptyFile()
      throw error
    }
  }

  const persistState = async (state: SupervisorFile) => {
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
    action: (state: SupervisorFile, nowAt: string) => SubagentRun,
  ) => serialize(async () => {
    const id = operationId(operation.id)
    const fingerprint = hash(canonicalJson(operation.fingerprintInput))
    const state = await readState()
    const previous = state.operations.find((entry) => entry.id === id)
    if (previous) {
      if (previous.kind !== operation.kind || previous.fingerprint !== fingerprint) throw new SubagentSupervisorConflictError('operationId 已用于不同更新')
      return clone(findRun(state, previous.subagentRunId))
    }
    const result = action(state, timestamp())
    state.operations.push({ id, kind: operation.kind, fingerprint, subagentRunId: result.id, recordedAt: timestamp() })
    if (state.operations.length > MAX_OPERATION_COUNT) state.operations.splice(0, state.operations.length - MAX_OPERATION_COUNT)
    await persistState(state)
    return clone(result)
  })

  const start = (input: StartSubagentInput) => {
    const parentRunId = identifier(input.parentRunId, '父目标运行标识') as string
    const parentScope = normalizedScope(input.parentScope)
    const requestedGrantIds = input.requestedGrantIds === undefined ? [...parentScope.auth.grantIds] : normalizedGrantIds(input.requestedGrantIds)
    if (requestedGrantIds.some((grant) => !parentScope.auth.grantIds.includes(grant))) {
      throw new SubagentParentBoundaryError('子代理不能请求父任务未授予的权限')
    }
    const childScope: GoalExecutionScope = {
      taskId: parentScope.taskId,
      projectId: parentScope.projectId,
      auth: { principalId: parentScope.auth.principalId, grantIds: requestedGrantIds },
    }
    // Synchronous is the safe default: the parent retains ordering and must
    // explicitly opt in before a future effect adapter schedules async work.
    const mode = input.executionMode === undefined ? 'synchronous' : executionMode(input.executionMode)
    const subagentRunId = `sub_run_${identifier(idFactory(), '子代理运行随机标识')}`
    return mutate(
      {
        id: input.operationId,
        kind: 'subagent.start',
        fingerprintInput: { parentRunId, parentScope, childScope, mode },
      },
      (state, nowAt) => {
        if (state.runs.some((run) => run.id === subagentRunId)) throw new SubagentSupervisorConflictError('子代理运行标识冲突')
        const run: SubagentRun = {
          version: 1,
          id: subagentRunId,
          parentRunId,
          parentScope,
          scope: childScope,
          executionMode: mode,
          state: 'running',
          recovery: { state: 'active', attempts: 0 },
          events: [],
          createdAt: nowAt,
          updatedAt: nowAt,
        }
        appendEvent(run, 'subagent.started', nowAt)
        state.runs.push(run)
        return run
      },
    )
  }

  /**
   * A child report is intentionally only a handoff to the parent's verifier;
   * `prose` is ignored and never stored, so it cannot become a success claim.
   */
  const recordAgentReport = (input: SubagentUpdateInput & { claimId: string; prose?: unknown }) => mutate(
    {
      id: input.operationId,
      kind: 'subagent.report',
      fingerprintInput: {
        parentRunId: input.parentRunId,
        parentScope: normalizedScope(input.parentScope),
        subagentRunId: input.subagentRunId,
        claimId: identifier(input.claimId, '子代理回报标识'),
      },
    },
    (state, nowAt) => {
      const run = findRun(state, input.subagentRunId)
      assertParentBoundary(run, input)
      if (isTerminal(run) || run.state === 'cancelling') throw new SubagentSupervisorConflictError('终态或取消中的子代理不能提交回报')
      if (run.state === 'running') {
        run.state = 'awaiting_parent_verification'
        appendEvent(run, 'subagent.reported', nowAt)
      } else if (run.state !== 'awaiting_parent_verification') {
        throw new SubagentSupervisorConflictError('子代理当前状态不能提交回报')
      }
      run.updatedAt = nowAt
      return run
    },
  )

  const markDisconnected = (input: SubagentUpdateInput) => mutate(
    {
      id: input.operationId,
      kind: 'subagent.disconnected',
      fingerprintInput: { parentRunId: input.parentRunId, parentScope: normalizedScope(input.parentScope), subagentRunId: input.subagentRunId },
    },
    (state, nowAt) => {
      const run = findRun(state, input.subagentRunId)
      assertParentBoundary(run, input)
      if (isTerminal(run)) throw new SubagentSupervisorConflictError('终态子代理不需要恢复')
      const cancelRequested = run.state === 'cancelling' || run.recovery.state === 'cancel_requested'
      const resumableState = run.state === 'running' || run.state === 'awaiting_parent_verification'
        ? run.state
        : run.recovery.resumeState
      run.recovery = {
        state: cancelRequested ? 'cancel_requested' : 'interrupted',
        attempts: run.recovery.attempts + 1,
        lastDisconnectedAt: nowAt,
        ...(!cancelRequested && resumableState ? { resumeState: resumableState } : {}),
      }
      if (!cancelRequested) run.state = 'reconnecting'
      appendEvent(run, 'subagent.disconnected', nowAt)
      run.updatedAt = nowAt
      return run
    },
  )

  const recover = async (input: SubagentUpdateInput): Promise<{ run: SubagentRun; action: SubagentRecoveryAction }> => {
    const run = await mutate(
      {
        id: input.operationId,
        kind: 'subagent.recover',
        fingerprintInput: { parentRunId: input.parentRunId, parentScope: normalizedScope(input.parentScope), subagentRunId: input.subagentRunId },
      },
      (state, nowAt) => {
        const current = findRun(state, input.subagentRunId)
        assertParentBoundary(current, input)
        if (isTerminal(current)) throw new SubagentSupervisorConflictError('终态子代理不能恢复')
        if (current.recovery.state === 'active' && current.state !== 'reconnecting') throw new SubagentSupervisorConflictError('子代理没有待恢复连接')
        const cancelling = current.state === 'cancelling' || current.recovery.state === 'cancel_requested'
        const resumeState = current.recovery.resumeState ?? 'running'
        current.recovery = { state: cancelling ? 'cancel_requested' : 'active', attempts: current.recovery.attempts }
        if (!cancelling) current.state = resumeState
        appendEvent(current, 'subagent.recovery.planned', nowAt)
        current.updatedAt = nowAt
        return current
      },
    )
    return {
      run,
      action: {
        kind: run.state === 'cancelling' || run.recovery.state === 'cancel_requested' ? 'resume_then_cancel_subagent' : 'resume_subagent',
        subagentRunId: run.id,
        parentRunId: run.parentRunId,
        executionMode: run.executionMode,
      },
    }
  }

  const requestCancellation = (input: SubagentUpdateInput) => mutate(
    {
      id: input.operationId,
      kind: 'subagent.cancel.request',
      fingerprintInput: { parentRunId: input.parentRunId, parentScope: normalizedScope(input.parentScope), subagentRunId: input.subagentRunId },
    },
    (state, nowAt) => {
      const run = findRun(state, input.subagentRunId)
      assertParentBoundary(run, input)
      if (isTerminal(run)) throw new SubagentSupervisorConflictError('终态子代理不能取消')
      if (run.state !== 'cancelling') {
        run.state = 'cancelling'
        run.recovery = { state: 'cancel_requested', attempts: run.recovery.attempts }
        appendEvent(run, 'subagent.cancel.requested', nowAt)
      }
      run.updatedAt = nowAt
      return run
    },
  )

  const acknowledgeCancellation = (input: SubagentUpdateInput) => mutate(
    {
      id: input.operationId,
      kind: 'subagent.cancel.acknowledge',
      fingerprintInput: { parentRunId: input.parentRunId, parentScope: normalizedScope(input.parentScope), subagentRunId: input.subagentRunId },
    },
    (state, nowAt) => {
      const run = findRun(state, input.subagentRunId)
      assertParentBoundary(run, input)
      if (run.state !== 'cancelling') throw new SubagentSupervisorConflictError('子代理没有待确认的取消请求')
      run.state = 'cancelled'
      run.recovery = { state: 'active', attempts: run.recovery.attempts }
      appendEvent(run, 'subagent.cancel.acknowledged', nowAt)
      run.updatedAt = nowAt
      return run
    },
  )

  const markFailed = (input: SubagentUpdateInput & { failureCode: string }) => mutate(
    {
      id: input.operationId,
      kind: 'subagent.failed',
      fingerprintInput: {
        parentRunId: input.parentRunId,
        parentScope: normalizedScope(input.parentScope),
        subagentRunId: input.subagentRunId,
        failureCode: identifier(input.failureCode, '子代理失败代码'),
      },
    },
    (state, nowAt) => {
      const run = findRun(state, input.subagentRunId)
      assertParentBoundary(run, input)
      if (isTerminal(run)) throw new SubagentSupervisorConflictError('终态子代理不能再次失败')
      run.state = 'failed'
      run.recovery = { state: 'active', attempts: run.recovery.attempts }
      appendEvent(run, 'subagent.failed', nowAt)
      run.updatedAt = nowAt
      return run
    },
  )

  const getForParent = async (input: SubagentParentBoundary & { subagentRunId: string }) => serialize(async () => {
    const state = await readState()
    const run = findRun(state, input.subagentRunId)
    assertParentBoundary(run, input)
    return clone(run)
  })

  const listForParent = async (input: SubagentParentBoundary) => serialize(async () => {
    const parentRunId = identifier(input.parentRunId, '父目标运行标识') as string
    const parentScope = normalizedScope(input.parentScope)
    const state = await readState()
    return state.runs
      .filter((run) => run.parentRunId === parentRunId && exactScope(run.parentScope, parentScope))
      .map(clone)
  })

  const listRecoverableForParent = async (input: SubagentParentBoundary) => {
    const runs = await listForParent(input)
    return runs.filter((run) => !isTerminal(run) && (run.state === 'reconnecting' || run.state === 'cancelling' || run.recovery.state !== 'active'))
  }

  return {
    statePath,
    start,
    recordAgentReport,
    markDisconnected,
    recover,
    requestCancellation,
    acknowledgeCancellation,
    markFailed,
    getForParent,
    listForParent,
    listRecoverableForParent,
  }
}
