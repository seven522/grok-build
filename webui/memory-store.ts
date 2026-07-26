import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

/**
 * Durable, inspectable facts only.  This module deliberately has no import
 * from task-event-ledger.ts: a ledger is an immutable session history, while
 * a memory is a user-editable fact whose provenance merely points back to one
 * or more opaque source event IDs.
 */
export const MEMORY_SCHEMA = 'runbuild.memory.v1' as const
export const MAX_MEMORY_FACT_BYTES = 24 * 1024
export const MAX_MEMORY_TITLE_BYTES = 512
export const MAX_MEMORY_RECORDS = 10_000
export const MAX_MEMORY_STATE_BYTES = 8 * 1024 * 1024

const MAX_IDENTIFIER_LENGTH = 512
const MAX_IDEMPOTENCY_KEY_LENGTH = 1_024
const MAX_SOURCE_EVENT_IDS = 32
const MAX_AUDIT_ENTRIES = 64
const MAX_AUDIT_NOTE_BYTES = 1_024
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const memoryIdPattern = /^mem_[a-f0-9]{64}$/

export const memoryWritePaths = [
  'remember',
  'accepted-decision',
  'verified-fault-cause',
  'successful-checkpoint',
] as const

export const memoryStatuses = ['active', 'superseded', 'disputed', 'deleted'] as const
export const memorySensitivities = ['normal', 'sensitive', 'restricted'] as const

export type MemoryWritePath = (typeof memoryWritePaths)[number]
export type MemoryStatus = (typeof memoryStatuses)[number]
export type MemorySensitivity = (typeof memorySensitivities)[number]

export type MemoryScope = {
  userId: string
  projectId: string | null
  agentId: string | null
  runId: string | null
}

export type MemoryProvenance = {
  /** Opaque IDs only; the source event payload remains in the session ledger. */
  sourceEventIds: string[]
  sourceTaskId: string | null
  sourceRunId: string | null
}

export type MemoryAuditEntry = {
  at: string
  action: 'created' | 'edited' | 'status-changed' | 'deleted'
  reason?: string
  previousStatus?: MemoryStatus
  previousFactSha256?: string
}

export type MemoryRecord = {
  schema: typeof MEMORY_SCHEMA
  id: string
  idempotencyKey: string
  writePath: MemoryWritePath
  scope: MemoryScope
  provenance: MemoryProvenance
  title: string
  fact: string
  status: MemoryStatus
  confidence: number
  sensitivity: MemorySensitivity
  pinned: boolean
  redacted: boolean
  revision: number
  createdAt: string
  updatedAt: string
  statusChangedAt: string
  supersededById?: string
  deletedAt?: string
  audit: MemoryAuditEntry[]
}

export type MemoryWriteInput = {
  scope: MemoryScope
  provenance: MemoryProvenance
  title: string
  fact: string
  confidence?: number
  sensitivity?: MemorySensitivity
  pinned?: boolean
  /** Optional stable key lets a replay return the original fact instead of duplicating it. */
  idempotencyKey?: string
}

export type MemoryListOptions = {
  scope: MemoryScope
  includeStatuses?: readonly MemoryStatus[]
  includeUserScoped?: boolean
  sourceEventId?: string
  limit?: number
}

export type MemoryGetOptions = {
  scope: MemoryScope
  id: string
  includeDeleted?: boolean
  includeUserScoped?: boolean
}

export type MemoryEditInput = {
  scope: MemoryScope
  id: string
  reason: string
  title?: string
  fact?: string
  confidence?: number
  sensitivity?: MemorySensitivity
  pinned?: boolean
  includeUserScoped?: boolean
}

export type MemoryStatusInput = {
  scope: MemoryScope
  id: string
  status: MemoryStatus
  reason: string
  supersededById?: string
  includeUserScoped?: boolean
}

export type MemoryDeleteInput = {
  scope: MemoryScope
  id: string
  reason: string
  includeUserScoped?: boolean
}

