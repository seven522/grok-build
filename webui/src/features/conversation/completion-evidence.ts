/**
 * Completion evidence is deliberately independent from UI state.
 *
 * ACP tool updates are transport events. The conversation UI may render a
 * shortened description, but a completion decision must retain the receipts
 * that justify it: command exit codes, changed-file observations, readbacks,
 * a verifier receipt, and a cleanup disposition.
 */

export type AcpToolUpdateEvidence = {
  toolCallId: string
  title?: string
  status?: string
  rawInput?: unknown
  rawOutput?: unknown
  /** Stable source event id when the update has been loaded from the ledger. */
  eventId?: string
  /** Immutable task-ledger sequence, used for post-change readback ordering. */
  sequence?: number
}

export type ChangedFileReceipt = {
  path: string
  action?: string
  sourceToolCallId?: string
  sourceSequence?: number
}

export type ChangeEvidence =
  | { kind: 'changed'; files: readonly ChangedFileReceipt[]; source?: 'declared' | 'verifier' }
  | { kind: 'no_change'; reason: string; source?: 'declared' | 'verifier' }

export type ReadbackReceipt = {
  id: string
  status: 'passed' | 'failed'
  kind: 'file' | 'diff' | 'command_output' | 'ui' | 'api' | 'other'
  subject: string
  sourceToolCallId?: string
  sourceSequence?: number
  detail?: string
}

/**
 * A verifier receipt is intentionally stricter than an assistant message.
 * A model-written "done" sentence has neither a stable receipt id nor a link
 * to the observations it checked, and therefore cannot pass this gate.
 */
export type VerifierReceipt = {
  id: string
  status: 'passed' | 'failed' | 'blocked'
  summary: string
  checkedAt: string
  evidenceIds: readonly string[]
}

export type CleanupReceipt = {
  status: 'passed' | 'failed' | 'not_required'
  summary: string
  resourceIds?: readonly string[]
}

export type CommandReceipt = {
  toolCallId: string
  command: string
  exitCode: number | null
  outputObserved: boolean
  timedOut: boolean
  signal?: string
  status: 'passed' | 'failed' | 'pending' | 'unknown'
}

export type CompletionEvidenceInput = {
  toolUpdates?: readonly AcpToolUpdateEvidence[]
  changes?: ChangeEvidence
  readbacks?: readonly ReadbackReceipt[]
  verifier?: VerifierReceipt
  cleanup?: CleanupReceipt
}

export type CompletionEvidenceReport = {
  status: 'verified' | 'incomplete' | 'failed' | 'blocked'
  acceptsCompletion: boolean
  changedFiles: {
    status: 'changed' | 'no_change' | 'unknown'
    files: ChangedFileReceipt[]
    reason?: string
  }
  commands: CommandReceipt[]
  readbacks: ReadbackReceipt[]
  verifier: {
    status: 'passed' | 'failed' | 'blocked' | 'missing' | 'invalid'
    receiptId?: string
    summary?: string
  }
  cleanup: {
    status: 'passed' | 'failed' | 'not_required' | 'missing' | 'invalid'
    summary?: string
  }
  failedToolCallIds: string[]
  pendingToolCallIds: string[]
  uncertainty: string[]
}

/**
 * A non-conversational change observation. `evidenceIds` must reference
 * ledger/tool/workspace receipts; an assistant message is not an allowed
 * source for this input.
 */
export type ToolReceiptChangeEvidence =
  | { kind: 'changed'; files: readonly ChangedFileReceipt[]; evidenceIds: readonly string[] }
  | { kind: 'no_change'; reason: string; evidenceIds: readonly string[] }

/** A readback supplied by a ledger-backed observer rather than chat text. */
export type ToolReceiptReadback = ReadbackReceipt & {
  source: 'acp' | 'runner' | 'workspace'
  sourceSequence: number
}

