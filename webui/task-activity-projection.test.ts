import assert from 'node:assert/strict'
import test from 'node:test'
import type { TaskEvent } from './task-event-ledger.ts'
import { projectTaskActivity } from './task-activity-projection.ts'

const event = (sequence: number, type: TaskEvent['type'], payload: TaskEvent['payload'] = {}): TaskEvent => ({
  schema: 'runbuild.task-event.v1',
  eventId: `evt_${String(sequence).padStart(64, '0')}`,
  type,
  taskId: 'task-alpha',
  projectId: null,
  runId: 'run-alpha',
  sequence,
  timestamp: `2026-07-25T00:00:${String(sequence).padStart(2, '0')}.000Z`,
  source: 'acp',
  idempotencyKey: `event:${sequence}`,
  payload,
})

test('projects durable recovery activity without leaking message or raw tool content', () => {
  const activities = projectTaskActivity([
    event(1, 'message.user.created', { text: 'secret prompt' }),
    event(2, 'tool.updated', { title: 'Apply patch', status: 'completed', rawOutput: { output: 'secret tool output' } }),
    event(3, 'permission.requested', { action: 'write file', token: 'secret token' }),
    event(4, 'verification.recorded', { status: 'verified', output: 'secret verifier data' }),
    event(5, 'memory.context.dispatched', { injected: true, includedMemoryIds: ['mem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] }),
    event(6, 'state.changed', { state: 'verified' }),
  ])

  assert.deepEqual(activities.map((entry) => entry.sequence), [6, 5, 4, 3, 2])
  assert.deepEqual(activities.map((entry) => entry.tone), ['success', 'success', 'success', 'warning', 'success'])
  const serialized = JSON.stringify(activities)
  assert.equal(serialized.includes('secret prompt'), false)
  assert.equal(serialized.includes('secret tool output'), false)
  assert.equal(serialized.includes('secret token'), false)
  assert.equal(serialized.includes('secret verifier data'), false)
  assert.equal(serialized.includes('mem_aaaaaaaa'), false)
})

test('keeps bounded latest facts and maps recovery states', () => {
  const activities = projectTaskActivity([
    event(1, 'run.started'),
    event(2, 'state.changed', { state: 'timed_out' }),
    event(3, 'state.changed', { state: 'reconnecting' }),
    event(4, 'state.changed', { state: 'recovered' }),
  ], 2)

  assert.deepEqual(activities.map((entry) => entry.sequence), [4, 3])
  assert.equal(activities[0]?.text, 'Agent 连接已恢复。')
  assert.equal(activities[1]?.text, '正在恢复 Agent 连接。')
})

test('labels state updates without a lifecycle state as configuration changes', () => {
  const [activity] = projectTaskActivity([event(1, 'state.changed', { modelId: 'grok-4.5' })])
  assert.equal(activity?.text, '会话配置已更新。')
})

test('keeps native UI launch pending until the user records a visual readback', () => {
  const activities = projectTaskActivity([
    event(1, 'state.changed', { state: 'awaiting_visual_confirmation' }),
    event(2, 'verification.recorded', { status: 'ui_passed', kind: 'ui' }),
  ])

  assert.equal(activities[1]?.tone, 'warning')
  assert.equal(activities[1]?.text, '原生应用已启动，等待实际界面确认。')
  assert.equal(activities[0]?.tone, 'success')
  assert.equal(activities[0]?.text, '实际界面观察已确认。')
})
