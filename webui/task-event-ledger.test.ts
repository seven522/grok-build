import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createTaskEventLedger, taskEventLedgerMiddleware, type TaskEventAppendInput } from './task-event-ledger.ts'

const event = (overrides: Partial<TaskEventAppendInput> = {}): TaskEventAppendInput => ({
  type: 'task.created',
  taskId: 'task-alpha',
  projectId: 'project-alpha',
  runId: 'run-alpha',
  source: 'system',
  idempotencyKey: 'created:task-alpha',
  payload: { title: 'Alpha task' },
  ...overrides,
})

const withServer = async (handler: ReturnType<typeof taskEventLedgerMiddleware>, operation: (url: string) => Promise<void>) => {
  const server = createServer((request, response) => {
    void handler(request, response, (error) => {
      response.statusCode = error ? 500 : 404
      response.end(error instanceof Error ? error.message : 'Not found')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  try {
    await operation(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('persists typed append-only task events with stable IDs and idempotent replay', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-task-event-ledger-'))
  try {
    const storageDir = path.join(temporaryRoot, 'task-events')
    const ledger = createTaskEventLedger({ storageDir })
    const first = await ledger.append(event())
    const replay = await ledger.append(event({ timestamp: '2026-07-24T12:00:00+08:00' }))
    const second = await ledger.append(event({
      type: 'run.started',
      source: 'runner',
      idempotencyKey: 'run:run-alpha:started',
      payload: { pid: 12345 },
    }))

    assert.equal(first.appended, true)
    assert.equal(first.event.schema, 'runbuild.task-event.v1')
    assert.match(first.event.eventId, /^evt_[0-9a-f]{64}$/)
    assert.equal(first.event.sequence, 1)
    assert.equal(replay.appended, false)
    assert.deepEqual(replay.event, first.event)
    assert.equal(second.event.sequence, 2)
    assert.equal(second.event.projectId, 'project-alpha')
    assert.equal(second.event.runId, 'run-alpha')

    const restored = createTaskEventLedger({ storageDir })
    const page = await restored.read({ taskId: 'task-alpha' })
    assert.deepEqual(page.events.map((item) => item.eventId), [first.event.eventId, second.event.eventId])
    assert.equal(page.nextSequence, 3)
    assert.deepEqual((await restored.read({ taskId: 'task-alpha', afterSequence: 1, limit: 1 })).events, [second.event])

    await assert.rejects(
      restored.append(event({ type: 'task.loaded', payload: { title: 'A different event' } })),
      /idempotencyKey 已用于不同事件/,
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('accepts legacy ACP replay delivery metadata for the same source event', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-task-event-ledger-acp-replay-'))
  try {
    const storageDir = path.join(temporaryRoot, 'task-events')
    const first = createTaskEventLedger({ storageDir })
    const original = await first.append(event({
      type: 'run.completed',
      source: 'acp',
      idempotencyKey: 'acp:terminal-42',
      payload: {
        eventMeta: {
          sourceEventId: 'terminal-42',
          promptId: 'run-alpha',
          isReplay: true,
          agentTimestampMs: 1_785_000_000_000,
          turnStartMs: 1_785_000_000_100,
        },
        summary: 'completed',
      },
    }))
    const recovered = createTaskEventLedger({ storageDir })
    const replay = await recovered.append(event({
      type: 'run.completed',
      source: 'acp',
      idempotencyKey: 'acp:terminal-42',
      payload: {
        eventMeta: { sourceEventId: 'terminal-42', promptId: 'run-alpha' },
        summary: 'completed',
      },
    }))

    assert.equal(original.appended, true)
    assert.equal(replay.appended, false)
    assert.equal(replay.event.eventId, original.event.eventId)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('isolates task streams and recovers the final torn JSONL write', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-task-event-ledger-torn-'))
  try {
    const storageDir = path.join(temporaryRoot, 'task-events')
    const first = createTaskEventLedger({ storageDir })
    await first.append(event())
    await first.append(event({ taskId: 'task-beta', projectId: null, runId: null, idempotencyKey: 'created:task-beta' }))
    assert.equal((await first.read({ taskId: 'task-alpha' })).events.length, 1)
    assert.equal((await first.read({ taskId: 'task-beta' })).events.length, 1)

    const streamDirectory = path.join(storageDir, 'streams')
    const streams = await Promise.all((await readdir(streamDirectory))
      .filter((name) => name.endsWith('.jsonl'))
      .map(async (name) => ({ name, source: await readFile(path.join(streamDirectory, name), 'utf8') })))
    const alphaStream = streams.find((item) => item.source.includes('"taskId":"task-alpha"'))?.name
    assert.ok(alphaStream)
    await appendFile(path.join(streamDirectory, alphaStream), '{"schema":')
    const recovered = createTaskEventLedger({ storageDir })
    const page = await recovered.read({ taskId: 'task-alpha' })
    assert.equal(page.events.length, 1)
    assert.equal((await recovered.append(event({ type: 'task.loaded', idempotencyKey: 'loaded:task-alpha' }))).event.sequence, 2)
    assert.deepEqual((await createTaskEventLedger({ storageDir }).read({ taskId: 'task-alpha' })).events.map((item) => item.sequence), [1, 2])
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('accepts the P0 lifecycle, checkpoint, context, and memory event vocabulary', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-task-event-ledger-p0-types-'))
  try {
    const ledger = createTaskEventLedger({ storageDir: path.join(temporaryRoot, 'task-events') })
    const p0Types = [
      'state.changed',
      'cancel.requested',
      'checkpoint.created',
      'context.condensed',
      'memory.context.prepared',
      'memory.context.dispatched',
      'memory.proposed',
      'memory.committed',
    ] as const
    for (const [index, type] of p0Types.entries()) {
      const result = await ledger.append(event({
        type,
        idempotencyKey: `${type}:task-alpha`,
        payload: type === 'state.changed' ? { ordinal: index, state: 'running' } : { ordinal: index },
      }))
      assert.equal(result.event.type, type)
      assert.equal(result.event.sequence, index + 1)
    }
    assert.deepEqual((await ledger.read({ taskId: 'task-alpha' })).events.map((item) => item.type), p0Types)
    await assert.rejects(
      ledger.append(event({ type: 'state.unknown' as TaskEventAppendInput['type'], idempotencyKey: 'invalid-type' })),
      /type 无效/,
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('exposes an idempotent append and incremental read API for future projections', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-task-event-api-'))
  try {
    const ledger = createTaskEventLedger({ storageDir: path.join(temporaryRoot, 'task-events') })
    await withServer(taskEventLedgerMiddleware(ledger), async (url) => {
      const first = await fetch(`${url}/api/task-events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event()),
      })
      assert.equal(first.status, 201)
      const firstResult = await first.json() as { event: { eventId: string; sequence: number }; appended: boolean }
      assert.equal(firstResult.appended, true)
      const replay = await fetch(`${url}/api/task-events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event()),
      })
      assert.equal(replay.status, 200)
      const replayResult = await replay.json() as { event: { eventId: string; sequence: number }; appended: boolean }
      assert.equal(replayResult.appended, false)
      assert.equal(replayResult.event.eventId, firstResult.event.eventId)
      const page = await fetch(`${url}/api/task-events?taskId=task-alpha&afterSequence=0&limit=1`)
      assert.equal(page.status, 200)
      const pageResult = await page.json() as { taskId: string; events: Array<{ eventId: string; sequence: number }>; nextSequence: number }
      assert.equal(pageResult.taskId, 'task-alpha')
      assert.equal(pageResult.events.length, 1)
      assert.equal(pageResult.events[0].eventId, firstResult.event.eventId)
      assert.equal(pageResult.events[0].sequence, 1)
      assert.equal(pageResult.nextSequence, 2)
    })
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('finds a durable source event after the first 1,000 paged events', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-task-event-ledger-find-event-'))
  try {
    const ledger = createTaskEventLedger({ storageDir: path.join(temporaryRoot, 'task-events') })
    let targetEventId = ''
    for (let index = 0; index <= 1_000; index += 1) {
      const result = await ledger.append(event({
        type: 'state.changed',
        idempotencyKey: `state:source-scan:${index}`,
        payload: { index },
      }))
      if (index === 1_000) targetEventId = result.event.eventId
    }
    const firstPage = await ledger.read({ taskId: 'task-alpha', limit: 1_000 })
    assert.equal(firstPage.events.some((item) => item.eventId === targetEventId), false, 'the source event is beyond the first read page')
    const found = await ledger.findByEventId({ taskId: 'task-alpha', eventId: targetEventId })
    assert.equal(found?.eventId, targetEventId)
    assert.equal(found?.sequence, 1_001)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