export type ToolReceiptVerifierInput = {
  /** Stable task/run/terminal-event scope chosen by the ledger caller. */
  scopeId: string
  /** The terminal event timestamp; no wall-clock read occurs in this helper. */
  checkedAt: string
  toolUpdates: readonly AcpToolUpdateEvidence[]
  explicitChanges?: ToolReceiptChangeEvidence
  readbacks?: readonly ToolReceiptReadback[]
}

export type ToolReceiptVerification = {
  report: CompletionEvidenceReport
  verifier: VerifierReceipt
  cleanup: CleanupReceipt
}

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value)
  ? value as JsonRecord
  : {}

const asText = (value: unknown) => typeof value === 'string' ? value.trim() : ''

const asFiniteNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null

const asSequence = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined

const hasOwn = (record: JsonRecord, key: string) => Object.prototype.hasOwnProperty.call(record, key)

const normalizedStatus = (value: string | undefined) => (value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')

const isTerminalStatus = (status: string) => ['completed', 'success', 'failed', 'error', 'cancelled', 'canceled'].includes(status)

const isFailureStatus = (status: string) => ['failed', 'error'].includes(status)

const isCancelledStatus = (status: string) => ['cancelled', 'canceled'].includes(status)

const rawType = (value: unknown) => asText(asRecord(value).type).toLowerCase().replace(/[_-]+/g, '')

const diagnosticCodes = (value: unknown) => {
  const codes = asRecord(value).diagnostic_codes
  return Array.isArray(codes) ? codes.map(asText).filter(Boolean) : []
}

const hardDiagnosticCodes = new Set([
  'script-error',
  'parse-error',
  'process-crash',
  'permission-denied',
  'runtime-traceback',
  'fatal-error',
])

const nestedRecord = (value: JsonRecord, names: readonly string[]) => {
  for (const name of names) {
    const record = asRecord(value[name])
    if (Object.keys(record).length) return record
  }
  return {}
}

const collectFiles = (value: unknown, toolCallId: string, sequence?: number): ChangedFileReceipt[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const record = asRecord(entry)
    const path = asText(record.path ?? record.absolute_path ?? record.absolutePath)
    if (!path) return []
    const action = asText(record.action) || undefined
    return [{ path, action, sourceToolCallId: toolCallId, ...(sequence ? { sourceSequence: sequence } : {}) }]
  })
}

const uniqueFiles = (files: readonly ChangedFileReceipt[]) => {
  const result = new Map<string, ChangedFileReceipt>()
  for (const file of files) {
    const path = file.path.trim()
    if (!path) continue
    const key = `${path}\u0000${file.action ?? ''}`
    const previous = result.get(key)
    if (!previous || (asSequence(file.sourceSequence) ?? 0) >= (asSequence(previous.sourceSequence) ?? 0)) {
      result.set(key, { ...file, path })
    }
  }
  return [...result.values()]
}

const deriveChangedFiles = (updates: readonly AcpToolUpdateEvidence[]) => uniqueFiles(updates.flatMap((update) => {
  const output = asRecord(update.rawOutput)
  const type = rawType(output)
  if (type === 'applypatch') {
    const result = nestedRecord(output, ['Success', 'success'])
    return collectFiles(output.files ?? result.files, update.toolCallId, asSequence(update.sequence))
  }
  if (type === 'searchreplace') {
    const result = nestedRecord(output, ['EditsApplied', 'edits_applied', 'editsApplied'])
    const path = asText(result.absolute_path ?? result.absolutePath ?? output.absolute_path ?? output.absolutePath)
    const sequence = asSequence(update.sequence)
    return path ? [{ path, action: 'modified', sourceToolCallId: update.toolCallId, ...(sequence ? { sourceSequence: sequence } : {}) }] : []
  }
  return []
}))