export type MemoryWriteResult = {
  record: MemoryRecord
  appended: boolean
}

export type MemoryStore = {
  storageDir: string
  statePath: string
  remember: (input: MemoryWriteInput) => Promise<MemoryWriteResult>
  recordAcceptedDecision: (input: MemoryWriteInput) => Promise<MemoryWriteResult>
  recordVerifiedFaultCause: (input: MemoryWriteInput) => Promise<MemoryWriteResult>
  recordSuccessfulCheckpoint: (input: MemoryWriteInput) => Promise<MemoryWriteResult>
  list: (options: MemoryListOptions) => Promise<MemoryRecord[]>
  get: (options: MemoryGetOptions) => Promise<MemoryRecord>
  edit: (input: MemoryEditInput) => Promise<MemoryRecord>
  setStatus: (input: MemoryStatusInput) => Promise<MemoryRecord>
  delete: (input: MemoryDeleteInput) => Promise<MemoryRecord>
}

type MemoryFile = {
  schema: typeof MEMORY_SCHEMA
  records: MemoryRecord[]
}

type RedactedText = {
  text: string
  redacted: boolean
}

export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryValidationError'
  }
}

export class MemoryConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryConflictError'
  }
}

export class MemoryNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryNotFoundError'
  }
}

const plainObject = (value: unknown): value is Record<string, unknown> => Boolean(
  value
  && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
)

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : ''

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

const validIdentifier = (value: unknown, label: string, nullable = false): string | null => {
  if (nullable && value === null) return null
  if (
    typeof value !== 'string'
    || !value
    || value.length > MAX_IDENTIFIER_LENGTH
    || CONTROL_CHARACTERS.test(value)
    || value.includes('/')
    || value.includes('\\')
  ) throw new MemoryValidationError(`${label} 无效`)
  return value
}

const opaqueSourceEventId = (value: unknown): string => {
  const sourceEventId = validIdentifier(value, 'sourceEventId') as string
  if (!/^[A-Za-z0-9._:-]+$/.test(sourceEventId)) throw new MemoryValidationError('sourceEventId 必须是安全的不透明标识')
  return sourceEventId
}

const canonicalTimestamp = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new MemoryValidationError(`${label} 无效`)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) throw new MemoryValidationError(`${label} 无效`)
  return parsed.toISOString()
}

const status = (value: unknown): MemoryStatus => {
  if ((memoryStatuses as readonly unknown[]).includes(value)) return value as MemoryStatus
  throw new MemoryValidationError('memory status 无效')
}

const sensitivity = (value: unknown): MemorySensitivity => {
  if ((memorySensitivities as readonly unknown[]).includes(value)) return value as MemorySensitivity
  throw new MemoryValidationError('memory sensitivity 无效')
}

const confidence = (value: unknown, fallback = 0.75): number => {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new MemoryValidationError('memory confidence 必须在 0 到 1 之间')
  return Math.round(value * 1_000) / 1_000
}

const flag = (value: unknown, fallback = false): boolean => {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new MemoryValidationError('memory pinned 无效')
  return value
}

const normalizedText = (value: unknown, label: string, maxBytes: number, options: { multiline?: boolean } = {}): RedactedText => {
  if (typeof value !== 'string' || value.includes('\0')) throw new MemoryValidationError(`${label} 无效`)
  if (!options.multiline && /[\r\n]/.test(value)) throw new MemoryValidationError(`${label} 不能包含换行`)
  const redaction = redactMemoryText(value)
  const result = redaction.text.trim()
  if (!result || Buffer.byteLength(result, 'utf8') > maxBytes) throw new MemoryValidationError(`${label} 超过限制或为空`)
  return { text: result, redacted: redaction.redacted || result !== value.trim() }
}

/**
 * Redacts values commonly found in .env files, JSON credentials, bearer
 * headers, and well-known API-key formats.  The original is never returned or
 * persisted by this module.
 */
