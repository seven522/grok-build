/**
 * Pure, deterministic session reliability primitives.
 *
 * The caller owns WebSocket I/O, timers, and composer storage. This module
 * only describes what state may safely be inferred from those observations.
 * A task is never resumed after a transport failure, timeout, or explicit
 * cancellation. Reconnection restores history and transport only.
 */

export const DEFAULT_PROMPT_TIMEOUT_MS = 120_000

export type ReconnectPolicy = {
  baseDelayMs: number
  maxDelayMs: number
  maxAttempts: number
}

export const DEFAULT_RECONNECT_POLICY: Readonly<ReconnectPolicy> = Object.freeze({
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  maxAttempts: 5,
})

export type SessionTransportPhase = 'connected' | 'offline' | 'reconnecting' | 'exhausted'
export type ActiveTaskPhase = 'awaiting_terminal' | 'waiting_for_user' | 'timed_out' | 'unconfirmed'
export type TaskTerminalOutcome = 'completed' | 'failed' | 'cancelled'
export type SessionTaskPhase = ActiveTaskPhase | TaskTerminalOutcome

export type SessionTaskReliability = {
  runId: string
  phase: SessionTaskPhase
  startedAtMs: number
  deadlineAtMs: number
  cancelRequestedAtMs: number | null
  terminalAtMs: number | null
  terminalReason: string | null
}

export type SessionReliabilityState = {
  transport: {
    phase: SessionTransportPhase
    reconnectAttempts: number
    lastDisconnectAtMs: number | null
    lastDisconnectReason: string | null
  }
  task: SessionTaskReliability | null
}

/**
 * The composer remains caller-owned. Attachments are intentionally opaque and
 * are never cloned, serialized, or mutated by this reliability module.
 */
export type ComposerPayload<TAttachment> = Readonly<{
  draft: string
  attachments: readonly TAttachment[]
}>

export type RecoveryMessage = {
  code:
    | 'transport_reconnecting'
    | 'transport_exhausted'
    | 'transport_recovered_task_unconfirmed'
    | 'prompt_timed_out'
    | 'cancel_pending'
    | 'task_completed'
    | 'task_failed'
    | 'task_cancelled'
    | 'idle'
  tone: 'info' | 'warning' | 'error' | 'success'
  text: string
  /** The UI must retain its caller-owned composer during recovery. */
  preserveComposer: true
  /** Only an explicit terminal event may set this to true. */
  taskCompleted: boolean
}

export type ReconnectPlan =
  | { kind: 'scheduled'; attempt: number; delayMs: number; dueAtMs: number }
  | { kind: 'exhausted'; attemptsMade: number }

export type PromptStartResult =
  | { kind: 'started'; state: SessionReliabilityState; deadlineAtMs: number }
  | { kind: 'blocked'; state: SessionReliabilityState; reason: 'active_task' | 'transport_unavailable' }

export type PromptTimeoutResult = {
  state: SessionReliabilityState
  timedOut: boolean
  message: RecoveryMessage
}

export type PromptResumeResult = {
  state: SessionReliabilityState
  resumed: boolean
  deadlineAtMs: number | null
}

export type CancelPlan =
  | { kind: 'send_cancel'; state: SessionReliabilityState; runId: string }
  | { kind: 'queued_until_reconnect'; state: SessionReliabilityState; runId: string }
  | { kind: 'already_requested'; state: SessionReliabilityState; runId: string; awaitingTransport: boolean }
  | { kind: 'not_active'; state: SessionReliabilityState }

export type RecoveryAction =
  | { kind: 'recover_task'; runId: string; cancelRequested: boolean }
  /** Safe only when the ACP cancel endpoint is idempotent for a run. */
  | { kind: 'resend_cancel'; runId: string }

export type TransportDisconnectedResult = {
  state: SessionReliabilityState
  reconnect: ReconnectPlan
  message: RecoveryMessage
}

