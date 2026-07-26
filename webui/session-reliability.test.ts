import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyPromptTimeout,
  acceptsTerminalUpdate,
  createSessionRecoverySnapshot,
  createSessionReliabilityState,
  interruptedRunForSessionLoad,
  markTransportConnected,
  markTransportDisconnected,
  pausePromptForUserInput,
  planPromptRetry,
  planReconnect,
  recordTaskTerminal,
  recoveryMessage,
  requestPromptCancel,
  resumePromptAfterUserInput,
  startPrompt,
} from './session-reliability.ts'

const startedTask = (runId = 'run-1') => {
  const result = startPrompt(createSessionReliabilityState(), {
    runId,
    startedAtMs: 1_000,
    timeoutMs: 1_000,
  })
  assert.equal(result.kind, 'started')
  if (result.kind !== 'started') throw new Error('expected a started task fixture')
  return result.state
}

test('reports an idle connected session as idle rather than a pending cancellation', () => {
  const message = recoveryMessage(createSessionReliabilityState())
  assert.equal(message.code, 'idle')
  assert.equal(message.taskCompleted, false)
})

test('ends the active task as failed when its terminal deadline expires', () => {
  const offline = startPrompt(createSessionReliabilityState('offline'), {
    runId: 'offline-run', startedAtMs: 1_000, timeoutMs: 1_000,
  })
  assert.deepEqual(offline, {
    kind: 'blocked',
    state: createSessionReliabilityState('offline'),
    reason: 'transport_unavailable',
  })

  const beforeDeadline = applyPromptTimeout(startedTask(), 1_999)
  assert.equal(beforeDeadline.timedOut, false)
  assert.equal(beforeDeadline.state.task?.phase, 'awaiting_terminal')

  const timedOut = applyPromptTimeout(beforeDeadline.state, 2_000)
  assert.equal(timedOut.timedOut, true)
  assert.equal(timedOut.state.task?.phase, 'failed')
  assert.equal(timedOut.state.task?.terminalReason, 'prompt-terminal-timeout')
  assert.equal(timedOut.message.code, 'task_failed')
  assert.equal(timedOut.message.taskCompleted, false)
})

test('does not count intentional user input waits as an abnormal task timeout', () => {
  const paused = pausePromptForUserInput(startedTask('run-user-wait'))
  assert.equal(paused.task?.phase, 'waiting_for_user')
  assert.equal(applyPromptTimeout(paused, 20_000).timedOut, false)

  const resumed = resumePromptAfterUserInput(paused, {
    resumedAtMs: 20_000,
    timeoutMs: 1_000,
  })
  assert.equal(resumed.resumed, true)
  assert.equal(resumed.state.task?.phase, 'awaiting_terminal')
  assert.equal(resumed.deadlineAtMs, 21_000)
  assert.equal(applyPromptTimeout(resumed.state, 20_999).timedOut, false)
  assert.equal(applyPromptTimeout(resumed.state, 21_000).state.task?.phase, 'failed')
})

test('uses a bounded deterministic exponential reconnect plan', () => {
  const policy = { baseDelayMs: 100, maxDelayMs: 350, maxAttempts: 3 }
  assert.deepEqual(planReconnect({ attemptsMade: 0, nowMs: 1_000, policy }), {
    kind: 'scheduled', attempt: 1, delayMs: 100, dueAtMs: 1_100,
  })
  assert.deepEqual(planReconnect({ attemptsMade: 1, nowMs: 1_000, policy }), {
    kind: 'scheduled', attempt: 2, delayMs: 200, dueAtMs: 1_200,
  })
  assert.deepEqual(planReconnect({ attemptsMade: 2, nowMs: 1_000, policy }), {
    kind: 'scheduled', attempt: 3, delayMs: 350, dueAtMs: 1_350,
  })
  assert.deepEqual(planReconnect({ attemptsMade: 3, nowMs: 1_000, policy }), {
    kind: 'exhausted', attemptsMade: 3,
  })
})

