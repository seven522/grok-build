import { createHash } from 'node:crypto'
import { mkdir, open, readFile, truncate } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

export const TASK_EVENT_SCHEMA = 'runbuild.task-event.v1' as const

export const taskEventTypes = [
  'task.created',
  'task.loaded',
  'task.archived',
  'state.changed',
  'cancel.requested',
  'checkpoint.created',
  'context.condensed',
  'memory.context.prepared',
  'memory.context.dispatched',
  'memory.proposed',
  'memory.committed',
  'message.user.created',
  'message.agent.delta',
  'message.agent.completed',
  'tool.requested',
  'tool.updated',
  'permission.requested',
  'permission.resolved',
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'verification.recorded',
] as const

export const taskEventSources = ['ui', 'acp', 'runner', 'system', 'verifier', 'automation'] as const

export type TaskEventType = (typeof taskEventTypes)[number]
export type TaskEventSource = (typeof taskEventSources)[number]
export type TaskEventJson = null | boolean | number | string | TaskEventJson[] | { [key: string]: TaskEventJson }
export type TaskEventPayload = { [key: string]: TaskEventJson }

export type TaskEvent = {
  schema: typeof TASK_EVENT_SCHEMA
  eventId: string
  type: TaskEventType
  taskId: string
  projectId: string | null
  runId: string | null
  sequence: number
  timestamp: string
  source: TaskEventSource
  idempotencyKey: string
  payload: TaskEventPayload
}

export type TaskEventAppendInput = {
  type: TaskEventType
  taskId: string
  projectId?: string | null
  runId?: string | null
  timestamp?: string
  source: TaskEventSource
  idempotencyKey: string
  payload?: TaskEventPayload
}

export type TaskEventReadOptions = {
  taskId: string
  afterSequence?: number
  limit?: number
}

export type TaskEventPage = {
  taskId: string
  events: TaskEvent[]
  nextSequence: number
}

export class TaskEventLedgerValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskEventLedgerValidationError'
  }
}

type StoredStream = {
  events: TaskEvent[]
  eventsById: Map<string, TaskEvent>
  nextSequence: number
  repairTailAt: number | null
  needsNewlinePrefix: boolean
}

export type TaskEventLedger = {
  storageDir: string
  append: (input: TaskEventAppendInput) => Promise<{ event: TaskEvent; appended: boolean }>
  read: (options: TaskEventReadOptions) => Promise<TaskEventPage>
  /** Direct lookup avoids treating a page-size limit as an evidence boundary. */
  findByEventId: (options: { taskId: string; eventId: string }) => Promise<TaskEvent | null>
}

const MAX_IDENTIFIER_LENGTH = 512
const MAX_IDEMPOTENCY_KEY_LENGTH = 1_024
const MAX_EVENT_BYTES = 128 * 1024
const DEFAULT_READ_LIMIT = 200
const MAX_READ_LIMIT = 1_000
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

const isTaskEventType = (value: unknown): value is TaskEventType => typeof value === 'string' && (taskEventTypes as readonly string[]).includes(value)
const isTaskEventSource = (value: unknown): value is TaskEventSource => typeof value === 'string' && (taskEventSources as readonly string[]).includes(value)

const readErrorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : ''

const identifier = (name: string, value: unknown, nullable = false): string | null => {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || !value || value.length > MAX_IDENTIFIER_LENGTH || CONTROL_CHARACTERS.test(value)) {
    throw new TaskEventLedgerValidationError(`${name} 无效`)
  }
  return value
}

const idempotencyKey = (value: unknown) => {
  if (typeof value !== 'string' || !value || value.length > MAX_IDEMPOTENCY_KEY_LENGTH || CONTROL_CHARACTERS.test(value)) {
    throw new TaskEventLedgerValidationError('idempotencyKey 无效')
  }
  return value
}

const timestamp = (value: unknown) => {
  if (value === undefined) return new Date().toISOString()
  if (typeof value !== 'string') throw new TaskEventLedgerValidationError('timestamp 无效')
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new TaskEventLedgerValidationError('timestamp 无效')
  return parsed.toISOString()
}

const jsonValue = (value: unknown, depth = 0): TaskEventJson => {
  if (depth > 24) throw new TaskEventLedgerValidationError('payload 嵌套层级过深')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TaskEventLedgerValidationError('payload 不能包含非有限数值')
    return value
  }
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, depth + 1))
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const result = Object.create(null) as TaskEventPayload
    for (const key of Object.keys(value).sort()) result[key] = jsonValue((value as Record<string, unknown>)[key], depth + 1)
    return result
  }
  throw new TaskEventLedgerValidationError('payload 必须是 JSON 值')
}

const payload = (value: unknown): TaskEventPayload => {
  if (value === undefined) return {}
  const normalized = jsonValue(value)
  if (!normalized || Array.isArray(normalized) || typeof normalized !== 'object') throw new TaskEventLedgerValidationError('payload 必须是 JSON 对象')
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_EVENT_BYTES) throw new TaskEventLedgerValidationError('payload 超过 128KB 限制')
  return normalized
}

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