export type TransportConnectedResult = {
  state: SessionReliabilityState
  actions: RecoveryAction[]
  message: RecoveryMessage
}

export type TaskTerminalResult = {
  state: SessionReliabilityState
  applied: boolean
  message: RecoveryMessage
}

export type PromptRetryPlan<TAttachment> =
  | { kind: 'retry'; state: SessionReliabilityState; sourceRunId: string; composer: ComposerPayload<TAttachment>; reason: 'failed' | 'cancelled' }
  | { kind: 'recover_before_retry'; state: SessionReliabilityState; sourceRunId: string; composer: ComposerPayload<TAttachment>; reason: ActiveTaskPhase }
  | { kind: 'wait_for_transport'; state: SessionReliabilityState; sourceRunId: string; composer: ComposerPayload<TAttachment> }
  | { kind: 'blocked'; state: SessionReliabilityState; composer: ComposerPayload<TAttachment>; reason: 'no_task' | 'completed' }

export type SessionRecoverySnapshot<TAttachment> = {
  state: SessionReliabilityState
  composer: ComposerPayload<TAttachment>
  message: RecoveryMessage
}

const activeTaskPhases = new Set<ActiveTaskPhase>(['awaiting_terminal', 'waiting_for_user', 'timed_out', 'unconfirmed'])

const isFiniteTimestamp = (value: number) => Number.isFinite(value) && value >= 0

const requireTimestamp = (value: number, name: string) => {
  if (!isFiniteTimestamp(value)) throw new RangeError(`${name} 必须是非负有限时间戳`)
  return value
}

const requireNonEmpty = (value: string, name: string) => {
  const trimmed = value.trim()
  if (!trimmed) throw new RangeError(`${name} 不能为空`)
  return trimmed
}