const deriveReadbacks = (updates: readonly AcpToolUpdateEvidence[]): ReadbackReceipt[] => updates.flatMap<ReadbackReceipt>((update): ReadbackReceipt[] => {
  const output = asRecord(update.rawOutput)
  if (rawType(output) !== 'readfile') return []
  const status = normalizedStatus(update.status)
  const content = nestedRecord(output, ['FileContent', 'file_content', 'fileContent'])
  const subject = asText(content.path ?? content.absolute_path ?? content.absolutePath) || asText(update.title) || update.toolCallId
  if (isFailureStatus(status)) return [{
    id: `tool:${update.toolCallId}`,
    status: 'failed',
    kind: 'file',
    subject,
    sourceToolCallId: update.toolCallId,
    ...(asSequence(update.sequence) ? { sourceSequence: asSequence(update.sequence) } : {}),
  }]
  if (isTerminalStatus(status) && Object.keys(content).length) return [{
    id: `tool:${update.toolCallId}`,
    status: 'passed',
    kind: 'file',
    subject,
    sourceToolCallId: update.toolCallId,
    ...(asSequence(update.sequence) ? { sourceSequence: asSequence(update.sequence) } : {}),
  }]
  return []
})

const mergeToolUpdates = (updates: readonly AcpToolUpdateEvidence[]) => {
  const byId = new Map<string, AcpToolUpdateEvidence>()
  for (const update of updates) {
    const id = update.toolCallId.trim()
    if (!id) continue
    const previous = byId.get(id)
    if (!previous) {
      byId.set(id, { ...update, toolCallId: id })
      continue
    }
    const previousStatus = normalizedStatus(previous.status)
    const nextStatus = normalizedStatus(update.status)
    const preferNextStatus = isTerminalStatus(nextStatus) || !isTerminalStatus(previousStatus)
    byId.set(id, {
      toolCallId: id,
      title: update.title || previous.title,
      status: preferNextStatus ? update.status : previous.status,
      rawInput: update.rawInput ?? previous.rawInput,
      rawOutput: update.rawOutput ?? previous.rawOutput,
      sequence: preferNextStatus ? update.sequence ?? previous.sequence : previous.sequence ?? update.sequence,
    })
  }
  return [...byId.values()]
}

const commandReceipt = (update: AcpToolUpdateEvidence): CommandReceipt | null => {
  const output = asRecord(update.rawOutput)
  const input = asRecord(update.rawInput)
  const command = asText(output.command ?? input.command)
  if (!command || rawType(output) !== 'bash') return null
  const status = normalizedStatus(update.status)
  const exitCode = asFiniteNumber(output.exit_code ?? output.exitCode)
  const timedOut = output.timed_out === true || output.timedOut === true
  const signal = asText(output.signal) || undefined
  const outputObserved = hasOwn(output, 'output') || hasOwn(output, 'output_for_prompt') || hasOwn(output, 'outputForPrompt')
  const semanticFailure = diagnosticCodes(output).some((code) => hardDiagnosticCodes.has(code))
  let receiptStatus: CommandReceipt['status']
  if (semanticFailure || timedOut || (signal && signal !== 'backgrounded') || (exitCode !== null && exitCode !== 0)) receiptStatus = 'failed'
  else if (!isTerminalStatus(status) || signal === 'backgrounded') receiptStatus = 'pending'
  else if (exitCode === null) receiptStatus = 'unknown'
  else receiptStatus = 'passed'
  return { toolCallId: update.toolCallId, command, exitCode, outputObserved, timedOut, signal, status: receiptStatus }
}

const validVerifierReceipt = (receipt: VerifierReceipt | undefined) => {
  const record = asRecord(receipt)
  return Boolean(
    asText(record.id)
    && asText(record.summary)
    && asText(record.checkedAt)
    && Array.isArray(record.evidenceIds)
    && record.evidenceIds.some((id) => asText(id)),
  )
}

const validCleanupReceipt = (receipt: CleanupReceipt | undefined) => Boolean(asText(asRecord(receipt).summary))

const validEvidenceIds = (value: unknown) => Array.isArray(value) && value.some((id) => asText(id))

const canonicalTimestamp = (value: unknown) => {
  const source = asText(value)
  const parsed = source ? Date.parse(source) : Number.NaN
  return Number.isNaN(parsed) ? '' : new Date(parsed).toISOString()
}

const normalizedPath = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')

