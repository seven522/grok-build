import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

import {
  createGoalExecutionOrchestrator,
  projectGoalExecutionRun,
  type GoalExecutionOrchestrator,
  type GoalExecutionScope,
  type GoalExecutionRun,
  type GoalPlanStep,
  type GoalVerifierReceipt,
} from './goal-execution-orchestrator.ts'
import {
  buildDeterministicMemoryContext,
} from './memory-context-builder.ts'
import {
  createDeterministicSemanticMemoryAdapter,
  retrieveSemanticMemories,
} from './memory-semantic-adapter.ts'
import {
  createMemoryStore,
  redactMemoryText,
  type MemoryScope,
  type MemoryStatus,
  type MemoryStore,
  type MemoryWriteInput,
  type MemoryWritePath,
} from './memory-store.ts'
import {
  type ProviderCapability,
  type ProviderRegistry,
} from './provider-registry.ts'
import {
  createSubagentSupervisor,
  projectSubagentRun,
  type SubagentSupervisor,
} from './subagent-supervisor.ts'
import type { TaskEvent, TaskEventLedger } from './task-event-ledger.ts'

/**
 * The P2 control plane owns only durable declarations and projections.  It
 * does not open a model connection or execute a shell command: the existing
 * ACP bridge remains the sole effect boundary.  This keeps provider routing,
 * memory recall, verification, and child-agent recovery inspectable without
 * turning local browser input into an execution authority.
 */
export const LOCAL_P2_PRINCIPAL_ID = 'local-user'
export const P2_EXECUTION_STEP_ID = 'execute-and-verify'

export type P2AuthorizationMode = 'manual-current' | 'approve-running'

export type P2ControlPlane = {
  memoryStore: MemoryStore
  goalExecutions: GoalExecutionOrchestrator
  subagents: SubagentSupervisor
  reconcileSourcedMemories: () => Promise<P2SourcedMemoryReconcileResult[]>
  middleware: (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => Promise<void>
}

export type P2ControlPlaneOptions = {
  storageDir: string
  providerRegistry: ProviderRegistry
  taskEventLedger: TaskEventLedger
  getRuntimeModelAvailability: () => readonly { id: string; available: boolean; reason?: string }[]
  projectExists: (projectId: string) => Promise<boolean>
  projectRules: (projectId: string | null) => Promise<string[]>
}

type JsonRecord = Record<string, unknown>

export type P2SourcedMemoryReconcilePhase = 'prepared' | 'proposed' | 'stored' | 'committed'

export type P2SourcedMemoryReconcileResult = {
  transactionId: string
  operationId: string
  phase: P2SourcedMemoryReconcilePhase
  sourceTaskId: string
  sourceEventId: string
  memoryId?: string
  proposalEventId?: string
  committedEventId?: string
}

type SourcedMemoryTransaction = {
  id: string
  operationId: string
  projectId: string | null
  sourceTaskId: string
  sourceRunId: string | null
  sourceEventId: string
  writePath: Extract<MemoryWritePath, 'remember' | 'accepted-decision'>
  input: MemoryWriteInput
  phase: P2SourcedMemoryReconcilePhase
  proposalEventId?: string
  memoryId?: string
  memoryAppended?: boolean
  committedEventId?: string
  createdAt: string
  updatedAt: string
  audit: Array<{ at: string; phase: P2SourcedMemoryReconcilePhase; eventId?: string; memoryId?: string }>
}

type SourcedMemoryJournalFile = {
  schema: 'runbuild.p2.sourced-memory-reconcile.v1'
  transactions: SourcedMemoryTransaction[]
}

const MAX_BODY_BYTES = 256 * 1024
const MAX_CONTEXT_QUERY_CHARS = 4_096
const MAX_CONTEXT_SUMMARY_CHARS = 8_000
const MAX_SOURCED_MEMORY_TRANSACTIONS = 4_096
const MAX_SOURCED_MEMORY_JOURNAL_BYTES = 8 * 1024 * 1024
const MAX_MEMORY_OPERATION_BYTES = 1_024
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const sourcedMemoryJournalSchema = 'runbuild.p2.sourced-memory-reconcile.v1' as const

const isRecord = (value: unknown): value is JsonRecord => Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

const asText = (value: unknown) => typeof value === 'string' ? value.trim() : ''

const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : ''

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

const readJsonBody = async (request: IncomingMessage): Promise<JsonRecord> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('请求内容超过 256KB 限制')
    chunks.push(buffer)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!isRecord(parsed)) throw new Error('请求内容必须是 JSON 对象')
  return parsed
}

const optionalId = (value: unknown, label: string, options: { nullable?: boolean; rootAlias?: boolean } = {}): string | null => {
  if (value === undefined || (options.nullable && value === null)) return null
  if (options.rootAlias && value === 'root') return null
  if (typeof value !== 'string' || !opaqueIdPattern.test(value)) throw new Error(`${label} 无效`)
  return value
}

const requiredId = (value: unknown, label: string) => {
  const id = optionalId(value, label)
  if (!id) throw new Error(`${label} 必填`)
  return id
}

const optionalText = (value: unknown, label: string, maximum: number) => {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) throw new Error(`${label} 无效`)
  return value
}

const optionalBoolean = (value: unknown, label: string) => {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${label} 必须是布尔值`)
  return value
}

const optionalNumber = (value: unknown, label: string) => {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} 无效`)
  return value
}

const safeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : 'P2 本地服务请求失败'
  // Core validators never include values in their messages.  Keeping the
  // response bounded avoids accidentally reflecting oversized local input.
  return message.replace(/[\r\n]+/g, ' ').slice(0, 300) || 'P2 本地服务请求失败'
}