export const redactMemoryText = (value: string): RedactedText => {
  let text = value.normalize('NFKC')
  let redacted = false
  const replace = (pattern: RegExp, replacement: string | ((substring: string, ...args: string[]) => string)) => {
    text = text.replace(pattern, (...args: string[]) => {
      redacted = true
      return typeof replacement === 'function' ? replacement(args[0] ?? '', ...args.slice(1)) : replacement
    })
  }

  // Key names are retained for diagnosis, but their values never become a fact.
  replace(/((?:["']?[A-Za-z_][A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|AUTHORIZATION|CREDENTIAL|CONNECTION[_-]?STRING|DATABASE[_-]?URL|REDIS[_-]?URL)[A-Za-z0-9_]*["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,\s}\]\r\n;]+)/gi, (_match, prefix) => `${prefix}[REDACTED]`)
  replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [REDACTED]')
  replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[REDACTED PRIVATE KEY]')
  replace(/\b(?:sk|xai|ghp|github_pat|AKIA|AIza)[-_A-Za-z0-9]{8,}\b/g, '[REDACTED]')
  return { text, redacted }
}

export const normalizeMemoryScope = (value: unknown): MemoryScope => {
  if (!plainObject(value)) throw new MemoryValidationError('memory scope 无效')
  return {
    userId: validIdentifier(value.userId, 'userId') as string,
    projectId: validIdentifier(value.projectId, 'projectId', true),
    agentId: validIdentifier(value.agentId, 'agentId', true),
    runId: validIdentifier(value.runId, 'runId', true),
  }
}

const normalizeProvenance = (value: unknown): MemoryProvenance => {
  if (!plainObject(value) || !Array.isArray(value.sourceEventIds)) throw new MemoryValidationError('memory provenance 无效')
  if (!value.sourceEventIds.length || value.sourceEventIds.length > MAX_SOURCE_EVENT_IDS) throw new MemoryValidationError('sourceEventIds 数量无效')
  const sourceEventIds = value.sourceEventIds.map(opaqueSourceEventId)
  if (new Set(sourceEventIds).size !== sourceEventIds.length) throw new MemoryValidationError('sourceEventIds 不能重复')
  return {
    sourceEventIds,
    sourceTaskId: validIdentifier(value.sourceTaskId, 'sourceTaskId', true),
    sourceRunId: validIdentifier(value.sourceRunId, 'sourceRunId', true),
  }
}

const normalizedIdempotencyKey = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > MAX_IDEMPOTENCY_KEY_LENGTH || CONTROL_CHARACTERS.test(value)) {
    throw new MemoryValidationError('memory idempotencyKey 无效')
  }
  return value
}

const normalizedAudit = (value: unknown): MemoryAuditEntry[] => {
  if (!Array.isArray(value) || value.length > MAX_AUDIT_ENTRIES) throw new MemoryValidationError('memory audit 无效')
  return value.map((entry) => {
    if (!plainObject(entry)) throw new MemoryValidationError('memory audit 条目无效')
    const action = entry.action
    if (action !== 'created' && action !== 'edited' && action !== 'status-changed' && action !== 'deleted') {
      throw new MemoryValidationError('memory audit action 无效')
    }
    const reason = entry.reason === undefined ? undefined : normalizedText(entry.reason, 'memory audit reason', MAX_AUDIT_NOTE_BYTES, { multiline: true }).text
    const previousStatus = entry.previousStatus === undefined ? undefined : status(entry.previousStatus)
    const previousFactSha256 = entry.previousFactSha256 === undefined ? undefined : String(entry.previousFactSha256)
    if (previousFactSha256 !== undefined && !/^[a-f0-9]{64}$/.test(previousFactSha256)) throw new MemoryValidationError('memory audit hash 无效')
    return {
      at: canonicalTimestamp(entry.at, 'memory audit timestamp'),
      action,
      ...(reason ? { reason } : {}),
      ...(previousStatus ? { previousStatus } : {}),
      ...(previousFactSha256 ? { previousFactSha256 } : {}),
    }
  })
}