const samePath = (left: string, right: string) => {
  const normalizedLeft = normalizedPath(left)
  const normalizedRight = normalizedPath(right)
  return normalizedLeft === normalizedRight
    || normalizedLeft.endsWith(`/${normalizedRight}`)
    || normalizedRight.endsWith(`/${normalizedLeft}`)
}

const rawOutputSignalsFailure = (value: unknown) => {
  const output = asRecord(value)
  if (output.is_error === true || output.isError === true || output.timed_out === true || output.timedOut === true) return true
  if (diagnosticCodes(output).some((code) => hardDiagnosticCodes.has(code))) return true
  const type = rawType(output)
  if (type === 'bash') {
    const exitCode = asFiniteNumber(output.exit_code ?? output.exitCode)
    return exitCode !== null && exitCode !== 0
  }
  if (type === 'applypatch') return !Object.keys(nestedRecord(output, ['Success', 'success'])).length
  if (type === 'searchreplace') return !Object.keys(nestedRecord(output, ['EditsApplied', 'edits_applied', 'editsApplied'])).length
  if (type === 'readfile') return !Object.keys(nestedRecord(output, ['FileContent', 'file_content', 'fileContent', 'ImageContent', 'image_content', 'PdfPageImages', 'pdf_page_images'])).length
  if (type === 'listdir') return !Object.keys(nestedRecord(output, ['Content', 'content'])).length
  if (type === 'webfetch') return !Object.keys(nestedRecord(output, ['Content', 'content'])).length
  if (type === 'codexgrepfiles') return hasOwn(output, 'Error') || hasOwn(output, 'error')
  if (type === 'grepsearch') {
    const exitCode = asFiniteNumber(output.exit_code ?? output.exitCode)
    return exitCode !== null && exitCode > 1
  }
  if (type === 'skill') return output.success === false
  return false
}

const rawOutputSignalsBackground = (value: unknown) => {
  const output = asRecord(value)
  const type = rawType(output)
  return type === 'backgroundtaskstarted'
    || type === 'taskoutput'
    || asText(output.signal).toLowerCase() === 'backgrounded'
}

const receiptFingerprint = (parts: readonly string[]) => {
  let value = 0x811c9dc5
  for (const character of parts.join('\u0000')) {
    value ^= character.charCodeAt(0)
    value = Math.imul(value, 0x01000193)
  }
  return (value >>> 0).toString(16).padStart(8, '0')
}

const explicitChangeState = (value: ToolReceiptChangeEvidence | undefined): ChangeEvidence | undefined => {
  if (!value || !validEvidenceIds(value.evidenceIds)) return undefined
  if (value.kind === 'changed') return { kind: 'changed', files: value.files, source: 'verifier' }
  if (value.kind === 'no_change') return { kind: 'no_change', reason: value.reason, source: 'verifier' }
  return undefined
}

const hasPostChangeReadbacks = (report: CompletionEvidenceReport) => report.changedFiles.status !== 'changed' || report.changedFiles.files.every((file) => {
  const changeSequence = asSequence(file.sourceSequence)
  if (!changeSequence) return false
  return report.readbacks.some((readback) => (
    readback.status === 'passed'
    && samePath(readback.subject, file.path)
    && (asSequence(readback.sourceSequence) ?? 0) > changeSequence
  ))
})

export const commandRequiresUiReadback = (command: string) => {
  const normalized = command.trim().toLowerCase()
  if (!normalized || /(?:^|\s)--headless(?:\s|$)/.test(normalized)) return false
  return /(?:^|[\s/&;|])godot(?:\s|$)/.test(normalized)
    || /\bgodot\.app\b/.test(normalized)
    || /\bopen\s+(?:-[a-z]+\s+)*(?:[^\n]*\.app\b|-a\s+[^\n]+)/.test(normalized)
}

/**
 * Creates ledger-ready verifier and cleanup receipts from tool observations
 * alone. It intentionally has no assistant-message input and returns `null`
 * rather than manufacturing a receipt when the evidence is incomplete.
 */