const clientErrorStatus = (error: unknown) => {
  const message = safeError(error)
  if (/不存在|未找到/.test(message)) return 404
  if (/不属于|不能|冲突|已用于|已存在|终态|尚未/.test(message)) return 409
  return 400
}

const statuses = (value: string | null): MemoryStatus[] | undefined => {
  if (!value) return undefined
  const result = value.split(',').map((entry) => entry.trim()).filter(Boolean)
  if (!result.length) return undefined
  const allowed = new Set<MemoryStatus>(['active', 'superseded', 'disputed', 'deleted'])
  if (result.some((entry) => !allowed.has(entry as MemoryStatus))) throw new Error('memory status 查询无效')
  return result as MemoryStatus[]
}

const authorizationScope = (
  taskId: string,
  projectId: string | null,
  mode: unknown,
): GoalExecutionScope => {
  if (mode !== 'manual-current' && mode !== 'approve-running') throw new Error('执行授权模式无效')
  return {
    taskId,
    projectId,
    auth: {
      principalId: LOCAL_P2_PRINCIPAL_ID,
      // These are capability labels, not OS or provider credentials.  The
      // child supervisor can only narrow them from this immutable parent.
      grantIds: [`permission:${mode}`],
    },
  }
}

const projectIdFrom = async (
  value: unknown,
  options: Pick<P2ControlPlaneOptions, 'projectExists'>,
) => {
  const projectId = optionalId(value, 'projectId', { nullable: true, rootAlias: true })
  if (projectId && !(await options.projectExists(projectId))) throw new Error('项目不存在')
  return projectId
}

const memoryScopeFor = (projectId: string | null): MemoryScope => ({
  userId: LOCAL_P2_PRINCIPAL_ID,
  projectId,
  // P2 memory remains provider-neutral.  Provider-specific facts can be
  // added only through an explicit future policy, never by silent routing.
  agentId: null,
  // Recall is intentionally cold-session capable; task/run IDs remain only
  // in provenance, not in the visibility scope.
  runId: null,
})

const firstActiveStep = (run: GoalExecutionRun): GoalPlanStep | undefined => (
  run.plan.find((step) => step.state === 'running')
    ?? run.plan.find((step) => step.state === 'verifying')
)

const stringArray = (value: unknown) => Array.isArray(value)
  ? value.filter((entry): entry is string => typeof entry === 'string' && opaqueIdPattern.test(entry))
  : []

const manualProvenanceId = (operationId: string) => (
  `manual:${createHash('sha256').update(operationId, 'utf8').digest('hex')}`
)

const eventRecord = (event: TaskEvent) => isRecord(event.payload) ? event.payload : {}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const durableMemoryOperationId = (value: string) => {
  if (!value || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_MEMORY_OPERATION_BYTES) throw new Error('memory idempotencyKey 无效')
  return value
}

const redactedSourcedMemoryText = (value: unknown, label: string, maximumBytes: number, multiline = false) => {
  if (typeof value !== 'string' || value.includes('\0') || (!multiline && /[\r\n]/.test(value))) throw new Error(`${label} 无效`)
  const text = redactMemoryText(value).text.trim()
  if (!text || Buffer.byteLength(text, 'utf8') > maximumBytes) throw new Error(`${label} 超过限制或为空`)
  return text
}

const sourcedMemoryWriteInput = (
  record: JsonRecord,
  scope: MemoryScope,
  sourceTaskId: string,
  sourceRunId: string | null,
  sourceEventId: string,
  operationId: string,
): MemoryWriteInput => {
  const confidence = optionalNumber(record.confidence, 'memory confidence')
  if (confidence !== undefined && (confidence < 0 || confidence > 1)) throw new Error('memory confidence 必须在 0 到 1 之间')
  const sensitivity = record.sensitivity === undefined ? undefined : record.sensitivity
  if (sensitivity !== undefined && sensitivity !== 'normal' && sensitivity !== 'sensitive' && sensitivity !== 'restricted') {
    throw new Error('memory sensitivity 无效')
  }
  const pinned = optionalBoolean(record.pinned, 'memory pinned')
  return {
    scope,
    provenance: { sourceEventIds: [sourceEventId], sourceTaskId, sourceRunId },
    title: redactedSourcedMemoryText(record.title, 'memory title', 512),
    fact: redactedSourcedMemoryText(record.fact, 'memory fact', 24 * 1024, true),
    ...(confidence === undefined ? {} : { confidence }),
    ...(sensitivity === undefined ? {} : { sensitivity: sensitivity as MemoryWriteInput['sensitivity'] }),
    ...(pinned === undefined ? {} : { pinned }),
    idempotencyKey: operationId,
  }
}

const phaseRank = (phase: P2SourcedMemoryReconcilePhase) => ({ prepared: 0, proposed: 1, stored: 2, committed: 3 })[phase]

const sourcedMemoryResult = (entry: SourcedMemoryTransaction): P2SourcedMemoryReconcileResult => ({
  transactionId: entry.id,
  operationId: entry.operationId,
  phase: entry.phase,
  sourceTaskId: entry.sourceTaskId,
  sourceEventId: entry.sourceEventId,
  ...(entry.memoryId ? { memoryId: entry.memoryId } : {}),
  ...(entry.proposalEventId ? { proposalEventId: entry.proposalEventId } : {}),
  ...(entry.committedEventId ? { committedEventId: entry.committedEventId } : {}),
})

const transactionFingerprint = (entry: Pick<SourcedMemoryTransaction, 'operationId' | 'projectId' | 'sourceTaskId' | 'sourceRunId' | 'sourceEventId' | 'writePath' | 'input'>) => (
  createHash('sha256').update(JSON.stringify({
    operationId: entry.operationId,
    projectId: entry.projectId,
    sourceTaskId: entry.sourceTaskId,
    sourceRunId: entry.sourceRunId,
    sourceEventId: entry.sourceEventId,
    writePath: entry.writePath,
    input: entry.input,
  }), 'utf8').digest('hex')
)

