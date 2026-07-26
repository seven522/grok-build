export type TaskEventType =
  | 'task.created'
  | 'task.loaded'
  | 'task.archived'
  | 'state.changed'
  | 'cancel.requested'
  | 'checkpoint.created'
  | 'context.condensed'
  | 'memory.context.prepared'
  | 'memory.context.dispatched'
  | 'memory.proposed'
  | 'memory.committed'
  | 'message.user.created'
  | 'message.agent.delta'
  | 'message.agent.completed'
  | 'tool.requested'
  | 'tool.updated'
  | 'permission.requested'
  | 'permission.resolved'
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'verification.recorded'

export type TaskEventSource = 'ui' | 'acp' | 'runner' | 'system' | 'verifier' | 'automation'
export type TaskEventJson = null | boolean | number | string | TaskEventJson[] | { [key: string]: TaskEventJson }

export type TaskEventInput = {
  type: TaskEventType
  taskId: string
  projectId: string | null
  runId: string | null
  source: TaskEventSource
  idempotencyKey: string
  timestamp?: string
  payload: { [key: string]: TaskEventJson }
}

type JsonRecord = Record<string, unknown>
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const MAX_TEXT_LENGTH = 4_096

const asRecord = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value)
  ? value as JsonRecord
  : {}

const asText = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const asFiniteNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const hasOwn = (record: JsonRecord, key: string) => Object.prototype.hasOwnProperty.call(record, key)
const clip = (value: string) => value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH)}…` : value
const compactType = (value: unknown) => asText(value).replace(/[\s-]+/g, '_').toLowerCase()

export type AcpTurnTerminalOutcome = 'completed' | 'failed' | 'cancelled'

export const acpTurnTerminalOutcome = (update: JsonRecord): AcpTurnTerminalOutcome | null => {
  const kind = compactType(update.sessionUpdate ?? update.type)
  if (kind === 'turn_cancelled') return 'cancelled'
  if (kind === 'turn_failed') return 'failed'
  if (kind !== 'turn_completed') return null
  const stopReason = compactType(update.stop_reason ?? update.stopReason)
  if (stopReason === 'cancelled' || stopReason === 'canceled') return 'cancelled'
  if (!stopReason || stopReason === 'end_turn') return 'completed'
  return 'failed'
}

const fingerprint = (value: string) => {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const compactFiles = (value: unknown): Array<{ [key: string]: TaskEventJson }> => Array.isArray(value)
  ? value.flatMap((entry) => {
      const record = asRecord(entry)
      const path = asText(record.path ?? record.absolute_path ?? record.absolutePath)
      if (!path) return []
      const action = asText(record.action)
      if (action) return [{ path: clip(path), action: clip(action) }]
      return [{ path: clip(path) }]
    })
  : []

const compactRawInput = (value: unknown): { [key: string]: TaskEventJson } => {
  const input = asRecord(value)
  const result: { [key: string]: TaskEventJson } = {}
  const command = asText(input.command)
  const path = asText(input.path ?? input.absolute_path ?? input.absolutePath)
  const pattern = asText(input.pattern)
  if (command) result.command = clip(command)
  if (path) result.path = clip(path)
  if (pattern) result.pattern = clip(pattern)
  return result
}

const diagnosticText = (value: unknown) => {
  if (typeof value === 'string') return value.slice(0, MAX_TEXT_LENGTH * 2)
  if (!Array.isArray(value) || !value.length || value.length > MAX_TEXT_LENGTH * 2) return ''
  if (!value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) return ''
  try { return new TextDecoder().decode(new Uint8Array(value)) }
  catch { return '' }
}

const diagnosticCodes = (output: JsonRecord) => {
  const text = [output.output, output.output_for_prompt, output.outputForPrompt]
    .map(diagnosticText)
    .filter(Boolean)
    .join('\n')
  if (!text) return []
  const signatures: Array<[string, RegExp]> = [
    ['script-error', /\bSCRIPT ERROR\b/i],
    ['parse-error', /\bParse Error\b/i],
    ['process-crash', /\b(?:Program crashed|Segmentation fault|signal 11)\b/i],
    ['permission-denied', /\boperation not permitted\b/i],
    ['runtime-traceback', /\bTraceback \(most recent call last\)/i],
    ['fatal-error', /\bfatal error\b/i],
    ['software-renderer', /\bApple Software Renderer\b/i],
  ]
  return signatures.flatMap(([code, pattern]) => pattern.test(text) ? [code] : [])
}

const compactRawOutput = (value: unknown): { [key: string]: TaskEventJson } => {
  const output = asRecord(value)
  const result: { [key: string]: TaskEventJson } = {}
  const type = asText(output.type)
  const command = asText(output.command)
  const exitCode = asFiniteNumber(output.exit_code ?? output.exitCode)
  const signal = asText(output.signal)
  const path = asText(output.path ?? output.absolute_path ?? output.absolutePath)
  if (type) result.type = clip(type)
  if (command) result.command = clip(command)
  if (exitCode !== undefined) result.exit_code = exitCode
  if (hasOwn(output, 'output') || hasOwn(output, 'output_for_prompt') || hasOwn(output, 'outputForPrompt')) result.output = true
  const diagnostics = diagnosticCodes(output)
  if (diagnostics.length) result.diagnostic_codes = diagnostics
  if (hasOwn(output, 'timed_out') || hasOwn(output, 'timedOut')) result.timed_out = output.timed_out === true || output.timedOut === true
  if (signal) result.signal = clip(signal)
  if (path) result.path = clip(path)

  const success = asRecord(output.Success ?? output.success)
  const edits = asRecord(output.EditsApplied ?? output.edits_applied ?? output.editsApplied)
  const content = asRecord(output.FileContent ?? output.file_content ?? output.fileContent)
  const successFiles = compactFiles(output.files ?? success.files)
  if (successFiles.length) result.Success = { files: successFiles }
  const editsPath = asText(edits.absolute_path ?? edits.absolutePath)
  if (editsPath) result.EditsApplied = { absolute_path: clip(editsPath) }
  const contentPath = asText(content.path ?? content.absolute_path ?? content.absolutePath)
  if (contentPath) result.FileContent = { path: clip(contentPath) }
  return result
}

const payloadFor = (kind: string, update: JsonRecord): { [key: string]: TaskEventJson } => {
  const toolCallId = asText(update.toolCallId ?? update.tool_call_id)
  const title = asText(update.title)
  const status = asText(update.status)
  const result: { [key: string]: TaskEventJson } = {}
  if (toolCallId) result.toolCallId = clip(toolCallId)
  if (title) result.title = clip(title)
  if (status) result.status = clip(status)
  const toolKind = asText(update.kind)
  const name = asText(update.name)
  if (toolKind) result.kind = clip(toolKind)
  if (name) result.name = clip(name)
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const rawInput = compactRawInput(update.rawInput ?? update.raw_input)
    const rawOutput = compactRawOutput(update.rawOutput ?? update.raw_output ?? update.content)
    if (Object.keys(rawInput).length) result.rawInput = rawInput
    if (Object.keys(rawOutput).length) result.rawOutput = rawOutput
  } else {
    const content = asText(update.content ?? update.message ?? update.reason)
    if (content) result.summary = clip(content)
  }
  return result
}

const eventTypeFor = (kind: string, update: JsonRecord): TaskEventType | null => {
  if (kind === 'user_message_chunk') return 'message.user.created'
  if (kind === 'agent_message_chunk') return 'message.agent.delta'
  if (kind === 'tool_call') return 'tool.requested'
  if (kind === 'tool_call_update') return 'tool.updated'
  if (kind === 'model_changed') return 'state.changed'
  if (kind === 'checkpoint_created') return 'checkpoint.created'
  if (kind === 'context_compacted' || kind === 'context_condensed') return 'context.condensed'
  if (kind === 'memory_proposed') return 'memory.proposed'
  if (kind === 'memory_committed') return 'memory.committed'
  const terminalOutcome = acpTurnTerminalOutcome(update)
  if (terminalOutcome === 'completed') return 'run.completed'
  if (terminalOutcome === 'failed') return 'run.failed'
  if (terminalOutcome === 'cancelled') return 'run.cancelled'
  return null
}

const timestampFor = (eventMeta: JsonRecord) => {
  const supplied = eventMeta.agentTimestampMs ?? eventMeta.agent_timestamp_ms ?? eventMeta.timestamp ?? eventMeta.createdAt ?? eventMeta.created_at
  if (typeof supplied === 'string' && !Number.isNaN(new Date(supplied).getTime())) return new Date(supplied).toISOString()
  if (typeof supplied === 'number' && Number.isFinite(supplied)) return new Date(supplied).toISOString()
  return undefined
}

const durableMeta = (eventMeta: JsonRecord): { [key: string]: TaskEventJson } => {
  const result: { [key: string]: TaskEventJson } = {}
  const sourceEventId = asText(eventMeta.eventId ?? eventMeta.event_id)
  const promptId = asText(eventMeta.promptId ?? eventMeta.prompt_id)
  if (sourceEventId) result.sourceEventId = sourceEventId
  if (promptId) result.promptId = promptId
  // Timestamps and replay markers are delivery-local metadata. The event's
  // canonical timestamp already carries source timing; embedding changing
  // transport fields in a source-event keyed payload would make session/load
  // replay conflict with its original append.
  return result
}

export function acpTaskEvent(input: {
  taskId: string
  projectId: string | null
  runId: string | null
  eventMeta: JsonRecord
  update: JsonRecord
}): TaskEventInput | null {
  const kind = compactType(input.update.sessionUpdate ?? input.update.type)
  const type = eventTypeFor(kind, input.update)
  if (!type) return null
  const payload = payloadFor(kind, input.update)
  const meta = durableMeta(input.eventMeta)
  if (Object.keys(meta).length) payload.eventMeta = meta
  const sourceEventId = asText(input.eventMeta.eventId ?? input.eventMeta.event_id)
  const scope = input.runId ?? input.taskId
  const fallback = fingerprint(JSON.stringify({ kind, payload }))
  return {
    type,
    taskId: input.taskId,
    projectId: input.projectId,
    runId: input.runId,
    source: 'acp',
    idempotencyKey: sourceEventId ? `acp:${sourceEventId}` : `acp:${scope}:${kind}:${fallback}`,
    timestamp: timestampFor(input.eventMeta),
    payload,
  }
}

export type TaskEventAppendResult = {
  appended: boolean
  event: { eventId: string; sequence: number; timestamp: string }
}

export async function appendTaskEvent(fetchLike: FetchLike, event: TaskEventInput): Promise<TaskEventAppendResult> {
  const response = await fetchLike('/api/task-events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  })
  if (response.ok) {
    const body = await response.json() as Partial<TaskEventAppendResult>
    if (
      typeof body.appended !== 'boolean'
      || !body.event
      || typeof body.event.eventId !== 'string'
      || !Number.isSafeInteger(body.event.sequence)
      || typeof body.event.timestamp !== 'string'
    ) throw new Error('任务账本返回了无效收据')
    return body as TaskEventAppendResult
  }
  let message = ''
  try {
    const payload = await response.json() as { error?: unknown }
    message = asText(payload.error)
  } catch { /* keep the status-only error */ }
  throw new Error(`任务账本写入失败 (${response.status})${message ? `：${message}` : ''}`)
}