export const createToolReceiptVerifier = (input: ToolReceiptVerifierInput): ToolReceiptVerification | null => {
  const scopeId = asText(input.scopeId)
  const checkedAt = canonicalTimestamp(input.checkedAt)
  const updates = input.toolUpdates ?? []
  const changes = explicitChangeState(input.explicitChanges)
  if (!scopeId || !checkedAt || updates.some((update) => !asText(update.toolCallId) || !Object.keys(asRecord(update.rawOutput)).length)) return null
  if (input.explicitChanges && !changes) return null
  if (updates.some((update) => rawOutputSignalsFailure(update.rawOutput) || rawOutputSignalsBackground(update.rawOutput))) return null

  const provisionalCleanup: CleanupReceipt = {
    status: 'not_required',
    summary: 'ACP tool receipts show no background task or backgrounded command requiring cleanup.',
  }
  const evidenceIds = [...new Set([
    ...updates.map((update) => asText(update.eventId) || `tool:${update.toolCallId.trim()}`).filter(Boolean),
    ...(input.explicitChanges?.evidenceIds ?? []).map(asText).filter(Boolean),
    ...(input.readbacks ?? []).map((readback) => asText(readback.id)).filter(Boolean),
  ])].sort()
  if (!evidenceIds.length) return null
  const verifier: VerifierReceipt = {
    id: `tool-receipt:${scopeId}:${receiptFingerprint([scopeId, checkedAt, ...evidenceIds])}`,
    status: 'passed',
    summary: 'Terminal ACP tool receipts provide complete command, change, readback, and cleanup evidence.',
    checkedAt,
    evidenceIds,
  }
  const report = deriveCompletionEvidence({
    toolUpdates: updates,
    changes,
    readbacks: input.readbacks,
    verifier,
    cleanup: provisionalCleanup,
  })
  if (!report.acceptsCompletion || !hasPostChangeReadbacks(report)) return null
  return { report, verifier, cleanup: provisionalCleanup }
}

/**
 * Builds the report that must gate a coding-task completion claim.
 *
 * The caller should feed it the lossless ACP ToolCall/ToolCallUpdate events
 * from the task ledger, not shortened cards from the conversation UI.
 */