const normalizedRecord = (value: unknown): MemoryRecord => {
  if (!plainObject(value) || value.schema !== MEMORY_SCHEMA) throw new MemoryValidationError('memory record schema 无效')
  if (typeof value.id !== 'string' || !memoryIdPattern.test(value.id)) throw new MemoryValidationError('memory id 无效')
  const title = normalizedText(value.title, 'memory title', MAX_MEMORY_TITLE_BYTES)
  const fact = normalizedText(value.fact, 'memory fact', MAX_MEMORY_FACT_BYTES, { multiline: true })
  if (typeof value.redacted !== 'boolean' || typeof value.pinned !== 'boolean') throw new MemoryValidationError('memory flag 无效')
  const revision = value.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) throw new MemoryValidationError('memory revision 无效')
  const createdAt = canonicalTimestamp(value.createdAt, 'memory createdAt')
  const updatedAt = canonicalTimestamp(value.updatedAt, 'memory updatedAt')
  const statusChangedAt = canonicalTimestamp(value.statusChangedAt, 'memory statusChangedAt')
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new MemoryValidationError('memory 时间顺序无效')
  const supersededById = value.supersededById === undefined ? undefined : String(value.supersededById)
  if (supersededById !== undefined && !memoryIdPattern.test(supersededById)) throw new MemoryValidationError('supersededById 无效')
  const deletedAt = value.deletedAt === undefined ? undefined : canonicalTimestamp(value.deletedAt, 'memory deletedAt')
  const recordStatus = status(value.status)
  if (recordStatus === 'superseded' && !supersededById) throw new MemoryValidationError('superseded memory 必须指向替代记录')
  if (recordStatus === 'deleted' && !deletedAt) throw new MemoryValidationError('deleted memory 必须记录删除时间')
  return {
    schema: MEMORY_SCHEMA,
    id: value.id,
    idempotencyKey: normalizedIdempotencyKey(value.idempotencyKey),
    writePath: writePath(value.writePath),
    scope: normalizeMemoryScope(value.scope),
    provenance: normalizeProvenance(value.provenance),
    title: title.text,
    fact: fact.text,
    status: recordStatus,
    confidence: confidence(value.confidence),
    sensitivity: sensitivity(value.sensitivity),
    pinned: value.pinned,
    redacted: value.redacted || title.redacted || fact.redacted,
    revision,
    createdAt,
    updatedAt,
    statusChangedAt,
    ...(supersededById ? { supersededById } : {}),
    ...(deletedAt ? { deletedAt } : {}),
    audit: normalizedAudit(value.audit),
  }
}

const writePath = (value: unknown): MemoryWritePath => {
  if ((memoryWritePaths as readonly unknown[]).includes(value)) return value as MemoryWritePath
  throw new MemoryValidationError('memory writePath 无效')
}

const emptyFile = (): MemoryFile => ({ schema: MEMORY_SCHEMA, records: [] })

const normalizedFile = (value: unknown): MemoryFile => {
  if (!plainObject(value) || value.schema !== MEMORY_SCHEMA || !Array.isArray(value.records)) throw new MemoryValidationError('memory state 文件无效')
  if (value.records.length > MAX_MEMORY_RECORDS) throw new MemoryValidationError('memory record 数量超过限制')
  const records = value.records.map(normalizedRecord)
  if (new Set(records.map((record) => record.id)).size !== records.length) throw new MemoryValidationError('memory id 重复')
  return { schema: MEMORY_SCHEMA, records }
}

const sameScope = (left: MemoryScope, right: MemoryScope) => (
  left.userId === right.userId
  && left.projectId === right.projectId
  && left.agentId === right.agentId
  && left.runId === right.runId
)

/**
 * A project-specific fact can never become visible in another project.  A
 * caller may opt in to user-scoped (project=null) facts; this is deliberately
 * false by default so a context build cannot silently broaden its scope.
 */
