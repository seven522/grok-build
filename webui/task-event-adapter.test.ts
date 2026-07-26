import assert from 'node:assert/strict'
import test from 'node:test'

import { acpTaskEvent, acpTurnTerminalOutcome, appendTaskEvent } from './task-event-adapter.ts'

test('treats cancelled and abnormal turn_completed stop reasons as terminal cancellation or failure', () => {
  assert.equal(acpTurnTerminalOutcome({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }), 'completed')
  assert.equal(acpTurnTerminalOutcome({ sessionUpdate: 'turn_completed', stop_reason: 'cancelled' }), 'cancelled')
  assert.equal(acpTurnTerminalOutcome({ sessionUpdate: 'turn_completed', stop_reason: 'error' }), 'failed')
  assert.equal(acpTurnTerminalOutcome({ sessionUpdate: 'turn_completed', stop_reason: 'rate_limit' }), 'failed')
  assert.equal(acpTurnTerminalOutcome({ sessionUpdate: 'turn_failed' }), 'failed')
  assert.equal(acpTurnTerminalOutcome({ sessionUpdate: 'turn_cancelled' }), 'cancelled')
  assert.equal(acpTurnTerminalOutcome({ sessionUpdate: 'agent_message_chunk' }), null)
})

test('adapts ACP tool updates into durable receipts without persisting secret-bearing raw output', () => {
  const event = acpTaskEvent({
    taskId: 'session-alpha',
    projectId: 'project-alpha',
    runId: 'run-alpha',
    eventMeta: { eventId: 'acp-event-42', timestamp: '2026-07-24T12:00:00.000Z' },
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-run-tests',
      title: 'Run verification',
      status: 'completed',
      rawInput: { command: 'npm run test', token: 'must-not-persist' },
      rawOutput: {
        type: 'Bash',
        command: 'npm run test',
        exit_code: 0,
        output: 'secret command output',
        timed_out: false,
      },
    },
  })

  assert.deepEqual(event, {
    type: 'tool.updated',
    taskId: 'session-alpha',
    projectId: 'project-alpha',
    runId: 'run-alpha',
    source: 'acp',
    idempotencyKey: 'acp:acp-event-42',
    timestamp: '2026-07-24T12:00:00.000Z',
    payload: {
      toolCallId: 'tool-run-tests',
      title: 'Run verification',
      status: 'completed',
      eventMeta: { sourceEventId: 'acp-event-42' },
      rawInput: { command: 'npm run test' },
      rawOutput: {
        type: 'Bash',
        command: 'npm run test',
        exit_code: 0,
        output: true,
        timed_out: false,
      },
    },
  })
  assert.equal(JSON.stringify(event).includes('must-not-persist'), false)
  assert.equal(JSON.stringify(event).includes('secret command output'), false)
})

test('persists bounded diagnostic codes instead of raw terminal text', () => {
  const event = acpTaskEvent({
    taskId: 'session-alpha',
    projectId: 'project-alpha',
    runId: 'run-alpha',
    eventMeta: { eventId: 'acp-event-diagnostic' },
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-run-godot',
      status: 'completed',
      rawInput: { command: 'godot --path .' },
      rawOutput: {
        type: 'Bash',
        command: 'godot --path .',
        exit_code: 0,
        output: 'token=must-not-persist\nSCRIPT ERROR: Parse Error\nApple Software Renderer',
      },
    },
  })

  const serialized = JSON.stringify(event)
  assert.deepEqual((event?.payload.rawOutput as Record<string, unknown>)?.diagnostic_codes, [
    'script-error',
    'parse-error',
    'software-renderer',
  ])
  assert.equal(serialized.includes('must-not-persist'), false)
  assert.equal(serialized.includes('SCRIPT ERROR'), false)
})