export const deriveCompletionEvidence = (input: CompletionEvidenceInput): CompletionEvidenceReport => {
  const updates = mergeToolUpdates(input.toolUpdates ?? [])
  const commands = updates.flatMap((update) => {
    const receipt = commandReceipt(update)
    return receipt ? [receipt] : []
  })
  const derivedFiles = deriveChangedFiles(updates)
  const declaredChanges = input.changes
  const changeConflict = declaredChanges?.kind === 'no_change' && derivedFiles.length > 0
  const declaredChangedFiles = declaredChanges?.kind === 'changed' ? uniqueFiles(declaredChanges.files) : []
  const changedFiles = declaredChanges?.kind === 'changed'
    ? { status: 'changed' as const, files: uniqueFiles([...derivedFiles, ...declaredChangedFiles]) }
    : declaredChanges?.kind === 'no_change'
      ? changeConflict
        ? { status: 'changed' as const, files: derivedFiles, reason: declaredChanges.reason.trim() || undefined }
        : { status: 'no_change' as const, files: [], reason: declaredChanges.reason.trim() || undefined }
      : derivedFiles.length
        ? { status: 'changed' as const, files: derivedFiles }
        : { status: 'unknown' as const, files: [] }
  const readbacks = [...deriveReadbacks(updates), ...(input.readbacks ?? [])]
  const failedToolCallIds = updates
    .filter((update) => isFailureStatus(normalizedStatus(update.status)))
    .map((update) => update.toolCallId)
  const pendingToolCallIds = updates
    .filter((update) => !isTerminalStatus(normalizedStatus(update.status)))
    .map((update) => update.toolCallId)
  const uncertainty: string[] = []

  if (changedFiles.status === 'unknown') uncertainty.push('缺少变更文件清单或明确的无变更说明。')
  if (declaredChanges?.kind === 'changed' && changedFiles.files.length === 0) uncertainty.push('声明存在变更，但没有可审计的文件路径。')
  if (declaredChanges?.kind === 'no_change' && !changedFiles.reason) uncertainty.push('明确无变更未提供原因。')
  if (changeConflict) uncertainty.push('声明“无变更”与 ACP 补丁/编辑收据冲突。')
  if (commands.some((command) => command.status === 'unknown')) uncertainty.push('至少一条终端命令没有可验证的退出码。')
  if (commands.some((command) => command.status === 'pending')) uncertainty.push('至少一条终端命令尚未到达终态。')
  if (commands.some((command) => commandRequiresUiReadback(command.command)) && !readbacks.some((readback) => readback.kind === 'ui' && readback.status === 'passed')) {
    uncertainty.push('检测到原生界面启动命令，但没有成功的界面观察收据。')
  }
  if (pendingToolCallIds.length) uncertainty.push('仍有工具调用没有终态收据。')
  if (changedFiles.status === 'changed' && !readbacks.some((readback) => readback.status === 'passed')) {
    uncertainty.push('检测到文件变更，但没有成功的读回、差异或界面观察收据。')
  }
  if (readbacks.some((readback) => readback.status === 'failed')) uncertainty.push('至少一条读回或观察收据失败。')

  let verifier: CompletionEvidenceReport['verifier']
  const verifierRecord = asRecord(input.verifier)
  const verifierStatus = asText(verifierRecord.status).toLowerCase()
  if (!input.verifier) verifier = { status: 'missing' }
  else if (!validVerifierReceipt(input.verifier) || !['passed', 'failed', 'blocked'].includes(verifierStatus)) verifier = { status: 'invalid', receiptId: asText(verifierRecord.id) || undefined, summary: asText(verifierRecord.summary) || undefined }
  else verifier = { status: verifierStatus as 'passed' | 'failed' | 'blocked', receiptId: asText(verifierRecord.id), summary: asText(verifierRecord.summary) }
  if (verifier.status === 'missing') uncertainty.push('没有独立验证器收据；Agent 的文字结论不能作为完成依据。')
  if (verifier.status === 'invalid') uncertainty.push('验证器收据缺少稳定 ID、检查时间、摘要或关联证据。')

  let cleanup: CompletionEvidenceReport['cleanup']
  const cleanupRecord = asRecord(input.cleanup)
  const cleanupStatus = asText(cleanupRecord.status).toLowerCase()
  if (!input.cleanup) cleanup = { status: 'missing' }
  else if (!validCleanupReceipt(input.cleanup) || !['passed', 'failed', 'not_required'].includes(cleanupStatus)) cleanup = { status: 'invalid', summary: asText(cleanupRecord.summary) || undefined }
  else cleanup = { status: cleanupStatus as 'passed' | 'failed' | 'not_required', summary: asText(cleanupRecord.summary) }
  if (cleanup.status === 'missing') uncertainty.push('没有进程或临时资源清理结论。')
  if (cleanup.status === 'invalid') uncertainty.push('清理收据缺少可审计的结论。')

  const hasHardFailure = changeConflict
    || failedToolCallIds.length > 0
    || commands.some((command) => command.status === 'failed')
    || readbacks.some((readback) => readback.status === 'failed')
    || verifier.status === 'failed'
    || cleanup.status === 'failed'
  const isBlocked = !hasHardFailure && (verifier.status === 'blocked' || updates.some((update) => isCancelledStatus(normalizedStatus(update.status))))
  const isVerified = !hasHardFailure
    && !isBlocked
    && uncertainty.length === 0
    && verifier.status === 'passed'
    && cleanup.status !== 'missing'
    && cleanup.status !== 'invalid'
  const status: CompletionEvidenceReport['status'] = hasHardFailure ? 'failed' : isBlocked ? 'blocked' : isVerified ? 'verified' : 'incomplete'

  return {
    status,
    acceptsCompletion: status === 'verified',
    changedFiles,
    commands,
    readbacks,
    verifier,
    cleanup,
    failedToolCallIds,
    pendingToolCallIds,
    uncertainty,
  }
}