export const memoryScopeAllows = (
  recordScope: MemoryScope,
  requestedScope: MemoryScope,
  options: { includeUserScoped?: boolean } = {},
): boolean => {
  const record = normalizeMemoryScope(recordScope)
  const requested = normalizeMemoryScope(requestedScope)
  if (record.userId !== requested.userId) return false
  if (record.projectId !== requested.projectId) {
    if (!(options.includeUserScoped === true && record.projectId === null)) return false
  }
  if (record.agentId !== null && record.agentId !== requested.agentId) return false
  if (record.runId !== null && record.runId !== requested.runId) return false
  return true
}

const memoryIdFor = (scope: MemoryScope, pathName: MemoryWritePath, idempotencyKey: string) => {
  const scopeKey = JSON.stringify([scope.userId, scope.projectId, scope.agentId, scope.runId])
  return `mem_${sha256(`${MEMORY_SCHEMA}\0${scopeKey}\0${pathName}\0${idempotencyKey}`)}`
}

const derivedIdempotencyKey = (pathName: MemoryWritePath, input: Omit<MemoryWriteInput, 'idempotencyKey'>, title: string, fact: string) => (
  `derived:${sha256(JSON.stringify({ pathName, scope: input.scope, provenance: input.provenance, title, fact }))}`
)

const recordSort = (left: MemoryRecord, right: MemoryRecord) => (
  Number(right.pinned) - Number(left.pinned)
  || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  || left.id.localeCompare(right.id)
)

const sameInitialRecord = (existing: MemoryRecord, candidate: MemoryRecord) => (
  existing.id === candidate.id
  && existing.idempotencyKey === candidate.idempotencyKey
  && existing.writePath === candidate.writePath
  && sameScope(existing.scope, candidate.scope)
  && JSON.stringify(existing.provenance) === JSON.stringify(candidate.provenance)
  && existing.title === candidate.title
  && existing.fact === candidate.fact
  && existing.confidence === candidate.confidence
  && existing.sensitivity === candidate.sensitivity
  && existing.pinned === candidate.pinned
)

const appendAudit = (record: MemoryRecord, entry: MemoryAuditEntry) => {
  record.audit = [...record.audit, entry].slice(-MAX_AUDIT_ENTRIES)
}

const safeDirectory = async (directory: string, label: string) => {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const metadata = await lstat(directory)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new MemoryValidationError(`${label} 必须是普通文件夹`)
  try { await chmod(directory, 0o700) } catch { /* Filesystems without POSIX modes remain usable. */ }
  return path.resolve(directory)
}

const visible = (record: MemoryRecord, scope: MemoryScope, includeUserScoped: boolean) => (
  memoryScopeAllows(record.scope, scope, { includeUserScoped })
)