const requirePositiveInteger = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} 必须是正整数`)
  return value
}

const validatedReconnectPolicy = (policy: ReconnectPolicy) => {
  const baseDelayMs = requirePositiveInteger(policy.baseDelayMs, 'baseDelayMs')
  const maxDelayMs = requirePositiveInteger(policy.maxDelayMs, 'maxDelayMs')
  const maxAttempts = requirePositiveInteger(policy.maxAttempts, 'maxAttempts')
  if (maxDelayMs < baseDelayMs) throw new RangeError('maxDelayMs 不能小于 baseDelayMs')
  return { baseDelayMs, maxDelayMs, maxAttempts }
}

export const isActiveTask = (task: SessionTaskReliability | null): task is SessionTaskReliability => Boolean(task && activeTaskPhases.has(task.phase as ActiveTaskPhase))

export const isTerminalTaskPhase = (phase: SessionTaskPhase): phase is TaskTerminalOutcome => (
  phase === 'completed' || phase === 'failed' || phase === 'cancelled'
)

/** A late backend terminal event cannot overwrite a terminal decision already made for the same run. */
export function acceptsTerminalUpdate(
  task: SessionTaskReliability | null,
  runId: string | null,
  outcome: TaskTerminalOutcome,
) {
  if (!task || !runId || task.runId !== runId || !isTerminalTaskPhase(task.phase)) return true
  return task.phase === outcome
}

/** Loading a session restores history only; any observed in-flight run is treated as interrupted. */
export function interruptedRunForSessionLoad(input: {
  runningPromptId: string | null
  replayedRunId: string | null
  task: SessionTaskReliability | null
}) {
  const runningPromptId = input.runningPromptId?.trim()
  if (runningPromptId) return runningPromptId
  const replayedRunId = input.replayedRunId?.trim()
  if (replayedRunId) return replayedRunId
  return isActiveTask(input.task) ? input.task.runId : null
}

export function createSessionReliabilityState(transport: SessionTransportPhase = 'connected'): SessionReliabilityState {
  return {
    transport: {
      phase: transport,
      reconnectAttempts: 0,
      lastDisconnectAtMs: null,
      lastDisconnectReason: null,
    },
    task: null,
  }
}

/** Starts a prompt deadline without sending a transport request. */
export function startPrompt(
  state: SessionReliabilityState,
  input: { runId: string; startedAtMs: number; timeoutMs?: number },
): PromptStartResult {
  if (isActiveTask(state.task)) return { kind: 'blocked', state, reason: 'active_task' }
  if (state.transport.phase !== 'connected') return { kind: 'blocked', state, reason: 'transport_unavailable' }
  const runId = requireNonEmpty(input.runId, 'runId')
  const startedAtMs = requireTimestamp(input.startedAtMs, 'startedAtMs')
  const timeoutMs = requirePositiveInteger(input.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS, 'timeoutMs')
  const deadlineAtMs = startedAtMs + timeoutMs
  if (!Number.isFinite(deadlineAtMs)) throw new RangeError('提示词截止时间无效')
  return {
    kind: 'started',
    deadlineAtMs,
    state: {
      ...state,
      task: {
        runId,
        phase: 'awaiting_terminal',
        startedAtMs,
        deadlineAtMs,
        cancelRequestedAtMs: null,
        terminalAtMs: null,
        terminalReason: null,
      },
    },
  }
}

/** An explicit permission, question, or plan request pauses the terminal watchdog. */
export function pausePromptForUserInput(state: SessionReliabilityState): SessionReliabilityState {
  const task = state.task
  if (!isActiveTask(task) || task.phase === 'waiting_for_user') return state
  return { ...state, task: { ...task, phase: 'waiting_for_user' } }
}

/** User input restarts the terminal watchdog without starting a second prompt. */
export function resumePromptAfterUserInput(
  state: SessionReliabilityState,
  input: { resumedAtMs: number; timeoutMs?: number },
): PromptResumeResult {
  const task = state.task
  if (!task || task.phase !== 'waiting_for_user') return { state, resumed: false, deadlineAtMs: null }
  const resumedAtMs = requireTimestamp(input.resumedAtMs, 'resumedAtMs')
  const timeoutMs = requirePositiveInteger(input.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS, 'timeoutMs')
  const deadlineAtMs = resumedAtMs + timeoutMs
  if (!Number.isFinite(deadlineAtMs)) throw new RangeError('提示词截止时间无效')
  const next: SessionReliabilityState = {
    ...state,
    task: { ...task, phase: 'awaiting_terminal', deadlineAtMs },
  }
  return { state: next, resumed: true, deadlineAtMs }
}

/**
 * A missing terminal deadline is an abnormal end. The task becomes failed so
 * a later reconnect cannot resume it or leave the UI looking active.
 */
export function applyPromptTimeout(state: SessionReliabilityState, nowMs: number): PromptTimeoutResult {
  requireTimestamp(nowMs, 'nowMs')
  const task = state.task
  if (!isActiveTask(task) || task.phase === 'waiting_for_user' || nowMs < task.deadlineAtMs || task.phase === 'timed_out') {
    return { state, timedOut: Boolean(task?.phase === 'timed_out'), message: recoveryMessage(state) }
  }
  const next: SessionReliabilityState = {
    ...state,
    task: {
      ...task,
      phase: 'failed',
      terminalAtMs: nowMs,
      terminalReason: 'prompt-terminal-timeout',
    },
  }
  return { state: next, timedOut: true, message: recoveryMessage(next) }
}

/** Cancellation is a user-authoritative terminal state; delivery remains best effort. */
export function requestPromptCancel(state: SessionReliabilityState, requestedAtMs: number): CancelPlan {
  requireTimestamp(requestedAtMs, 'requestedAtMs')
  const task = state.task
  if (!isActiveTask(task)) return { kind: 'not_active', state }
  if (task.cancelRequestedAtMs !== null) {
    return {
      kind: 'already_requested',
      state,
      runId: task.runId,
      awaitingTransport: state.transport.phase !== 'connected',
    }
  }
  const next: SessionReliabilityState = {
    ...state,
    task: {
      ...task,
      phase: 'cancelled',
      cancelRequestedAtMs: requestedAtMs,
      terminalAtMs: requestedAtMs,
      terminalReason: 'user-cancelled',
    },
  }
  return state.transport.phase === 'connected'
    ? { kind: 'send_cancel', state: next, runId: task.runId }
    : { kind: 'queued_until_reconnect', state: next, runId: task.runId }
}

/** Returns a bounded, deterministic exponential reconnect delay; no random jitter is applied here. */
export function planReconnect(input: {
  attemptsMade: number
  nowMs: number
  policy?: ReconnectPolicy
}): ReconnectPlan {
  const attemptsMade = input.attemptsMade
  if (!Number.isSafeInteger(attemptsMade) || attemptsMade < 0) throw new RangeError('attemptsMade 必须是非负整数')
  const nowMs = requireTimestamp(input.nowMs, 'nowMs')
  const policy = validatedReconnectPolicy(input.policy ?? DEFAULT_RECONNECT_POLICY)
  const attempt = attemptsMade + 1
  if (attempt > policy.maxAttempts) return { kind: 'exhausted', attemptsMade }
  const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** Math.min(attempt - 1, 30)))
  return { kind: 'scheduled', attempt, delayMs, dueAtMs: nowMs + delayMs }
}

/**
 * Records a transport loss. An in-flight task ends as failed; reconnecting the
 * transport must not resume execution from a partial historical replay.
 */
export function markTransportDisconnected(
  state: SessionReliabilityState,
  input: { nowMs: number; reason?: string; policy?: ReconnectPolicy },
): TransportDisconnectedResult {
  const nowMs = requireTimestamp(input.nowMs, 'nowMs')
  const reconnect = planReconnect({
    attemptsMade: state.transport.reconnectAttempts,
    nowMs,
    policy: input.policy,
  })
  const task = isActiveTask(state.task)
    ? {
        ...state.task,
        phase: 'failed' as const,
        terminalAtMs: nowMs,
        terminalReason: input.reason?.trim() || 'transport-disconnected',
      }
    : state.task
  const next: SessionReliabilityState = {
    transport: {
      phase: reconnect.kind === 'scheduled' ? 'reconnecting' : 'exhausted',
      reconnectAttempts: reconnect.kind === 'scheduled' ? reconnect.attempt : reconnect.attemptsMade,
      lastDisconnectAtMs: nowMs,
      lastDisconnectReason: input.reason?.trim() || null,
    },
    task,
  }
  return { state: next, reconnect, message: recoveryMessage(next) }
}

/**
 * Restoring a socket restores transport only. Failed and cancelled tasks stay
 * terminal and never produce recovery or cancel-resend actions.
 */
export function markTransportConnected(state: SessionReliabilityState): TransportConnectedResult {
  const next: SessionReliabilityState = {
    ...state,
    transport: {
      ...state.transport,
      phase: 'connected',
      reconnectAttempts: 0,
    },
  }
  const actions: RecoveryAction[] = []
  if (isActiveTask(next.task)) {
    actions.push({
      kind: 'recover_task',
      runId: next.task.runId,
      cancelRequested: next.task.cancelRequestedAtMs !== null,
    })
    if (next.task.cancelRequestedAtMs !== null) actions.push({ kind: 'resend_cancel', runId: next.task.runId })
  }
  return { state: next, actions, message: recoveryMessage(next) }
}

/** The only transition allowed to mark a task as completed, failed, or cancelled. */
export function recordTaskTerminal(
  state: SessionReliabilityState,
  input: { runId: string; outcome: TaskTerminalOutcome; observedAtMs: number; reason?: string },
): TaskTerminalResult {
  const runId = requireNonEmpty(input.runId, 'runId')
  const observedAtMs = requireTimestamp(input.observedAtMs, 'observedAtMs')
  const task = state.task
  if (!task || task.runId !== runId || isTerminalTaskPhase(task.phase)) {
    return { state, applied: false, message: recoveryMessage(state) }
  }
  const next: SessionReliabilityState = {
    ...state,
    task: {
      ...task,
      phase: input.outcome,
      terminalAtMs: observedAtMs,
      terminalReason: input.reason?.trim() || null,
    },
  }
  return { state: next, applied: true, message: recoveryMessage(next) }
}

/**
 * Plans a retry without dispatching a second prompt. Timed-out or unconfirmed
 * work must first be recovered/terminated, preventing duplicate execution.
 */
export function planPromptRetry<TAttachment>(
  state: SessionReliabilityState,
  composer: ComposerPayload<TAttachment>,
): PromptRetryPlan<TAttachment> {
  const task = state.task
  if (!task) return { kind: 'blocked', state, composer, reason: 'no_task' }
  if (task.phase === 'completed') return { kind: 'blocked', state, composer, reason: 'completed' }
  if (task.phase === 'failed' || task.phase === 'cancelled') {
    if (state.transport.phase !== 'connected') return { kind: 'wait_for_transport', state, sourceRunId: task.runId, composer }
    return { kind: 'retry', state, sourceRunId: task.runId, composer, reason: task.phase }
  }
  return { kind: 'recover_before_retry', state, sourceRunId: task.runId, composer, reason: task.phase }
}

/**
 * Returns caller-owned composer data unchanged so reconnect/retry UI can keep
 * its draft and attachment references outside the transport lifecycle.
 */
export function createSessionRecoverySnapshot<TAttachment>(
  state: SessionReliabilityState,
  composer: ComposerPayload<TAttachment>,
): SessionRecoverySnapshot<TAttachment> {
  return { state, composer, message: recoveryMessage(state) }
}

export function recoveryMessage(state: SessionReliabilityState): RecoveryMessage {
  const base = { preserveComposer: true as const, taskCompleted: false }
  const task = state.task
  if (task?.phase === 'completed') return {
    ...base,
    code: 'task_completed',
    tone: 'success',
    text: '已收到明确的任务完成终态。',
    taskCompleted: true,
  }
  if (task?.phase === 'failed') return {
    ...base,
    code: 'task_failed',
    tone: 'error',
    text: '本轮任务已失败并结束；重新连接只恢复历史，不会继续执行。',
  }
  if (task?.phase === 'cancelled') return {
    ...base,
    code: 'task_cancelled',
    tone: 'info',
    text: '本轮任务已取消并结束；可以修改内容后发起新的任务。',
  }
  if (state.transport.phase === 'reconnecting') return {
    ...base,
    code: 'transport_reconnecting',
    tone: 'warning',
    text: `Agent 连接已断开，正在进行第 ${state.transport.reconnectAttempts} 次重连。`,
  }
  if (state.transport.phase === 'exhausted') return {
    ...base,
    code: 'transport_exhausted',
    tone: 'error',
    text: '多次重连未成功；草稿和附件应保留，待手动恢复连接后再确认任务状态。',
  }
  if (task?.phase === 'unconfirmed') return {
    ...base,
    code: 'transport_recovered_task_unconfirmed',
    tone: 'warning',
    text: '连接已恢复，但上一轮任务状态尚未确认；恢复连接不代表任务已完成。',
  }
  if (task?.phase === 'timed_out') return {
    ...base,
    code: 'prompt_timed_out',
    tone: 'warning',
    text: task.cancelRequestedAtMs === null
      ? '本轮任务等待终态超时，尚未确认成功或失败；可先请求取消或恢复任务状态。'
      : '本轮任务等待终态超时，取消请求仍待确认；尚未将任务标记为已取消。',
  }
  if (task && task.cancelRequestedAtMs !== null) return {
    ...base,
    code: 'cancel_pending',
    tone: 'info',
    text: '已请求取消，正在等待 Agent 返回明确终态。',
  }
  return { ...base, code: 'idle', tone: 'info', text: '会话连接正常。' }
}