const validateJournalEntry = (value: unknown): SourcedMemoryTransaction => {
  if (!isRecord(value) || !isRecord(value.input) || !Array.isArray(value.audit)) throw new Error('sourced memory reconcile 状态无效')
  const phase = value.phase
  if (phase !== 'prepared' && phase !== 'proposed' && phase !== 'stored' && phase !== 'committed') throw new Error('sourced memory reconcile 阶段无效')
  const writePath = value.writePath
  if (writePath !== 'remember' && writePath !== 'accepted-decision') throw new Error('sourced memory reconcile 写入类型无效')
  const operationId = durableMemoryOperationId(asText(value.operationId))
  const id = requiredId(value.id, 'sourced memory reconcile 标识')
  const sourceTaskId = requiredId(value.sourceTaskId, 'sourceTaskId')
  const sourceRunId = optionalId(value.sourceRunId, 'sourceRunId', { nullable: true })
  const sourceEventId = requiredId(value.sourceEventId, 'sourceEventId')
  const projectId = optionalId(value.projectId, 'projectId', { nullable: true })
  const input = value.input as unknown as MemoryWriteInput
  const createdAt = optionalText(value.createdAt, 'sourced memory reconcile 创建时间', 128)
  const updatedAt = optionalText(value.updatedAt, 'sourced memory reconcile 更新时间', 128)
  if (!createdAt || Number.isNaN(Date.parse(createdAt)) || !updatedAt || Number.isNaN(Date.parse(updatedAt))) throw new Error('sourced memory reconcile 时间无效')
  const audit = value.audit.map((entry) => {
    if (!isRecord(entry) || (entry.phase !== 'prepared' && entry.phase !== 'proposed' && entry.phase !== 'stored' && entry.phase !== 'committed')) {
      throw new Error('sourced memory reconcile 审计无效')
    }
    const auditPhase = entry.phase as P2SourcedMemoryReconcilePhase
    const at = optionalText(entry.at, 'sourced memory reconcile 审计时间', 128)
    if (!at || Number.isNaN(Date.parse(at))) throw new Error('sourced memory reconcile 审计时间无效')
    const eventId = entry.eventId === undefined ? undefined : requiredId(entry.eventId, 'sourced memory reconcile 事件')
    const memoryId = entry.memoryId === undefined ? undefined : requiredId(entry.memoryId, 'sourced memory reconcile memory')
    return { at: new Date(at).toISOString(), phase: auditPhase, ...(eventId ? { eventId } : {}), ...(memoryId ? { memoryId } : {}) }
  })
  if (audit.length < 1 || audit.length > 16) throw new Error('sourced memory reconcile 审计数量无效')
  return {
    id,
    operationId,
    projectId,
    sourceTaskId,
    sourceRunId,
    sourceEventId,
    writePath,
    input,
    phase,
    ...(value.proposalEventId === undefined ? {} : { proposalEventId: requiredId(value.proposalEventId, 'sourced memory reconcile proposal') }),
    ...(value.memoryId === undefined ? {} : { memoryId: requiredId(value.memoryId, 'sourced memory reconcile memory') }),
    ...(value.memoryAppended === undefined ? {} : { memoryAppended: optionalBoolean(value.memoryAppended, 'sourced memory reconcile memoryAppended') as boolean }),
    ...(value.committedEventId === undefined ? {} : { committedEventId: requiredId(value.committedEventId, 'sourced memory reconcile committed') }),
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    audit,
  }
}