export function createMemoryStore(options: { storageDir: string }): MemoryStore {
  const storageDir = path.resolve(options.storageDir)
  const statePath = path.join(storageDir, 'state.json')
  let operationQueue: Promise<void> = Promise.resolve()

  const serialize = <T>(operation: () => Promise<T>) => {
    const result = operationQueue.then(operation, operation)
    operationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  const ensureStorage = async () => {
    await safeDirectory(storageDir, 'memory 目录')
  }

  const readState = async (): Promise<MemoryFile> => {
    await ensureStorage()
    try {
      const metadata = await lstat(statePath)
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_MEMORY_STATE_BYTES || (metadata.mode & 0o077) !== 0) {
        throw new MemoryValidationError('memory state 文件不安全')
      }
      return normalizedFile(JSON.parse(await readFile(statePath, 'utf8')) as unknown)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return emptyFile()
      throw error
    }
  }

  const persistState = async (state: MemoryFile) => {
    const normalized = normalizedFile(state)
    const serialized = `${JSON.stringify(normalized, null, 2)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > MAX_MEMORY_STATE_BYTES) throw new MemoryValidationError('memory state 超过大小限制')
    const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(serialized, 'utf8')
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

  const buildRecord = (pathName: MemoryWritePath, input: MemoryWriteInput): MemoryRecord => {
    const scope = normalizeMemoryScope(input.scope)
    const provenance = normalizeProvenance(input.provenance)
    const title = normalizedText(input.title, 'memory title', MAX_MEMORY_TITLE_BYTES)
    const fact = normalizedText(input.fact, 'memory fact', MAX_MEMORY_FACT_BYTES, { multiline: true })
    const idempotencyKey = input.idempotencyKey === undefined
      ? derivedIdempotencyKey(pathName, { ...input, scope, provenance }, title.text, fact.text)
      : normalizedIdempotencyKey(input.idempotencyKey)
    const now = new Date().toISOString()
    return {
      schema: MEMORY_SCHEMA,
      id: memoryIdFor(scope, pathName, idempotencyKey),
      idempotencyKey,
      writePath: pathName,
      scope,
      provenance,
      title: title.text,
      fact: fact.text,
      status: 'active',
      confidence: confidence(input.confidence),
      sensitivity: sensitivity(input.sensitivity ?? 'normal'),
      pinned: flag(input.pinned),
      redacted: title.redacted || fact.redacted,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      statusChangedAt: now,
      audit: [{ at: now, action: 'created' }],
    }
  }

  const write = (pathName: MemoryWritePath, input: MemoryWriteInput) => serialize(async (): Promise<MemoryWriteResult> => {
    const state = await readState()
    const candidate = buildRecord(pathName, input)
    const existing = state.records.find((record) => record.id === candidate.id)
    if (existing) {
      if (!sameInitialRecord(existing, candidate)) throw new MemoryConflictError('memory idempotencyKey 已用于不同事实')
      return { record: clone(existing), appended: false }
    }
    if (state.records.length >= MAX_MEMORY_RECORDS) throw new MemoryValidationError('memory record 数量超过限制')
    state.records.push(candidate)
    await persistState(state)
    return { record: clone(candidate), appended: true }
  })

  const locate = (state: MemoryFile, scope: MemoryScope, id: string, options: { includeDeleted?: boolean; includeUserScoped?: boolean } = {}) => {
    if (typeof id !== 'string' || !memoryIdPattern.test(id)) throw new MemoryValidationError('memory id 无效')
    const record = state.records.find((item) => item.id === id)
    if (!record || !visible(record, scope, options.includeUserScoped === true) || (!options.includeDeleted && record.status === 'deleted')) {
      // Do not disclose whether a record exists in another project scope.
      throw new MemoryNotFoundError('memory 未找到')
    }
    return record
  }

  const get = (options: MemoryGetOptions) => serialize(async () => {
    const scope = normalizeMemoryScope(options.scope)
    const state = await readState()
    return clone(locate(state, scope, options.id, options))
  })

  const list = (options: MemoryListOptions) => serialize(async () => {
    const scope = normalizeMemoryScope(options.scope)
    const statuses = options.includeStatuses === undefined ? ['active'] as MemoryStatus[] : [...options.includeStatuses].map(status)
    const allowedStatuses = new Set(statuses)
    const limit = options.limit === undefined ? 200 : options.limit
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new MemoryValidationError('memory list limit 必须在 1 到 1000 之间')
    const sourceEventId = options.sourceEventId === undefined ? undefined : opaqueSourceEventId(options.sourceEventId)
    const state = await readState()
    return state.records
      .filter((record) => visible(record, scope, options.includeUserScoped === true))
      .filter((record) => allowedStatuses.has(record.status))
      .filter((record) => sourceEventId === undefined || record.provenance.sourceEventIds.includes(sourceEventId))
      .sort(recordSort)
      .slice(0, limit)
      .map(clone)
  })

  const edit = (input: MemoryEditInput) => serialize(async () => {
    const scope = normalizeMemoryScope(input.scope)
    const reason = normalizedText(input.reason, 'memory edit reason', MAX_AUDIT_NOTE_BYTES, { multiline: true })
    const noChanges = input.title === undefined
      && input.fact === undefined
      && input.confidence === undefined
      && input.sensitivity === undefined
      && input.pinned === undefined
    if (noChanges) throw new MemoryValidationError('memory edit 必须包含至少一个修改')
    const state = await readState()
    const record = locate(state, scope, input.id, { includeUserScoped: input.includeUserScoped })
    if (record.status === 'deleted') throw new MemoryConflictError('已删除 memory 不能编辑')
    const oldFact = record.fact
    const title = input.title === undefined ? undefined : normalizedText(input.title, 'memory title', MAX_MEMORY_TITLE_BYTES)
    const fact = input.fact === undefined ? undefined : normalizedText(input.fact, 'memory fact', MAX_MEMORY_FACT_BYTES, { multiline: true })
    if (title) record.title = title.text
    if (fact) record.fact = fact.text
    if (input.confidence !== undefined) record.confidence = confidence(input.confidence)
    if (input.sensitivity !== undefined) record.sensitivity = sensitivity(input.sensitivity)
    if (input.pinned !== undefined) record.pinned = flag(input.pinned)
    record.redacted = record.redacted || reason.redacted || Boolean(title?.redacted) || Boolean(fact?.redacted)
    record.revision += 1
    record.updatedAt = new Date().toISOString()
    appendAudit(record, {
      at: record.updatedAt,
      action: 'edited',
      reason: reason.text,
      ...(fact ? { previousFactSha256: sha256(oldFact) } : {}),
    })
    await persistState(state)
    return clone(record)
  })

  const setStatus = (input: MemoryStatusInput) => serialize(async () => {
    const scope = normalizeMemoryScope(input.scope)
    const nextStatus = status(input.status)
    const reason = normalizedText(input.reason, 'memory status reason', MAX_AUDIT_NOTE_BYTES, { multiline: true })
    const state = await readState()
    const record = locate(state, scope, input.id, { includeDeleted: true, includeUserScoped: input.includeUserScoped })
    if (record.status === 'deleted' && nextStatus !== 'deleted') throw new MemoryConflictError('已删除 memory 不能恢复')
    let supersededById: string | undefined
    if (nextStatus === 'superseded') {
      if (typeof input.supersededById !== 'string' || !memoryIdPattern.test(input.supersededById)) throw new MemoryValidationError('superseded memory 必须提供替代记录')
      const replacement = state.records.find((item) => item.id === input.supersededById)
      if (!replacement || replacement.status === 'deleted' || replacement.scope.userId !== record.scope.userId || replacement.scope.projectId !== record.scope.projectId) {
        throw new MemoryValidationError('替代 memory 必须位于同一用户和项目作用域')
      }
      supersededById = replacement.id
    } else if (input.supersededById !== undefined) {
      throw new MemoryValidationError('仅 superseded memory 可以提供替代记录')
    }
    if (record.status === nextStatus && record.supersededById === supersededById) return clone(record)
    const now = new Date().toISOString()
    const previousStatus = record.status
    record.status = nextStatus
    record.statusChangedAt = now
    record.updatedAt = now
    record.revision += 1
    if (supersededById) record.supersededById = supersededById
    else delete record.supersededById
    if (nextStatus === 'deleted') record.deletedAt = now
    else delete record.deletedAt
    appendAudit(record, {
      at: now,
      action: nextStatus === 'deleted' ? 'deleted' : 'status-changed',
      reason: reason.text,
      previousStatus,
    })
    await persistState(state)
    return clone(record)
  })

  const remove = (input: MemoryDeleteInput) => setStatus({
    scope: input.scope,
    id: input.id,
    status: 'deleted',
    reason: input.reason,
    includeUserScoped: input.includeUserScoped,
  })

  return {
    storageDir,
    statePath,
    remember: (input) => write('remember', input),
    recordAcceptedDecision: (input) => write('accepted-decision', input),
    recordVerifiedFaultCause: (input) => write('verified-fault-cause', input),
    recordSuccessfulCheckpoint: (input) => write('successful-checkpoint', input),
    list,
    get,
    edit,
    setStatus,
    delete: remove,
  }
}