const eventIdFor = (taskId: string, source: TaskEventSource, key: string) => `evt_${hash(`${TASK_EVENT_SCHEMA}\u0000${taskId}\u0000${source}\u0000${key}`)}`

const streamFile = (storageDir: string, taskId: string) => path.join(storageDir, 'streams', `${hash(taskId)}.jsonl`)

const clonedEvent = (event: TaskEvent): TaskEvent => JSON.parse(JSON.stringify(event)) as TaskEvent

// ACP can replay a source event after reconnecting.  Older P0 builds stored
// delivery-local fields alongside the durable source payload, so normalize
// those fields when comparing an existing record with a recovered delivery.
// The stored event itself remains immutable and readable as written.
const comparablePayload = (event: TaskEvent) => {
  if (event.source !== 'acp') return JSON.stringify(event.payload)
  const normalized = clonedEvent(event).payload
  const eventMeta = normalized.eventMeta
  if (eventMeta && !Array.isArray(eventMeta) && typeof eventMeta === 'object') {
    const meta = eventMeta as { [key: string]: TaskEventJson }
    delete meta.isReplay
    delete meta.agentTimestampMs
    delete meta.turnStartMs
  }
  return JSON.stringify(normalized)
}

const sameIdempotentEvent = (left: TaskEvent, right: TaskEvent) => (
  left.schema === right.schema
  && left.eventId === right.eventId
  && left.type === right.type
  && left.taskId === right.taskId
  && left.projectId === right.projectId
  && left.runId === right.runId
  && left.source === right.source
  && left.idempotencyKey === right.idempotencyKey
  && comparablePayload(left) === comparablePayload(right)
)

const normalizedAppend = (input: TaskEventAppendInput, sequence: number): TaskEvent => {
  if (!isTaskEventType(input.type)) throw new TaskEventLedgerValidationError('type 无效')
  if (!isTaskEventSource(input.source)) throw new TaskEventLedgerValidationError('source 无效')
  const taskId = identifier('taskId', input.taskId) as string
  const key = idempotencyKey(input.idempotencyKey)
  return {
    schema: TASK_EVENT_SCHEMA,
    eventId: eventIdFor(taskId, input.source, key),
    type: input.type,
    taskId,
    projectId: identifier('projectId', input.projectId ?? null, true),
    runId: identifier('runId', input.runId ?? null, true),
    sequence,
    timestamp: timestamp(input.timestamp),
    source: input.source,
    idempotencyKey: key,
    payload: payload(input.payload),
  }
}

const storedEvent = (value: unknown): TaskEvent => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('事件账本包含无效记录')
  const input = value as Record<string, unknown>
  if (input.schema !== TASK_EVENT_SCHEMA || !isTaskEventType(input.type) || !isTaskEventSource(input.source)) throw new Error('事件账本 schema 不受支持')
  const taskId = identifier('taskId', input.taskId) as string
  const key = idempotencyKey(input.idempotencyKey)
  const eventId = typeof input.eventId === 'string' ? input.eventId : ''
  if (eventId !== eventIdFor(taskId, input.source, key)) throw new Error('事件账本 eventId 不匹配')
  if (!Number.isSafeInteger(input.sequence) || Number(input.sequence) < 1) throw new Error('事件账本 sequence 无效')
  return {
    schema: TASK_EVENT_SCHEMA,
    eventId,
    type: input.type,
    taskId,
    projectId: identifier('projectId', input.projectId, true),
    runId: identifier('runId', input.runId, true),
    sequence: Number(input.sequence),
    timestamp: timestamp(input.timestamp),
    source: input.source,
    idempotencyKey: key,
    payload: payload(input.payload),
  }
}

const parseReadLimit = (value: number | undefined) => {
  if (value === undefined) return DEFAULT_READ_LIMIT
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_READ_LIMIT) throw new TaskEventLedgerValidationError(`limit 必须在 1 到 ${MAX_READ_LIMIT} 之间`)
  return value
}

const parseAfterSequence = (value: number | undefined) => {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) throw new TaskEventLedgerValidationError('afterSequence 无效')
  return value
}