test('uses a deterministic fallback key and preserves the ACP terminal fact without treating it as verified completion', () => {
  const lifecycle = acpTaskEvent({
    taskId: 'session-alpha',
    projectId: null,
    runId: 'run-alpha',
    eventMeta: {},
    update: { sessionUpdate: 'turn_failed', reason: 'provider unavailable' },
  })
  const duplicateTool = acpTaskEvent({
    taskId: 'session-alpha',
    projectId: null,
    runId: 'run-alpha',
    eventMeta: {},
    update: { sessionUpdate: 'tool_call', toolCallId: 'read-project', title: 'Read project', status: 'pending' },
  })
  const repeatedLifecycle = acpTaskEvent({
    taskId: 'session-alpha',
    projectId: null,
    runId: 'run-alpha',
    eventMeta: {},
    update: { sessionUpdate: 'turn_failed', reason: 'provider unavailable' },
  })

  assert.equal(lifecycle?.type, 'run.failed')
  assert.match(lifecycle?.idempotencyKey ?? '', /^acp:run-alpha:turn_failed:[0-9a-f]{8}$/)
  assert.equal(repeatedLifecycle?.idempotencyKey, lifecycle?.idempotencyKey)
  assert.equal(duplicateTool?.type, 'tool.requested')
  assert.match(duplicateTool?.idempotencyKey ?? '', /^acp:run-alpha:tool_call:[0-9a-f]{8}$/)
  const completed = acpTaskEvent({
    taskId: 'session-alpha',
    projectId: null,
    runId: 'run-alpha',
    eventMeta: { eventId: 'terminal-99', promptId: 'run-alpha', agentTimestampMs: 1_785_000_000_000, isReplay: true },
    update: { sessionUpdate: 'turn_completed' },
  })
  assert.equal(completed?.type, 'run.completed')
  assert.equal(completed?.idempotencyKey, 'acp:terminal-99')
  assert.equal(completed?.timestamp, '2026-07-25T17:20:00.000Z')
  assert.deepEqual(completed?.payload.eventMeta, {
    sourceEventId: 'terminal-99',
    promptId: 'run-alpha',
  })
  const completedOriginal = acpTaskEvent({
    taskId: 'session-alpha',
    projectId: null,
    runId: 'run-alpha',
    eventMeta: { eventId: 'terminal-99', promptId: 'run-alpha', agentTimestampMs: 1_785_000_000_000 },
    update: { sessionUpdate: 'turn_completed' },
  })
  // Delivery replay must retain ACP's source-event idempotency rather than
  // mutate the durable event payload and create a 400 conflict on restore.
  assert.deepEqual(completed, completedOriginal)

  const cancelled = acpTaskEvent({
    taskId: 'session-alpha',
    projectId: null,
    runId: 'run-cancelled',
    eventMeta: { eventId: 'terminal-cancelled', promptId: 'run-cancelled' },
    update: { sessionUpdate: 'turn_completed', stop_reason: 'cancelled' },
  })
  assert.equal(cancelled?.type, 'run.cancelled')

  const failed = acpTaskEvent({
    taskId: 'session-alpha',
    projectId: null,
    runId: 'run-failed',
    eventMeta: { eventId: 'terminal-failed', promptId: 'run-failed' },
    update: { sessionUpdate: 'turn_completed', stop_reason: 'error' },
  })
  assert.equal(failed?.type, 'run.failed')

  assert.equal(acpTaskEvent({
    taskId: 'session-alpha',
    projectId: null,
    runId: 'run-alpha',
    eventMeta: { eventId: 'checkpoint-1' },
    update: { sessionUpdate: 'checkpoint_created', message: 'checkpoint saved' },
  })?.type, 'checkpoint.created')
  assert.equal(acpTaskEvent({
    taskId: 'session-alpha',
    projectId: null,
    runId: 'run-alpha',
    eventMeta: { eventId: 'memory-1' },
    update: { sessionUpdate: 'memory_proposed', message: 'project uses Godot' },
  })?.type, 'memory.proposed')
})

test('posts task events through the protected local API and exposes ledger failures to the caller', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const appendResult = await appendTaskEvent(async (url, init) => {
    requests.push({ url, init })
    return new Response(JSON.stringify({ appended: true, event: { eventId: 'evt_1', sequence: 1, timestamp: '2026-07-24T12:00:00.000Z' } }), { status: 201 })
  }, {
    type: 'task.created',
    taskId: 'session-alpha',
    projectId: null,
    runId: null,
    source: 'ui',
    idempotencyKey: 'task:session-alpha:created',
    payload: { title: 'Alpha' },
  })
  assert.equal(requests.length, 1)
  assert.deepEqual(appendResult, { appended: true, event: { eventId: 'evt_1', sequence: 1, timestamp: '2026-07-24T12:00:00.000Z' } })
  assert.equal(requests[0].url, '/api/task-events')
  assert.equal(requests[0].init?.method, 'POST')
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    type: 'task.created',
    taskId: 'session-alpha',
    projectId: null,
    runId: null,
    source: 'ui',
    idempotencyKey: 'task:session-alpha:created',
    payload: { title: 'Alpha' },
  })

  await assert.rejects(() => appendTaskEvent(async () => new Response(JSON.stringify({ error: 'Denied' }), { status: 403 }), {
    type: 'task.created', taskId: 'session-beta', projectId: null, runId: null, source: 'ui', idempotencyKey: 'task:session-beta:created', payload: {},
  }), /任务账本写入失败 \(403\)：Denied/)
})
