import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DEFAULT_MODEL_PROFILE } from './model-profile.ts'
import { startLocalServer } from './desktop/local-server.ts'

type LocalServer = Awaited<ReturnType<typeof startLocalServer>>

const startServer = (root: string, grokHome: string, distDir: string) => startLocalServer({
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

const authenticatedSession = async (server: LocalServer) => {
  const shell = await fetch(server.url)
  assert.equal(shell.status, 200)
  const cookie = shell.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  return (requestPath: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set('cookie', cookie)
    headers.set('origin', new URL(server.url).origin)
    return fetch(new URL(requestPath, server.url), { ...init, headers })
  }
}

const append = async (request: Awaited<ReturnType<typeof authenticatedSession>>, input: Record<string, unknown>) => {
  const response = await request('/api/task-events', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  })
  assert.equal(response.status, 201)
  return response.json() as Promise<{ event: { eventId: string } }>
}

test('P3A desktop API persists a review-first automation through real task and verification receipts', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runbuild-p3-acceptance-'))
  const distDir = path.join(root, 'dist')
  const grokHome = path.join(root, 'runtime')
  await mkdir(distDir, { recursive: true })
  await mkdir(grokHome, { recursive: true })
  await writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>RunBuild P3</title>')

  let server: LocalServer | undefined = await startServer(root, grokHome, distDir)
  context.after(async () => {
    await server?.stop()
    await rm(root, { recursive: true, force: true })
  })

  const unauthenticated = await fetch(new URL('/api/automations', server.url))
  assert.equal(unauthenticated.status, 403, 'automation control uses the same desktop local-session gate')

  let request = await authenticatedSession(server)
  const createdResponse = await request('/api/automations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: 'p3-create',
      name: '本地验收巡检',
      instruction: '检查任务账本，不要自动修改文件。',
      projectId: null,
      schedule: { kind: 'manual' },
      policy: { permission: 'manual-current', tokenBudget: 'unsupported', maxAttempts: 2, maxWallClockMinutes: 30 },
    }),
  })
  assert.equal(createdResponse.status, 201)
  const automation = (await createdResponse.json() as { automation: { id: string; schedule: { kind: string }; policy: { permission: string } } }).automation
  assert.equal(automation.schedule.kind, 'manual')
  assert.equal(automation.policy.permission, 'manual-current')

  const queuedResponse = await request(`/api/automations/${encodeURIComponent(automation.id)}/enqueue`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId: 'p3-enqueue' }),
  })
  assert.equal(queuedResponse.status, 201)
  const queued = (await queuedResponse.json() as { run: { id: string; state: string } }).run
  assert.equal(queued.state, 'queued')

  const claimedResponse = await request(`/api/automation-runs/${encodeURIComponent(queued.id)}/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId: 'p3-claim', clientId: 'desktop-test' }),
  })
  assert.equal(claimedResponse.status, 200)
  const claimed = await claimedResponse.json() as { launch: { claimId: string; instruction: string; permission: string } }
  assert.equal(claimed.launch.permission, 'manual-current')
  assert.equal(claimed.launch.instruction, '检查任务账本，不要自动修改文件。')

  const taskCreated = await append(request, {
    type: 'task.created', taskId: 'p3-task', projectId: null, runId: null, source: 'ui', idempotencyKey: 'p3-task-created', payload: { title: 'P3 review task' },
  })
  const bindResponse = await request(`/api/automation-runs/${encodeURIComponent(queued.id)}/bind-task`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: 'p3-bind', clientId: 'desktop-test', claimId: claimed.launch.claimId, taskId: 'p3-task', taskCreatedEventId: taskCreated.event.eventId }),
  })
  assert.equal(bindResponse.status, 200)
  assert.equal((await bindResponse.json() as { run: { state: string } }).run.state, 'prepared')

  const started = await append(request, {
    type: 'run.started', taskId: 'p3-task', projectId: null, runId: 'p3-agent-run', source: 'ui', idempotencyKey: 'p3-run-started',
    payload: { automationRunId: queued.id },
  })
  const prepareResponse = await request(`/api/automation-runs/${encodeURIComponent(queued.id)}/prepare-dispatch`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: 'p3-prepare', clientId: 'desktop-test', claimId: claimed.launch.claimId, taskId: 'p3-task', agentRunId: 'p3-agent-run', runStartedEventId: started.event.eventId }),
  })
  assert.equal(prepareResponse.status, 200)
  const confirmResponse = await request(`/api/automation-runs/${encodeURIComponent(queued.id)}/confirm-dispatch`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: 'p3-confirm', clientId: 'desktop-test', claimId: claimed.launch.claimId, taskId: 'p3-task', agentRunId: 'p3-agent-run' }),
  })
  assert.equal(confirmResponse.status, 200)

  await append(request, {
    type: 'run.completed', taskId: 'p3-task', projectId: null, runId: 'p3-agent-run', source: 'acp', idempotencyKey: 'p3-run-completed', payload: {},
  })
  await append(request, {
    type: 'verification.recorded', taskId: 'p3-task', projectId: null, runId: 'p3-agent-run', source: 'verifier', idempotencyKey: 'p3-verification', payload: { status: 'verified', verifierId: 'p3-test', evidenceIds: ['readback'] },
  })
  const settledResponse = await request(`/api/automation-runs/${encodeURIComponent(queued.id)}/reconcile`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId: 'p3-reconcile' }),
  })
  assert.equal(settledResponse.status, 200)
  assert.equal((await settledResponse.json() as { run: { state: string } }).run.state, 'succeeded')

  await server.stop()
  server = await startServer(root, grokHome, distDir)
  request = await authenticatedSession(server)
  const restoredRuns = await request(`/api/automation-runs?automationId=${encodeURIComponent(automation.id)}`)
  assert.equal(restoredRuns.status, 200)
  assert.equal((await restoredRuns.json() as { runs: Array<{ id: string; state: string }> }).runs.find((run) => run.id === queued.id)?.state, 'succeeded', 'a cold desktop restart preserves the reviewable receipt')
})