const writeEvent = async (filePath: string, event: TaskEvent, needsNewlinePrefix: boolean) => {
  const handle = await open(filePath, 'a', 0o600)
  try {
    await handle.writeFile(`${needsNewlinePrefix ? '\n' : ''}${JSON.stringify(event)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export function createTaskEventLedger(options: { storageDir: string }): TaskEventLedger {
  const storageDir = path.resolve(options.storageDir)
  const streams = new Map<string, StoredStream>()
  let operationQueue: Promise<void> = Promise.resolve()

  const serialize = <T>(operation: () => Promise<T>) => {
    const result = operationQueue.then(operation, operation)
    operationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  const loadStream = async (taskId: string): Promise<StoredStream> => {
    const existing = streams.get(taskId)
    if (existing) return existing
    const filePath = streamFile(storageDir, taskId)
    let source = ''
    try {
      source = await readFile(filePath, 'utf8')
    } catch (error) {
      if (readErrorCode(error) !== 'ENOENT') throw error
    }
    const events: TaskEvent[] = []
    const eventsById = new Map<string, TaskEvent>()
    const lines = source.split('\n')
    const hasFinalNewline = source.endsWith('\n')
    let repairTailAt: number | null = null
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue
      let raw: unknown
      try {
        raw = JSON.parse(line) as unknown
      } catch (error) {
        if (index === lines.length - 1 && !hasFinalNewline) {
          repairTailAt = Buffer.byteLength(source.slice(0, source.lastIndexOf('\n') + 1), 'utf8')
          break
        }
        throw error
      }
      const event = storedEvent(raw)
      if (event.taskId !== taskId) throw new Error('事件账本 taskId 与存储流不匹配')
      if (event.sequence !== events.length + 1) throw new Error('事件账本 sequence 不连续')
      if (eventsById.has(event.eventId)) throw new Error('事件账本包含重复 eventId')
      events.push(event)
      eventsById.set(event.eventId, event)
    }
    const stream = {
      events,
      eventsById,
      nextSequence: events.length + 1,
      repairTailAt,
      needsNewlinePrefix: repairTailAt === null && source.length > 0 && !hasFinalNewline,
    }
    streams.set(taskId, stream)
    return stream
  }

  const append = (input: TaskEventAppendInput) => serialize(async () => {
    const taskId = identifier('taskId', input.taskId) as string
    const stream = await loadStream(taskId)
    const candidate = normalizedAppend(input, stream.nextSequence)
    const existing = stream.eventsById.get(candidate.eventId)
    if (existing) {
      if (!sameIdempotentEvent(existing, candidate)) throw new TaskEventLedgerValidationError('idempotencyKey 已用于不同事件')
      return { event: clonedEvent(existing), appended: false }
    }
    const filePath = streamFile(storageDir, taskId)
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
    if (stream.repairTailAt !== null) {
      await truncate(filePath, stream.repairTailAt)
      stream.repairTailAt = null
      stream.needsNewlinePrefix = false
    }
    await writeEvent(filePath, candidate, stream.needsNewlinePrefix)
    stream.events.push(candidate)
    stream.eventsById.set(candidate.eventId, candidate)
    stream.nextSequence += 1
    stream.needsNewlinePrefix = false
    return { event: clonedEvent(candidate), appended: true }
  })

  const read = (options: TaskEventReadOptions) => serialize(async () => {
    const taskId = identifier('taskId', options.taskId) as string
    const afterSequence = parseAfterSequence(options.afterSequence)
    const limit = parseReadLimit(options.limit)
    const stream = await loadStream(taskId)
    return {
      taskId,
      events: stream.events.filter((event) => event.sequence > afterSequence).slice(0, limit).map(clonedEvent),
      nextSequence: stream.nextSequence,
    }
  })

  const findByEventId = (options: { taskId: string; eventId: string }) => serialize(async () => {
    const taskId = identifier('taskId', options.taskId) as string
    const eventId = identifier('eventId', options.eventId) as string
    const stream = await loadStream(taskId)
    const event = stream.eventsById.get(eventId)
    return event ? clonedEvent(event) : null
  })

  return { storageDir, append, read, findByEventId }
}

const readJsonBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_EVENT_BYTES + 8 * 1024) throw new TaskEventLedgerValidationError('请求内容超过大小限制')
    chunks.push(buffer)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new TaskEventLedgerValidationError('请求内容必须是 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TaskEventLedgerValidationError('请求内容必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

const requestNumber = (value: string | null, name: string) => {
  if (value === null) return undefined
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new TaskEventLedgerValidationError(`${name} 无效`)
  return Number(value)
}

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.statusCode = status
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

export function taskEventLedgerMiddleware(ledger: TaskEventLedger) {
  return async (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/api/task-events') return next()
    try {
      if (request.method === 'GET') {
        const taskId = url.searchParams.get('taskId')
        const page = await ledger.read({
          taskId: taskId ?? '',
          afterSequence: requestNumber(url.searchParams.get('afterSequence'), 'afterSequence'),
          limit: requestNumber(url.searchParams.get('limit'), 'limit'),
        })
        sendJson(response, 200, page)
        return
      }
      if (request.method === 'POST') {
        const input = await readJsonBody(request)
        const result = await ledger.append(input as TaskEventAppendInput)
        sendJson(response, result.appended ? 201 : 200, result)
        return
      }
      response.statusCode = 405
      response.setHeader('allow', 'GET, POST')
      response.end()
    } catch (error) {
      if (error instanceof TaskEventLedgerValidationError) {
        sendJson(response, 400, { error: error.message })
        return
      }
      next(error)
    }
  }
}