const createSourcedMemoryJournal = (storageDirInput: string) => {
  const storageDir = path.resolve(storageDirInput)
  const statePath = path.join(storageDir, 'sourced-memory-reconcile.json')
  let operationQueue: Promise<void> = Promise.resolve()

  const serialize = <T>(operation: () => Promise<T>) => {
    const result = operationQueue.then(operation, operation)
    operationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  const ensureStorage = async () => {
    await mkdir(storageDir, { recursive: true, mode: 0o700 })
    const metadata = await lstat(storageDir)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('sourced memory reconcile 目录不安全')
    try { await chmod(storageDir, 0o700) } catch { /* Filesystems without POSIX permissions are supported. */ }
  }

  const readState = async (): Promise<SourcedMemoryJournalFile> => {
    await ensureStorage()
    try {
      const metadata = await lstat(statePath)
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_SOURCED_MEMORY_JOURNAL_BYTES || (metadata.mode & 0o077) !== 0) {
        throw new Error('sourced memory reconcile 状态文件不安全')
      }
      const parsed = JSON.parse(await readFile(statePath, 'utf8')) as unknown
      if (!isRecord(parsed) || parsed.schema !== sourcedMemoryJournalSchema || !Array.isArray(parsed.transactions)) throw new Error('sourced memory reconcile 状态文件无效')
      if (parsed.transactions.length > MAX_SOURCED_MEMORY_TRANSACTIONS) throw new Error('sourced memory reconcile 事务数量超过限制')
      const transactions = parsed.transactions.map(validateJournalEntry)
      if (new Set(transactions.map((entry) => entry.id)).size !== transactions.length) throw new Error('sourced memory reconcile 事务标识重复')
      return { schema: sourcedMemoryJournalSchema, transactions }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { schema: sourcedMemoryJournalSchema, transactions: [] }
      throw error
    }
  }

  const persistState = async (state: SourcedMemoryJournalFile) => {
    await ensureStorage()
    const normalized: SourcedMemoryJournalFile = {
      schema: sourcedMemoryJournalSchema,
      transactions: state.transactions.map(validateJournalEntry),
    }
    const source = `${JSON.stringify(normalized, null, 2)}\n`
    if (Buffer.byteLength(source, 'utf8') > MAX_SOURCED_MEMORY_JOURNAL_BYTES) throw new Error('sourced memory reconcile 状态超过限制')
    const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(source, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await chmod(temporaryPath, 0o600)
      await rename(temporaryPath, statePath)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  const prepare = (candidate: Omit<SourcedMemoryTransaction, 'phase' | 'createdAt' | 'updatedAt' | 'audit'>) => serialize(async () => {
    const state = await readState()
    const existing = state.transactions.find((entry) => entry.id === candidate.id)
    if (existing) {
      if (transactionFingerprint(existing) !== transactionFingerprint(candidate)) throw new Error('memory idempotencyKey 已用于不同 sourced memory')
      return { entry: clone(existing), created: false }
    }
    if (state.transactions.length >= MAX_SOURCED_MEMORY_TRANSACTIONS) throw new Error('sourced memory reconcile 事务数量超过限制')
    const now = new Date().toISOString()
    const entry: SourcedMemoryTransaction = {
      ...candidate,
      phase: 'prepared',
      createdAt: now,
      updatedAt: now,
      audit: [{ at: now, phase: 'prepared' }],
    }
    state.transactions.push(entry)
    await persistState(state)
    return { entry: clone(entry), created: true }
  })

  const get = (transactionId: string) => serialize(async () => {
    const state = await readState()
    const entry = state.transactions.find((item) => item.id === transactionId)
    if (!entry) throw new Error('sourced memory reconcile 事务不存在')
    return clone(entry)
  })

  const transition = (
    transactionId: string,
    phase: P2SourcedMemoryReconcilePhase,
    patch: Partial<Pick<SourcedMemoryTransaction, 'proposalEventId' | 'memoryId' | 'memoryAppended' | 'committedEventId'>> = {},
  ) => serialize(async () => {
    const state = await readState()
    const entry = state.transactions.find((item) => item.id === transactionId)
    if (!entry) throw new Error('sourced memory reconcile 事务不存在')
    if (phaseRank(entry.phase) > phaseRank(phase)) return clone(entry)
    if (phaseRank(entry.phase) === phaseRank(phase)) {
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined && entry[key as keyof typeof patch] !== value) throw new Error('sourced memory reconcile 事务阶段冲突')
      }
      return clone(entry)
    }
    const now = new Date().toISOString()
    Object.assign(entry, patch)
    entry.phase = phase
    entry.updatedAt = now
    entry.audit.push({
      at: now,
      phase,
      ...(patch.proposalEventId ? { eventId: patch.proposalEventId } : {}),
      ...(patch.committedEventId ? { eventId: patch.committedEventId } : {}),
      ...(patch.memoryId ? { memoryId: patch.memoryId } : {}),
    })
    if (entry.audit.length > 16) entry.audit.splice(0, entry.audit.length - 16)
    await persistState(state)
    return clone(entry)
  })

  const pending = () => serialize(async () => (await readState()).transactions.filter((entry) => entry.phase !== 'committed').map(clone))

  return { statePath, prepare, get, transition, pending }
}

const sourceRunEvents = async (ledger: TaskEventLedger, taskId: string, sourceRunId: string) => {
  const events: TaskEvent[] = []
  let afterSequence = 0
  for (;;) {
    const page = await ledger.read({ taskId, afterSequence, limit: 1_000 })
    if (!page.events.length) break
    events.push(...page.events)
    const finalSequence = page.events[page.events.length - 1]?.sequence
    if (!finalSequence || finalSequence >= page.nextSequence - 1) break
    afterSequence = finalSequence
  }
  return events.filter((event) => event.runId === sourceRunId)
}

const sourceTerminal = (events: readonly TaskEvent[]) => [...events].reverse().find((event) => (
  event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled'
))

const sourceVerification = (events: readonly TaskEvent[]) => [...events].reverse().find((event) => (
  event.type === 'verification.recorded'
  && eventRecord(event).status === 'verified'
  && stringArray(eventRecord(event).evidenceIds).length > 0
))

const userWritableMemoryPaths = new Set<MemoryWritePath>([
  'remember',
  'accepted-decision',
])

const goalReceipt = (
  terminal: TaskEvent,
  verification: TaskEvent | undefined,
  planStepId: string,
): GoalVerifierReceipt => {
  if (terminal.type === 'run.cancelled') {
    throw new Error('已取消的任务不能生成验证收据')
  }
  if (terminal.type === 'run.failed') {
    return {
      id: `ledger:${terminal.eventId}`,
      verifierId: 'runbuild.ledger-evidence-gate',
      authority: 'independent_verifier',
      planStepId,
      status: 'failed',
      checkedAt: terminal.timestamp,
      evidenceIds: [terminal.eventId],
      summary: '任务账本记录了失败终态；目标不能被标记为已验证。',
    }
  }
  if (verification) {
    const payload = eventRecord(verification)
    return {
      id: `ledger:${verification.eventId}`,
      verifierId: 'runbuild.ledger-evidence-gate',
      authority: 'independent_verifier',
      planStepId,
      status: 'passed',
      checkedAt: verification.timestamp,
      evidenceIds: [...new Set([verification.eventId, ...stringArray(payload.evidenceIds)])],
      summary: '已从不可变任务账本读取到通过的工具收据与独立验证记录。',
    }
  }
  return {
    id: `ledger:${terminal.eventId}:blocked`,
    verifierId: 'runbuild.ledger-evidence-gate',
    authority: 'independent_verifier',
    planStepId,
    status: 'blocked',
    checkedAt: terminal.timestamp,
    evidenceIds: [terminal.eventId],
    summary: '任务已到达终态，但账本没有可接受的独立工具验证收据。',
  }
}

