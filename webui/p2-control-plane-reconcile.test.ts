import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createP2ControlPlane } from './p2-control-plane.ts'
import { createProviderRegistry } from './provider-registry.ts'
import { TASK_EVENT_SCHEMA, createTaskEventLedger, type TaskEvent, type TaskEventAppendInput, type TaskEventLedger } from './task-event-ledger.ts'

const memoryScope = {
  userId: 'local-user',
  projectId: null,
  agentId: null,
  runId: null,
} as const

const withServer = async (
  middleware: ReturnType<typeof createP2ControlPlane>['middleware'],
  operation: (baseUrl: string) => Promise<void>,
) => {
  const server = createServer((request, response) => {
    void middleware(request, response, (error) => {
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

const p2Options = (storageDir: string, taskEventLedger: TaskEventLedger) => ({
  storageDir,
  taskEventLedger,
  providerRegistry: createProviderRegistry({ statePath: path.join(storageDir, 'providers.json') }),
  getRuntimeModelAvailability: () => [],
  projectExists: async () => false,
  projectRules: async () => [],
})

const appendSource = (ledger: TaskEventLedger, suffix: string) => ledger.append({
  type: 'run.started',
  taskId: `reconcile-task-${suffix}`,
  projectId: null,
  runId: `reconcile-run-${suffix}`,
  source: 'acp',
  idempotencyKey: `source-${suffix}`,
  payload: { source: suffix },
})

const sourcedMemoryRequest = (source: { taskId: string; runId: string; eventId: string }, idempotencyKey: string) => ({
  projectId: null,
  sourceTaskId: source.taskId,
  sourceRunId: source.runId,
  sourceEventId: source.eventId,
  idempotencyKey,
  writePath: 'remember',
  title: '可恢复记忆',
  fact: '偏好简洁回答。API_KEY=sk-1234567890abcdef',
})

const faultingLedger = (ledger: TaskEventLedger, fault: 'after-proposed' | 'before-committed'): TaskEventLedger => {
  let shouldFault = true
  return {
    storageDir: ledger.storageDir,
    read: ledger.read,
    findByEventId: ledger.findByEventId,
    append: async (input: TaskEventAppendInput) => {
      if (shouldFault && input.type === 'memory.proposed' && fault === 'after-proposed') {
        shouldFault = false
        await ledger.append(input)
        throw new Error('simulated crash after durable proposal')
      }
      if (shouldFault && input.type === 'memory.committed' && fault === 'before-committed') {
        shouldFault = false
        throw new Error('simulated crash after durable memory store')
      }
      return ledger.append(input)
    },
  }
}

test('P2 reconciles a sourced memory when crash occurs after proposal or after store, without duplicate audit facts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runbuild-p2-memory-reconcile-'))
  try {
    for (const fault of ['after-proposed', 'before-committed'] as const) {
      const caseRoot = path.join(root, fault)
      const ledger = createTaskEventLedger({ storageDir: path.join(caseRoot, 'ledger') })
      const sourceAppend = await appendSource(ledger, fault)
      const source = {
        taskId: `reconcile-task-${fault}`,
        runId: `reconcile-run-${fault}`,
        eventId: sourceAppend.event.eventId,
      }
      const first = createP2ControlPlane(p2Options(path.join(caseRoot, 'p2'), faultingLedger(ledger, fault)))
      await withServer(first.middleware, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/memories`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(sourcedMemoryRequest(source, `memory-reconcile-${fault}`)),
        })
        assert.equal(response.status, 400, 'the injected crash must interrupt the original request')
      })

      const journalPath = path.join(caseRoot, 'p2', 'sourced-memory-reconcile.json')
      const journal = await readFile(journalPath, 'utf8')
      assert.equal(journal.includes('sk-1234567890abcdef'), false, 'the reconciliation journal must never persist raw credential-shaped fact content')
      assert.equal(journal.includes('[REDACTED]'), true)

      const restarted = createP2ControlPlane(p2Options(path.join(caseRoot, 'p2'), ledger))
      await withServer(restarted.middleware, async (baseUrl) => {
        const context = await fetch(`${baseUrl}/api/memories/context`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId: null, query: '简洁回答', maxChars: 1_500 }),
        })
        assert.equal(context.status, 200, 'a prompt-context read after cold restart must reconcile pending sourced writes before recall')
        assert.equal((await context.json() as { context: { includedMemoryIds: string[] } }).context.includedMemoryIds.length, 1)
        const response = await fetch(`${baseUrl}/api/memories?projectId=root&includeUserScoped=true`)
        assert.equal(response.status, 200, 'a normal memory read after cold restart must reconcile pending sourced writes')
        const payload = await response.json() as { memories: Array<{ id: string; provenance: { sourceEventIds: string[] } }> }
        assert.equal(payload.memories.length, 1)
        assert.deepEqual(payload.memories[0]?.provenance.sourceEventIds, [source.eventId])
      })

      const reconciled = await restarted.reconcileSourcedMemories()
      assert.deepEqual(reconciled, [], 'committed journal entries must not replay on later recovery passes')
      const events = await ledger.read({ taskId: source.taskId, limit: 1_000 })
      assert.deepEqual(events.events.map((event) => event.type), ['run.started', 'memory.proposed', 'memory.committed'])
      assert.equal((await restarted.memoryStore.list({ scope: memoryScope, includeUserScoped: true })).length, 1)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('P2 source lookup calls the ledger index rather than a first-page scan', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runbuild-p2-source-index-'))
  try {
    const ledger = createTaskEventLedger({ storageDir: path.join(root, 'ledger') })
    const sourceAppend = await appendSource(ledger, 'indexed')
    const indexedOnlyLedger: TaskEventLedger = {
      storageDir: ledger.storageDir,
      append: ledger.append,
      findByEventId: ledger.findByEventId,
      read: async () => { throw new Error('P2 source lookup must not scan a paged ledger read') },
    }
    const controlPlane = createP2ControlPlane(p2Options(path.join(root, 'p2'), indexedOnlyLedger))
    await withServer(controlPlane.middleware, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/memories`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sourcedMemoryRequest({
          taskId: 'reconcile-task-indexed',
          runId: 'reconcile-run-indexed',
          eventId: sourceAppend.event.eventId,
        }, 'memory-indexed-source')),
      })
      assert.equal(response.status, 201)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('P2 settles a long source run after its terminal and verifier receipts fall beyond page 1,000', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runbuild-p2-long-source-run-'))
  try {
    const backingLedger = createTaskEventLedger({ storageDir: path.join(root, 'ledger') })
    const taskId = 'long-source-task'
    const sourceRunId = 'long-source-run'
    const event = (sequence: number, type: TaskEvent['type'], runId: string | null, source: TaskEvent['source'], payload: TaskEvent['payload']): TaskEvent => ({
      schema: TASK_EVENT_SCHEMA,
      eventId: `evt_long_${sequence}`,
      type,
      taskId,
      projectId: null,
      runId,
      sequence,
      timestamp: `2026-07-25T10:${String(Math.floor(sequence / 60)).padStart(2, '0')}:${String(sequence % 60).padStart(2, '0')}.000Z`,
      source,
      idempotencyKey: `long:${sequence}`,
      payload,
    })
    const firstPage = Array.from({ length: 1_000 }, (_, index) => event(index + 1, 'state.changed', 'other-run', 'system', { index }))
    const terminal = event(1_001, 'run.completed', sourceRunId, 'acp', { terminal: true })
    const verification = event(1_002, 'verification.recorded', sourceRunId, 'verifier', {
      status: 'verified',
      verifierId: 'long-run-receipt',
      evidenceIds: ['tool:long-readback'],
    })
    const pagedLedger: TaskEventLedger = {
      storageDir: backingLedger.storageDir,
      append: backingLedger.append,
      findByEventId: backingLedger.findByEventId,
      read: async (options) => {
        assert.equal(options.taskId, taskId)
        if ((options.afterSequence ?? 0) === 0) return { taskId, events: firstPage, nextSequence: 1_003 }
        if (options.afterSequence === 1_000) return { taskId, events: [terminal, verification], nextSequence: 1_003 }
        return { taskId, events: [], nextSequence: 1_003 }
      },
    }
    const controlPlane = createP2ControlPlane(p2Options(path.join(root, 'p2'), pagedLedger))
    await withServer(controlPlane.middleware, async (baseUrl) => {
      const created = await fetch(`${baseUrl}/api/goal-executions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          taskId,
          projectId: null,
          authorizationMode: 'manual-current',
          operationId: 'long-source-goal',
          goal: '等待长任务的不可变验证收据。',
        }),
      })
      assert.equal(created.status, 201)
      const goal = await created.json() as { goal: { runId: string } }
      const settled = await fetch(`${baseUrl}/api/goal-executions/${encodeURIComponent(goal.goal.runId)}/settle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          taskId,
          projectId: null,
          sourceRunId,
          authorizationMode: 'manual-current',
          operationId: 'long-source-settle',
        }),
      })
      assert.equal(settled.status, 200)
      assert.equal((await settled.json() as { goal: { completionAccepted: boolean } }).goal.completionAccepted, true)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
