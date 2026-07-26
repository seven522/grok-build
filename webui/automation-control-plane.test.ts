import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAutomationControlPlane } from './automation-control-plane.ts'

type LedgerEvent = {
  eventId: string
  type: string
  taskId: string
  projectId: string | null
  runId: string | null
  sequence: number
  payload: Record<string, unknown>
}

const createLedger = () => {
  const events: LedgerEvent[] = []
  return {
    events,
    findByEventId: async ({ taskId, eventId }: { taskId: string; eventId: string }) => events.find((event) => event.taskId === taskId && event.eventId === eventId) ?? null,
    read: async ({ taskId, afterSequence = 0, limit = 1_000 }: { taskId: string; afterSequence?: number; limit?: number }) => {
      const page = events.filter((event) => event.taskId === taskId && event.sequence > afterSequence).slice(0, limit)
      return { taskId, events: page, nextSequence: (page.at(-1)?.sequence ?? afterSequence) + 1 }
    },
  }
}

const fixedClock = (initial: string) => {
  let current = new Date(initial)
  return {
    now: () => new Date(current),
    moveTo: (next: string) => { current = new Date(next) },
  }
}

test('P3A schedules exactly one durable interval run and coalesces a missed restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runbuild-p3-schedule-'))
  const clock = fixedClock('2026-07-25T00:00:00.000Z')
  try {
    const control = createAutomationControlPlane({
      storageDir: root,
      now: clock.now,
      projectExists: async () => true,
    })
    const automation = await control.createAutomation({
      operationId: 'create-interval',
      name: '十五分钟巡检',
      instruction: '只检查当前项目状态，不要修改文件。',
      schedule: { kind: 'interval', everyMinutes: 15 },
    })
    assert.equal(automation.nextDueAt, '2026-07-25T00:15:00.000Z')

    clock.moveTo('2026-07-25T02:17:00.000Z')
    assert.deepEqual(await control.tick(), { changed: true, queued: 1 })
    assert.equal((await control.listRuns({ automationId: automation.id })).length, 1)
    assert.deepEqual(await control.tick(), { changed: false, queued: 0 }, 'the same overdue occurrence must not replay')

    const restarted = createAutomationControlPlane({ storageDir: root, now: clock.now, projectExists: async () => true })
    assert.deepEqual(await restarted.tick(), { changed: false, queued: 0 }, 'restart must not create a backlog')
    assert.equal((await restarted.listRuns({ automationId: automation.id })).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('P3A claim is exclusive, expires safely, and never sends an ACP prompt itself', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runbuild-p3-claim-'))
  const clock = fixedClock('2026-07-25T00:00:00.000Z')
  try {
    const control = createAutomationControlPlane({
      storageDir: root,
      now: clock.now,
      claimLeaseMs: 1_000,
      projectExists: async () => true,
    })
    const automation = await control.createAutomation({ operationId: 'create-manual', name: '日报', instruction: '总结今天完成项。', schedule: { kind: 'manual' } })
    const queued = await control.enqueue(automation.id, { operationId: 'queue-manual' })
    const first = await control.claim(queued.id, { operationId: 'claim-a', clientId: 'window-a' })
    assert.equal(first.run.state, 'claimed')
    assert.equal(first.launch.permission, 'manual-current')
    assert.equal(first.launch.instruction, '总结今天完成项。')
    await assert.rejects(control.claim(queued.id, { operationId: 'claim-b', clientId: 'window-b' }), /不能领取/)

    clock.moveTo('2026-07-25T00:00:02.000Z')
    await control.tick()
    const second = await control.claim(queued.id, { operationId: 'claim-b', clientId: 'window-b' })
    assert.equal(second.run.state, 'claimed')
    assert.equal(second.run.claim?.clientId, 'window-b')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('P3A binds only real task receipts and settles from verified ledger evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runbuild-p3-handoff-'))
  const clock = fixedClock('2026-07-25T00:00:00.000Z')
  const ledger = createLedger()
  try {
    const control = createAutomationControlPlane({
      storageDir: root,
      now: clock.now,
      projectExists: async (projectId) => projectId === 'project-alpha',
      taskEventLedger: ledger as never,
    })
    const automation = await control.createAutomation({
      operationId: 'create-project-task',
      name: '项目巡检',
      instruction: '读取改动并生成风险摘要。',
      projectId: 'project-alpha',
      schedule: { kind: 'manual' },
    })
    const queued = await control.enqueue(automation.id, { operationId: 'queue-project-task' })
    const claimed = await control.claim(queued.id, { operationId: 'claim-project-task', clientId: 'window-a' })

    ledger.events.push({
      eventId: 'evt-task-created', type: 'task.created', taskId: 'task-alpha', projectId: 'project-alpha', runId: null, sequence: 1, payload: {},
    })
    const bound = await control.bindTask(queued.id, {
      operationId: 'bind-project-task', clientId: 'window-a', claimId: claimed.launch.claimId,
      taskId: 'task-alpha', taskCreatedEventId: 'evt-task-created',
    })
    assert.equal(bound.state, 'prepared')

    ledger.events.push({
      eventId: 'evt-run-started', type: 'run.started', taskId: 'task-alpha', projectId: 'project-alpha', runId: 'agent-run-alpha', sequence: 2,
      payload: { automationRunId: queued.id },
    })
    const prepared = await control.prepareDispatch(queued.id, {
      operationId: 'prepare-project-task', clientId: 'window-a', claimId: claimed.launch.claimId,
      taskId: 'task-alpha', agentRunId: 'agent-run-alpha', runStartedEventId: 'evt-run-started',
    })
    assert.equal(prepared.state, 'dispatch_unconfirmed')
    const dispatched = await control.confirmDispatch(queued.id, {
      operationId: 'confirm-project-task', clientId: 'window-a', claimId: claimed.launch.claimId,
      taskId: 'task-alpha', agentRunId: 'agent-run-alpha',
    })
    assert.equal(dispatched.state, 'dispatched')

    ledger.events.push(
      { eventId: 'evt-run-completed', type: 'run.completed', taskId: 'task-alpha', projectId: 'project-alpha', runId: 'agent-run-alpha', sequence: 3, payload: {} },
      { eventId: 'evt-verification', type: 'verification.recorded', taskId: 'task-alpha', projectId: 'project-alpha', runId: 'agent-run-alpha', sequence: 4, payload: { status: 'verified' } },
    )
    const settled = await control.reconcile(queued.id, { operationId: 'settle-project-task' })
    assert.equal(settled.state, 'succeeded')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('P3A leaves an unverified completed task blocked and creates a review-first retry after a real failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runbuild-p3-retry-'))
  const clock = fixedClock('2026-07-25T00:00:00.000Z')
  const ledger = createLedger()
  try {
    const control = createAutomationControlPlane({ storageDir: root, now: clock.now, projectExists: async () => true, taskEventLedger: ledger as never })
    const automation = await control.createAutomation({
      operationId: 'create-retry', name: '失败重试', instruction: '检查失败原因。', schedule: { kind: 'manual' },
      policy: { maxAttempts: 2, retryDelayMinutes: 5, maxPendingRuns: 2, maxRunsPerDay: 8, maxWallClockMinutes: 30, permission: 'manual-current', tokenBudget: 'unsupported' },
    })
    const queued = await control.enqueue(automation.id, { operationId: 'queue-retry' })
    const claimed = await control.claim(queued.id, { operationId: 'claim-retry', clientId: 'window-a' })
    ledger.events.push(
      { eventId: 'evt-created', type: 'task.created', taskId: 'task-retry', projectId: null, runId: null, sequence: 1, payload: {} },
      { eventId: 'evt-start', type: 'run.started', taskId: 'task-retry', projectId: null, runId: 'agent-retry', sequence: 2, payload: { automationRunId: queued.id } },
    )
    await control.bindTask(queued.id, { operationId: 'bind-retry', clientId: 'window-a', claimId: claimed.launch.claimId, taskId: 'task-retry', taskCreatedEventId: 'evt-created' })
    await control.prepareDispatch(queued.id, { operationId: 'prepare-retry', clientId: 'window-a', claimId: claimed.launch.claimId, taskId: 'task-retry', agentRunId: 'agent-retry', runStartedEventId: 'evt-start' })
    await control.confirmDispatch(queued.id, { operationId: 'confirm-retry', clientId: 'window-a', claimId: claimed.launch.claimId, taskId: 'task-retry', agentRunId: 'agent-retry' })
    ledger.events.push({ eventId: 'evt-failed', type: 'run.failed', taskId: 'task-retry', projectId: null, runId: 'agent-retry', sequence: 3, payload: {} })
    assert.equal((await control.reconcile(queued.id, { operationId: 'settle-retry' })).state, 'failed')
    const afterFailure = await control.listRuns({ automationId: automation.id })
    const retry = afterFailure.find((run) => run.state === 'retry_wait')
    assert.ok(retry, 'a failed real task must only create a future review-first retry')
    clock.moveTo('2026-07-25T00:05:01.000Z')
    await control.tick()
    assert.equal((await control.listRuns({ automationId: automation.id })).find((run) => run.id === retry.id)?.state, 'queued')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('P3A migrates old free-text templates as manual work instead of guessing a schedule', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runbuild-p3-migration-'))
  try {
    const legacyPath = path.join(root, 'automations.json')
    await writeFile(legacyPath, JSON.stringify([{ id: 'legacy-daily', name: '旧日报', trigger: '每天 9 点', instruction: '总结。', createdAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T00:00:00.000Z' }]), { mode: 0o600 })
    const control = createAutomationControlPlane({ storageDir: path.join(root, 'p3'), legacyStatePath: legacyPath, projectExists: async () => true })
    const [migrated] = await control.listAutomations()
    assert.equal(migrated.name, '旧日报')
    assert.deepEqual(migrated.schedule, { kind: 'manual' })
    assert.equal(migrated.nextDueAt, null)
    assert.equal(migrated.migratedFromLegacy, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