export function createP2ControlPlane(options: P2ControlPlaneOptions): P2ControlPlane {
  const memoryStore = createMemoryStore({ storageDir: path.join(options.storageDir, 'memory') })
  const goalExecutions = createGoalExecutionOrchestrator({ storageDir: path.join(options.storageDir, 'executions') })
  const subagents = createSubagentSupervisor({ storageDir: path.join(options.storageDir, 'executions') })
  const semanticAdapter = createDeterministicSemanticMemoryAdapter()
  const sourcedMemoryJournal = createSourcedMemoryJournal(options.storageDir)

  const resolveScopeFromRecord = async (record: JsonRecord, key = 'projectId') => (
    memoryScopeFor(await projectIdFrom(record[key], options))
  )

  const persistMemory = async (writePath: MemoryWritePath, input: MemoryWriteInput) => {
    switch (writePath) {
      case 'accepted-decision': return memoryStore.recordAcceptedDecision(input)
      case 'verified-fault-cause': return memoryStore.recordVerifiedFaultCause(input)
      case 'successful-checkpoint': return memoryStore.recordSuccessfulCheckpoint(input)
      default: return memoryStore.remember(input)
    }
  }

  const sourceEventForTransaction = async (entry: SourcedMemoryTransaction) => {
    const sourceEvent = await options.taskEventLedger.findByEventId({
      taskId: entry.sourceTaskId,
      eventId: entry.sourceEventId,
    })
    if (!sourceEvent) throw new Error('来源事件不存在')
    if (sourceEvent.projectId !== entry.projectId) throw new Error('来源事件不属于当前项目')
    if (sourceEvent.runId !== entry.sourceRunId) throw new Error('来源事件不属于当前运行')
    return sourceEvent
  }

  const reconcileSourcedMemory = async (transactionId: string) => {
    let entry = await sourcedMemoryJournal.get(transactionId)
    await sourceEventForTransaction(entry)
    if (entry.phase === 'prepared') {
      const proposed = await options.taskEventLedger.append({
        type: 'memory.proposed',
        taskId: entry.sourceTaskId,
        projectId: entry.projectId,
        runId: entry.sourceRunId,
        source: 'ui',
        idempotencyKey: `memory:${entry.operationId}:proposed`,
        payload: {
          writePath: entry.writePath,
          userInitiated: true,
          sourceEventId: entry.sourceEventId,
          transactionId: entry.id,
        },
      })
      entry = await sourcedMemoryJournal.transition(entry.id, 'proposed', { proposalEventId: proposed.event.eventId })
    }
    if (entry.phase === 'proposed') {
      const stored = await persistMemory(entry.writePath, entry.input)
      entry = await sourcedMemoryJournal.transition(entry.id, 'stored', {
        memoryId: stored.record.id,
        memoryAppended: stored.appended,
      })
    }
    if (entry.phase === 'stored') {
      if (!entry.memoryId) throw new Error('sourced memory reconcile 缺少 memory 标识')
      const committed = await options.taskEventLedger.append({
        type: 'memory.committed',
        taskId: entry.sourceTaskId,
        projectId: entry.projectId,
        runId: entry.sourceRunId,
        source: 'ui',
        idempotencyKey: `memory:${entry.memoryId}:committed`,
        payload: {
          memoryId: entry.memoryId,
          writePath: entry.writePath,
          sourceEventId: entry.sourceEventId,
          transactionId: entry.id,
        },
      })
      entry = await sourcedMemoryJournal.transition(entry.id, 'committed', { committedEventId: committed.event.eventId })
    }
    if (!entry.memoryId) throw new Error('sourced memory reconcile 未产生 memory 标识')
    const memory = await memoryStore.get({
      scope: entry.input.scope,
      id: entry.memoryId,
      includeUserScoped: true,
    })
    return { entry, memory, appended: entry.memoryAppended === true }
  }

  const reconcileSourcedMemories = async () => {
    const results: P2SourcedMemoryReconcileResult[] = []
    for (const entry of await sourcedMemoryJournal.pending()) {
      const reconciled = await reconcileSourcedMemory(entry.id)
      results.push(sourcedMemoryResult(reconciled.entry))
    }
    return results
  }

  const writeMemory = async (record: JsonRecord) => {
    const projectId = await projectIdFrom(record.projectId, options)
    const scope = memoryScopeFor(projectId)
    const sourceTaskId = optionalId(record.sourceTaskId, 'sourceTaskId', { nullable: true })
    const sourceRunId = optionalId(record.sourceRunId, 'sourceRunId', { nullable: true })
    const sourceEventId = optionalId(record.sourceEventId, 'sourceEventId', { nullable: true })
    const writePath = record.writePath === undefined ? 'remember' : record.writePath
    if (writePath !== 'remember' && writePath !== 'accepted-decision' && writePath !== 'verified-fault-cause' && writePath !== 'successful-checkpoint') {
      throw new Error('memory writePath 无效')
    }
    if (!userWritableMemoryPaths.has(writePath as MemoryWritePath)) {
      // These labels carry a stronger semantic claim than a user-entered fact.
      // P2 deliberately reserves them for a future trusted ledger reducer: a
      // local browser request must never turn arbitrary prose into a verified
      // cause or a successful checkpoint.
      throw new Error('该记忆类型只能由受信任的账本归约写入')
    }
    if (!sourceTaskId && (sourceRunId || sourceEventId)) {
      throw new Error('来源运行和事件必须关联来源任务')
    }
    if (sourceTaskId && !sourceEventId) {
      throw new Error('来源任务写入必须指定来源事件')
    }
    const operationId = durableMemoryOperationId(asText(record.idempotencyKey) || `manual:${randomUUID()}`)
    const provenanceEventIds: string[] = []
    if (sourceTaskId && sourceEventId) {
      const sourceEvent = await options.taskEventLedger.findByEventId({ taskId: sourceTaskId, eventId: sourceEventId })
      if (!sourceEvent) throw new Error('来源事件不存在')
      if (sourceEvent.projectId !== projectId) throw new Error('来源事件不属于当前项目')
      if (sourceEvent.runId !== sourceRunId) throw new Error('来源事件不属于当前运行')
      const transactionId = `memtx_${createHash('sha256').update(JSON.stringify({ projectId, sourceTaskId, writePath, operationId }), 'utf8').digest('hex')}`
      const prepared = await sourcedMemoryJournal.prepare({
        id: transactionId,
        operationId,
        projectId,
        sourceTaskId,
        sourceRunId,
        sourceEventId: sourceEvent.eventId,
        writePath: writePath as Extract<MemoryWritePath, 'remember' | 'accepted-decision'>,
        input: sourcedMemoryWriteInput(record, scope, sourceTaskId, sourceRunId, sourceEvent.eventId, operationId),
      })
      const reconciled = await reconcileSourcedMemory(prepared.entry.id)
      return {
        record: reconciled.memory,
        // Once an operation already has a durable journal entry, a client is
        // observing a replay/recovery rather than a new write receipt.
        appended: prepared.created ? reconciled.appended : false,
      }
    } else {
      // A manual write still needs a stable source.  It is explicitly marked
      // as a user action rather than being presented as an ACP observation.
      provenanceEventIds.push(manualProvenanceId(operationId))
    }
    const input: MemoryWriteInput = {
      scope,
      provenance: { sourceEventIds: provenanceEventIds, sourceTaskId, sourceRunId },
      title: record.title as string,
      fact: record.fact as string,
      ...(optionalNumber(record.confidence, 'memory confidence') === undefined ? {} : { confidence: optionalNumber(record.confidence, 'memory confidence') }),
      ...(record.sensitivity === undefined ? {} : { sensitivity: record.sensitivity as MemoryWriteInput['sensitivity'] }),
      ...(optionalBoolean(record.pinned, 'memory pinned') === undefined ? {} : { pinned: optionalBoolean(record.pinned, 'memory pinned') }),
      idempotencyKey: operationId,
    }
    return persistMemory(writePath as MemoryWritePath, input)
  }

  const createGoal = async (record: JsonRecord) => {
    const taskId = requiredId(record.taskId, 'taskId')
    const projectId = await projectIdFrom(record.projectId, options)
    const sourceRunId = optionalId(record.sourceRunId, 'sourceRunId', { nullable: true })
    const goal = optionalText(record.goal, '目标', 64 * 1024)
    if (!goal?.trim()) throw new Error('目标必填')
    const operationId = requiredId(record.operationId, 'operationId')
    const scope = authorizationScope(taskId, projectId, record.authorizationMode)
    const run = await goalExecutions.createRun({
      operationId,
      scope,
      goal,
      plan: [{ id: P2_EXECUTION_STEP_ID, label: '执行已授权工作并等待独立验证' }],
    })
    const started = await goalExecutions.startPlanStep({
      operationId: `${operationId}:start`,
      runId: run.id,
      scope,
      planStepId: P2_EXECUTION_STEP_ID,
    })
    await options.taskEventLedger.append({
      type: 'checkpoint.created',
      taskId,
      projectId,
      runId: sourceRunId,
      source: 'system',
      idempotencyKey: `goal:${started.id}:created`,
      payload: {
        checkpoint: 'p2-goal-execution',
        goalRunId: started.id,
        authorizationMode: record.authorizationMode as string,
      },
    })
    return { run: started, scope }
  }

  const settleGoal = async (goalRunId: string, record: JsonRecord) => {
    const taskId = requiredId(record.taskId, 'taskId')
    const sourceRunId = requiredId(record.sourceRunId, 'sourceRunId')
    const projectId = await projectIdFrom(record.projectId, options)
    const scope = authorizationScope(taskId, projectId, record.authorizationMode)
    const operationId = requiredId(record.operationId, 'operationId')
    const events = await sourceRunEvents(options.taskEventLedger, taskId, sourceRunId)
    const terminal = sourceTerminal(events)
    if (!terminal) throw new Error('任务账本尚未记录终态')
    let run = await goalExecutions.getRun({ runId: goalRunId, scope })
    if (terminal.type === 'run.cancelled') {
      if (run.state !== 'cancelled') {
        const cancelling = await goalExecutions.requestCancellation({ operationId: `${operationId}:cancel`, runId: goalRunId, scope })
        if (cancelling.state === 'cancelling') run = await goalExecutions.acknowledgeCancellation({ operationId: `${operationId}:cancel-ack`, runId: goalRunId, scope })
      }
      return run
    }
    const step = firstActiveStep(run)
    if (!step) return run
    if (step.state === 'running') {
      run = await goalExecutions.recordAgentClaim({
        operationId: `${operationId}:agent-claim`,
        runId: goalRunId,
        scope,
        planStepId: step.id,
        claimId: terminal.eventId,
      })
    }
    const verifying = firstActiveStep(run)
    if (!verifying || verifying.state !== 'verifying') return run
    return goalExecutions.recordVerifierReceipt({
      operationId: `${operationId}:verification`,
      runId: goalRunId,
      scope,
      planStepId: verifying.id,
      receipt: goalReceipt(terminal, sourceVerification(events), verifying.id),
    })
  }

  const middleware: P2ControlPlane['middleware'] = async (request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const method = request.method ?? 'GET'
    const pathname = url.pathname
    const sendFailure = (error: unknown) => sendJson(response, clientErrorStatus(error), { error: safeError(error) })

    try {
      if (pathname === '/api/providers' && method === 'GET') {
        const snapshot = await options.providerRegistry.snapshot()
        sendJson(response, 200, { registry: snapshot, health: await options.providerRegistry.health(options.getRuntimeModelAvailability()) })
        return
      }
      if (pathname === '/api/providers' && method === 'POST') {
        const provider = await options.providerRegistry.register(await readJsonBody(request))
        sendJson(response, 201, { provider })
        return
      }
      const providerMatch = pathname.match(/^\/api\/providers\/([a-z][a-z0-9-]{1,63})$/)
      if (providerMatch && method === 'PATCH') {
        const body = await readJsonBody(request)
        sendJson(response, 200, { provider: await options.providerRegistry.setEnabled(providerMatch[1], body.enabled) })
        return
      }
      if (providerMatch && method === 'DELETE') {
        const removed = await options.providerRegistry.remove(providerMatch[1])
        sendJson(response, removed ? 200 : 404, removed ? { removed: true } : { error: 'Provider 不存在' })
        return
      }
      if (pathname === '/api/providers/select' && method === 'POST') {
        const body = await readJsonBody(request)
        const requiredCapabilities = body.requiredCapabilities as ProviderCapability[] | undefined
        const selection = await options.providerRegistry.select(options.getRuntimeModelAvailability(), {
          providerId: body.providerId as string | undefined,
          modelId: body.modelId as string | undefined,
          requiredCapabilities,
        })
        sendJson(response, selection.ok ? 200 : 409, { selection })
        return
      }

      if (pathname === '/api/memories' && method === 'GET') {
        await reconcileSourcedMemories()
        const scope = memoryScopeFor(await projectIdFrom(url.searchParams.get('projectId'), options))
        const records = await memoryStore.list({
          scope,
          includeUserScoped: url.searchParams.get('includeUserScoped') === 'true',
          includeStatuses: statuses(url.searchParams.get('statuses')),
          limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
        })
        sendJson(response, 200, { memories: records })
        return
      }
      if (pathname === '/api/memories' && method === 'POST') {
        await reconcileSourcedMemories()
        const result = await writeMemory(await readJsonBody(request))
        sendJson(response, result.appended ? 201 : 200, { memory: result.record, appended: result.appended })
        return
      }
      if (pathname === '/api/memories/context' && method === 'POST') {
        // Never inject a recovered memory into a prompt before its durable
        // proposal/store/commit chain has been reconciled.
        await reconcileSourcedMemories()
        const body = await readJsonBody(request)
        const scope = await resolveScopeFromRecord(body)
        const query = optionalText(body.query, 'memory query', MAX_CONTEXT_QUERY_CHARS)
        if (!query?.trim()) throw new Error('memory query 必填')
        const currentSessionSummary = optionalText(body.currentSessionSummary, '会话摘要', MAX_CONTEXT_SUMMARY_CHARS)
        const maxChars = body.maxChars === undefined ? undefined : optionalNumber(body.maxChars, 'memory context budget')
        const candidates = await memoryStore.list({ scope, includeStatuses: ['active'], includeUserScoped: true, limit: 1_000 })
        const retrievedMemories = await retrieveSemanticMemories(semanticAdapter, {
          scope,
          query,
          candidates,
          includeUserScoped: true,
          includeRestricted: false,
          limit: 12,
        })
        const context = buildDeterministicMemoryContext({
          scope,
          projectRules: await options.projectRules(scope.projectId),
          currentSessionSummary,
          facts: candidates.filter((memory) => memory.pinned),
          retrievedMemories,
          maxChars,
          includeUserScoped: true,
          includeRestricted: false,
        })
        sendJson(response, 200, { adapter: semanticAdapter.name, context })
        return
      }
      const memoryMatch = pathname.match(/^\/api\/memories\/(mem_[a-f0-9]{64})$/)
      if (memoryMatch && method === 'PATCH') {
        const body = await readJsonBody(request)
        const scope = await resolveScopeFromRecord(body)
        const memory = await memoryStore.edit({
          scope,
          id: memoryMatch[1],
          reason: body.reason as string,
          title: optionalText(body.title, 'memory title', 512),
          fact: optionalText(body.fact, 'memory fact', 24 * 1024),
          confidence: optionalNumber(body.confidence, 'memory confidence'),
          sensitivity: body.sensitivity as MemoryWriteInput['sensitivity'] | undefined,
          pinned: optionalBoolean(body.pinned, 'memory pinned'),
          // A project page may read global preferences, but it cannot mutate
          // them. Manage global records only from the root memory scope.
          includeUserScoped: false,
        })
        sendJson(response, 200, { memory })
        return
      }
      if (memoryMatch && method === 'DELETE') {
        const body = await readJsonBody(request)
        const scope = await resolveScopeFromRecord(body)
        const memory = await memoryStore.delete({ scope, id: memoryMatch[1], reason: body.reason as string, includeUserScoped: false })
        sendJson(response, 200, { memory })
        return
      }
      const memoryStatusMatch = pathname.match(/^\/api\/memories\/(mem_[a-f0-9]{64})\/status$/)
      if (memoryStatusMatch && method === 'POST') {
        const body = await readJsonBody(request)
        const scope = await resolveScopeFromRecord(body)
        const memory = await memoryStore.setStatus({
          scope,
          id: memoryStatusMatch[1],
          status: body.status as MemoryStatus,
          reason: body.reason as string,
          supersededById: body.supersededById as string | undefined,
          includeUserScoped: false,
        })
        sendJson(response, 200, { memory })
        return
      }

      if (pathname === '/api/goal-executions' && method === 'POST') {
        const created = await createGoal(await readJsonBody(request))
        sendJson(response, 201, { goal: projectGoalExecutionRun(created.run) })
        return
      }
      const goalMatch = pathname.match(/^\/api\/goal-executions\/(goal_run_[A-Za-z0-9._:-]+)$/)
      if (goalMatch && method === 'GET') {
        const taskId = requiredId(url.searchParams.get('taskId'), 'taskId')
        const projectId = await projectIdFrom(url.searchParams.get('projectId'), options)
        const scope = authorizationScope(taskId, projectId, url.searchParams.get('authorizationMode'))
        sendJson(response, 200, { goal: projectGoalExecutionRun(await goalExecutions.getRun({ runId: goalMatch[1], scope })) })
        return
      }
      const goalSettleMatch = pathname.match(/^\/api\/goal-executions\/(goal_run_[A-Za-z0-9._:-]+)\/settle$/)
      if (goalSettleMatch && method === 'POST') {
        const run = await settleGoal(goalSettleMatch[1], await readJsonBody(request))
        sendJson(response, 200, { goal: projectGoalExecutionRun(run) })
        return
      }
      const goalRecoveryMatch = pathname.match(/^\/api\/goal-executions\/(goal_run_[A-Za-z0-9._:-]+)\/recover$/)
      if (goalRecoveryMatch && method === 'POST') {
        const body = await readJsonBody(request)
        const taskId = requiredId(body.taskId, 'taskId')
        const projectId = await projectIdFrom(body.projectId, options)
        const scope = authorizationScope(taskId, projectId, body.authorizationMode)
        const recovery = await goalExecutions.recoverRun({ operationId: requiredId(body.operationId, 'operationId'), runId: goalRecoveryMatch[1], scope })
        sendJson(response, 200, { goal: projectGoalExecutionRun(recovery.run), action: recovery.action })
        return
      }
      const goalSubagentsMatch = pathname.match(/^\/api\/goal-executions\/(goal_run_[A-Za-z0-9._:-]+)\/subagents$/)
      if (goalSubagentsMatch && method === 'GET') {
        const taskId = requiredId(url.searchParams.get('taskId'), 'taskId')
        const projectId = await projectIdFrom(url.searchParams.get('projectId'), options)
        const scope = authorizationScope(taskId, projectId, url.searchParams.get('authorizationMode'))
        const runs = await subagents.listForParent({ parentRunId: goalSubagentsMatch[1], parentScope: scope })
        sendJson(response, 200, { subagents: runs.map((run) => projectSubagentRun(run)) })
        return
      }
      if (goalSubagentsMatch && method === 'POST') {
        const body = await readJsonBody(request)
        const taskId = requiredId(body.taskId, 'taskId')
        const projectId = await projectIdFrom(body.projectId, options)
        const scope = authorizationScope(taskId, projectId, body.authorizationMode)
        // P2 intentionally exposes the synchronous queue only.  Parallel
        // execution needs a separately reviewed ACP effect adapter.
        if (body.executionMode !== undefined && body.executionMode !== 'synchronous') throw new Error('P2 仅支持同步子代理')
        await goalExecutions.getRun({ runId: goalSubagentsMatch[1], scope })
        const run = await subagents.start({
          operationId: requiredId(body.operationId, 'operationId'),
          parentRunId: goalSubagentsMatch[1],
          parentScope: scope,
          requestedGrantIds: body.requestedGrantIds as string[] | undefined,
          executionMode: 'synchronous',
        })
        sendJson(response, 201, { subagent: projectSubagentRun(run) })
        return
      }
      const subagentActionMatch = pathname.match(/^\/api\/goal-executions\/(goal_run_[A-Za-z0-9._:-]+)\/subagents\/(sub_run_[A-Za-z0-9._:-]+)\/(report|disconnect|recover|cancel|acknowledge-cancel)$/)
      if (subagentActionMatch && method === 'POST') {
        const body = await readJsonBody(request)
        const taskId = requiredId(body.taskId, 'taskId')
        const projectId = await projectIdFrom(body.projectId, options)
        const parentScope = authorizationScope(taskId, projectId, body.authorizationMode)
        const parentRunId = subagentActionMatch[1]
        const subagentRunId = subagentActionMatch[2]
        const operationId = requiredId(body.operationId, 'operationId')
        const boundary = { parentRunId, parentScope, subagentRunId, operationId }
        if (subagentActionMatch[3] === 'report') {
          const run = await subagents.recordAgentReport({ ...boundary, claimId: requiredId(body.claimId, 'claimId') })
          sendJson(response, 200, { subagent: projectSubagentRun(run) })
          return
        }
        if (subagentActionMatch[3] === 'disconnect') {
          const run = await subagents.markDisconnected(boundary)
          sendJson(response, 200, { subagent: projectSubagentRun(run) })
          return
        }
        if (subagentActionMatch[3] === 'recover') {
          const recovery = await subagents.recover(boundary)
          sendJson(response, 200, { subagent: projectSubagentRun(recovery.run), action: recovery.action })
          return
        }
        if (subagentActionMatch[3] === 'cancel') {
          const run = await subagents.requestCancellation(boundary)
          sendJson(response, 200, { subagent: projectSubagentRun(run) })
          return
        }
        const run = await subagents.acknowledgeCancellation(boundary)
        sendJson(response, 200, { subagent: projectSubagentRun(run) })
        return
      }
    } catch (error) {
      sendFailure(error)
      return
    }
    next()
  }

  return { memoryStore, goalExecutions, subagents, reconcileSourcedMemories, middleware }
}