test('ends a task on transport loss and never resumes it after reconnect', () => {
  const disconnected = markTransportDisconnected(startedTask(), {
    nowMs: 1_250,
    reason: 'socket closed',
    policy: { baseDelayMs: 100, maxDelayMs: 1_000, maxAttempts: 2 },
  })
  assert.equal(disconnected.state.transport.phase, 'reconnecting')
  assert.equal(disconnected.state.task?.phase, 'failed')
  assert.equal(disconnected.state.task?.terminalReason, 'socket closed')
  assert.deepEqual(disconnected.reconnect, { kind: 'scheduled', attempt: 1, delayMs: 100, dueAtMs: 1_350 })

  const reconnected = markTransportConnected(disconnected.state)
  assert.equal(reconnected.state.transport.phase, 'connected')
  assert.equal(reconnected.state.task?.phase, 'failed')
  assert.equal(reconnected.message.code, 'task_failed')
  assert.equal(reconnected.message.taskCompleted, false)
  assert.deepEqual(reconnected.actions, [])
})

test('ends a task immediately when cancellation is requested and keeps retry input', () => {
  const cancel = requestPromptCancel(startedTask('run-cancel'), 1_200)
  assert.equal(cancel.kind, 'send_cancel')
  if (cancel.kind !== 'send_cancel') throw new Error('expected a cancellation send')
  assert.equal(cancel.state.task?.phase, 'cancelled')
  assert.equal(cancel.state.task?.cancelRequestedAtMs, 1_200)
  assert.equal(cancel.state.task?.terminalAtMs, 1_200)

  const attachments = [{ id: 'attachment-1' }]
  const composer = { draft: '继续修复', attachments } as const
  const retry = planPromptRetry(cancel.state, composer)
  assert.equal(retry.kind, 'retry')
  assert.equal(retry.composer, composer)
  assert.equal(retry.composer.attachments, attachments)
})

test('rejects a conflicting late terminal update after a local abnormal or cancelled end', () => {
  const failed = markTransportDisconnected(startedTask('run-failed'), {
    nowMs: 1_200,
    reason: 'socket closed',
  }).state
  assert.equal(acceptsTerminalUpdate(failed.task, 'run-failed', 'failed'), true)
  assert.equal(acceptsTerminalUpdate(failed.task, 'run-failed', 'completed'), false)

  const cancelled = requestPromptCancel(startedTask('run-cancelled'), 1_200).state
  assert.equal(acceptsTerminalUpdate(cancelled.task, 'run-cancelled', 'cancelled'), true)
  assert.equal(acceptsTerminalUpdate(cancelled.task, 'run-cancelled', 'completed'), false)
  assert.equal(acceptsTerminalUpdate(cancelled.task, 'another-run', 'completed'), true)
})

test('treats a running or partially replayed prompt as interrupted when a session is loaded', () => {
  assert.equal(interruptedRunForSessionLoad({
    runningPromptId: 'backend-running',
    replayedRunId: 'replayed-run',
    task: startedTask('local-run').task,
  }), 'backend-running')
  assert.equal(interruptedRunForSessionLoad({ runningPromptId: '', replayedRunId: 'replayed-run', task: null }), 'replayed-run')
  assert.equal(interruptedRunForSessionLoad({ runningPromptId: null, replayedRunId: null, task: startedTask('local-run').task }), 'local-run')
  assert.equal(interruptedRunForSessionLoad({ runningPromptId: null, replayedRunId: null, task: null }), null)
})

test('keeps caller-owned composer payload unchanged in recovery snapshots and blocks retry after completion', () => {
  const attachments = [{ id: 'attachment-2', data: 'opaque' }]
  const composer = { draft: '不要丢失我的草稿', attachments } as const
  const completed = recordTaskTerminal(startedTask('run-complete'), {
    runId: 'run-complete', outcome: 'completed', observedAtMs: 1_500,
  })
  const snapshot = createSessionRecoverySnapshot(completed.state, composer)
  assert.equal(snapshot.composer, composer)
  assert.equal(snapshot.composer.attachments, attachments)
  assert.equal(snapshot.message.preserveComposer, true)

  const retry = planPromptRetry(completed.state, composer)
  assert.equal(retry.kind, 'blocked')
  assert.equal(retry.reason, 'completed')
  assert.equal(retry.composer, composer)
})
