import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DEFAULT_MODEL_PROFILE } from './model-profile.ts'
import { acpTaskEvent, appendTaskEvent, type TaskEventAppendResult, type TaskEventInput } from './task-event-adapter.ts'
import { createToolReceiptVerifier, type AcpToolUpdateEvidence } from './src/features/conversation/completion-evidence.ts'
import { startLocalServer } from './desktop/local-server.ts'

type LedgerEvent = {
  type: string
  eventId: string
  sequence: number
  payload: Record<string, unknown>
}

const ledgerFetch = (serverUrl: string, cookie: string) => async (url: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  headers.set('cookie', cookie)
  headers.set('origin', new URL(serverUrl).origin)
  return fetch(new URL(url, serverUrl), { ...init, headers })
}

test('P0 durable completion chain requires ledger-backed tool receipts rather than an ACP terminal message', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runbuild-p0-acceptance-'))
  const distDir = path.join(root, 'dist')
  const grokHome = path.join(root, 'runtime')
  await mkdir(distDir, { recursive: true })
  await mkdir(grokHome, { recursive: true })
  await writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>RunBuild P0</title>')

  const server = await startLocalServer({
    distDir,
    workspace: root,
    modelProfile: DEFAULT_MODEL_PROFILE,
    projectsRoot: path.join(grokHome, 'projects'),
    registryPath: path.join(grokHome, 'webui', 'projects.json'),
    preferencesPath: path.join(grokHome, 'webui', 'sidebar-preferences.json'),
    grokHome,
    binaryPath: process.execPath,
    getRootConnection: () => null,
    getRuntimeState: () => 'listening',
    getRuntimeError: () => undefined,
    getModelAvailability: () => [{ id: DEFAULT_MODEL_PROFILE, available: true }],
    getInitializationSnapshot: () => ({
      state: 'ready',
      steps: [
        { id: 'workspace', label: 'workspace', state: 'ready' },
        { id: 'workbench', label: 'workbench', state: 'ready' },
        { id: 'agent', label: 'agent', state: 'ready' },
      ],
    }),
  })
  context.after(async () => {
    await server.stop()
    await rm(root, { recursive: true, force: true })
  })

  const shell = await fetch(server.url)
  assert.equal(shell.status, 200)
  const cookie = shell.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie, 'desktop shell must issue an authenticated local-session cookie')
  const append = (event: TaskEventInput) => appendTaskEvent(ledgerFetch(server.url, cookie), event)
  const read = async (taskId: string) => {
    const response = await ledgerFetch(server.url, cookie)(`/api/task-events?taskId=${encodeURIComponent(taskId)}&limit=1000`)
    assert.equal(response.status, 200)
    return await response.json() as { events: LedgerEvent[]; nextSequence: number }
  }

  const unverifiedTaskId = 'p0-unverified-task'
  const unverifiedRunId = 'p0-unverified-run'
  const changeUpdate = {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'apply-patch',
    title: 'Apply source change',
    status: 'completed',
    rawInput: { command: 'apply_patch', token: 'must-not-reach-the-ledger' },
    rawOutput: {
      type: 'ApplyPatch',
      Success: { files: [{ path: 'src/agent.ts', action: 'modified' }] },
      output: 'must-not-reach-the-ledger',
    },
  }
  const unverifiedChange = acpTaskEvent({
    taskId: unverifiedTaskId,
    projectId: null,
    runId: unverifiedRunId,
    eventMeta: { eventId: 'unverified-patch', timestamp: '2026-07-24T10:00:00.000Z' },
    update: changeUpdate,
  })
  assert.ok(unverifiedChange)
  const unverifiedChangeReceipt = await append(unverifiedChange)
  const unverifiedTerminal = acpTaskEvent({
    taskId: unverifiedTaskId,
    projectId: null,
    runId: unverifiedRunId,
    eventMeta: { eventId: 'unverified-terminal', timestamp: '2026-07-24T10:00:01.000Z' },
    update: { sessionUpdate: 'turn_completed' },
  })
  assert.equal(unverifiedTerminal?.type, 'run.completed', 'the ACP terminal fact is durably recorded')
  const unverifiedTerminalReceipt = await append(unverifiedTerminal!)
  const incompleteEvidence: AcpToolUpdateEvidence[] = [{
    toolCallId: changeUpdate.toolCallId,
    title: changeUpdate.title,
    status: changeUpdate.status,
    rawInput: changeUpdate.rawInput,
    rawOutput: changeUpdate.rawOutput,
    eventId: unverifiedChangeReceipt.event.eventId,
    sequence: unverifiedChangeReceipt.event.sequence,
  }]
  assert.equal(createToolReceiptVerifier({
    scopeId: `${unverifiedTaskId}:${unverifiedRunId}:${unverifiedTerminalReceipt.event.eventId}`,
    checkedAt: unverifiedTerminalReceipt.event.timestamp,
    toolUpdates: incompleteEvidence,
  }), null, 'a terminal response with only a patch receipt cannot self-certify completion')
  const unverifiedEvents = await read(unverifiedTaskId)
  assert.deepEqual(unverifiedEvents.events.map((event) => event.type), ['tool.updated', 'run.completed'])
  assert.equal(unverifiedEvents.events.some((event) => event.type === 'verification.recorded'), false)

  const taskId = 'p0-verified-task'
  const runId = 'p0-verified-run'
  const prompt = await append({
    type: 'message.user.created',
    taskId,
    projectId: null,
    runId,
    source: 'ui',
    idempotencyKey: 'message:p0-verified:user',
    payload: { promptId: 'p0-prompt', hasText: true, attachmentCount: 0 },
  })
  const started = await append({
    type: 'run.started',
    taskId,
    projectId: null,
    runId,
    source: 'ui',
    idempotencyKey: 'run:p0-verified:started',
    payload: { promptId: 'p0-prompt' },
  })
  assert.equal(prompt.event.sequence, 1)
  assert.equal(started.event.sequence, 2)

  const change = acpTaskEvent({
    taskId,
    projectId: null,
    runId,
    eventMeta: { eventId: 'verified-patch', timestamp: '2026-07-24T10:01:00.000Z' },
    update: changeUpdate,
  })
  assert.ok(change)
  const changed = await append(change)
  const readbackUpdate = {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'read-after-patch',
    title: 'Read changed source',
    status: 'completed',
    rawOutput: {
      type: 'ReadFile',
      FileContent: { path: 'src/agent.ts', content: 'export const verified = true' },
    },
  }
  const readback = acpTaskEvent({
    taskId,
    projectId: null,
    runId,
    eventMeta: { eventId: 'verified-readback', timestamp: '2026-07-24T10:01:01.000Z' },
    update: readbackUpdate,
  })
  assert.ok(readback)
  const readbackReceipt = await append(readback)
  const agentText = acpTaskEvent({
    taskId,
    projectId: null,
    runId,
    eventMeta: { eventId: 'agent-says-done', timestamp: '2026-07-24T10:01:02.000Z' },
    update: { sessionUpdate: 'agent_message_chunk', content: '已经完成所有修改。' },
  })
  assert.ok(agentText)
  await append(agentText)
  const terminal = acpTaskEvent({
    taskId,
    projectId: null,
    runId,
    eventMeta: { eventId: 'verified-terminal', timestamp: '2026-07-24T10:01:03.000Z' },
    update: { sessionUpdate: 'turn_completed' },
  })
  assert.equal(terminal?.type, 'run.completed')
  const terminalReceipt = await append(terminal!)

  const verifiedEvidence: AcpToolUpdateEvidence[] = [
    {
      toolCallId: changeUpdate.toolCallId,
      title: changeUpdate.title,
      status: changeUpdate.status,
      rawInput: changeUpdate.rawInput,
      rawOutput: changeUpdate.rawOutput,
      eventId: changed.event.eventId,
      sequence: changed.event.sequence,
    },
    {
      toolCallId: readbackUpdate.toolCallId,
      title: readbackUpdate.title,
      status: readbackUpdate.status,
      rawOutput: readbackUpdate.rawOutput,
      eventId: readbackReceipt.event.eventId,
      sequence: readbackReceipt.event.sequence,
    },
  ]
  const verification = createToolReceiptVerifier({
    scopeId: `${taskId}:${runId}:${terminalReceipt.event.eventId}`,
    checkedAt: terminalReceipt.event.timestamp,
    toolUpdates: verifiedEvidence,
  })
  assert.ok(verification, 'a post-change readback plus terminal receipts must produce a verifier receipt')
  assert.equal(verification.report.acceptsCompletion, true)
  assert.equal(verification.report.status, 'verified')
  assert.equal(verification.verifier.evidenceIds.includes('agent-says-done'), false, 'assistant text is not accepted as verification evidence')

  const verificationReceipt = await append({
    type: 'verification.recorded',
    taskId,
    projectId: null,
    runId,
    source: 'verifier',
    idempotencyKey: `verification:${terminalReceipt.event.eventId}`,
    payload: {
      status: verification.report.status,
      verifierId: verification.verifier.id,
      changedFileCount: verification.report.changedFiles.files.length,
      readbackCount: verification.report.readbacks.length,
      cleanupStatus: verification.cleanup.status,
    },
  })
  await append({
    type: 'state.changed',
    taskId,
    projectId: null,
    runId,
    source: 'system',
    idempotencyKey: `state:${terminalReceipt.event.eventId}:verified`,
    payload: { state: 'verified', verificationEventId: verificationReceipt.event.eventId },
  })

  const replay = await append(terminal!)
  assert.equal(replay.appended, false, 'replayed ACP terminal events retain their original durable receipt')
  assert.equal(replay.event.eventId, terminalReceipt.event.eventId)
  assert.equal(replay.event.sequence, terminalReceipt.event.sequence)

  const events = await read(taskId)
  assert.deepEqual(events.events.map((event) => event.type), [
    'message.user.created',
    'run.started',
    'tool.updated',
    'tool.updated',
    'message.agent.delta',
    'run.completed',
    'verification.recorded',
    'state.changed',
  ])
  assert.deepEqual(events.events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(events.nextSequence, 9)
  const serialized = JSON.stringify(events)
  assert.equal(serialized.includes('must-not-reach-the-ledger'), false)
  assert.equal(serialized.includes('export const verified = true'), false)
  assert.equal(events.events.at(-1)?.payload.state, 'verified')
})
