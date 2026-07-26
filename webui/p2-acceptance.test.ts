import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DEFAULT_MODEL_PROFILE } from './model-profile.ts'
import { startLocalServer } from './desktop/local-server.ts'

type LocalServer = Awaited<ReturnType<typeof startLocalServer>>

const sessionFetch = (serverUrl: string, cookie: string) => (requestPath: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  headers.set('cookie', cookie)
  headers.set('origin', new URL(serverUrl).origin)
  return fetch(new URL(requestPath, serverUrl), { ...init, headers })
}

const authenticatedSession = async (server: LocalServer) => {
  const shell = await fetch(server.url)
  assert.equal(shell.status, 200)
  const cookie = shell.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie, 'desktop shell must issue a local-session cookie')
  return sessionFetch(server.url, cookie)
}

const providerCapabilities = {
  sessions: { create: true, load: true, cancel: true, events: true },
  models: true,
  permissions: true,
  tools: true,
  context: true,
}

const appendEvent = async (request: ReturnType<typeof sessionFetch>, input: Record<string, unknown>) => {
  const response = await request('/api/task-events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  assert.equal(response.status, 201)
  return response.json() as Promise<{ event: { eventId: string } }>
}

test('P2 keeps provider, memory, verification, and synchronous subagent state inspectable across a cold desktop restart', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runbuild-p2-acceptance-'))
  const distDir = path.join(root, 'dist')
  const grokHome = path.join(root, 'runtime')
  await mkdir(distDir, { recursive: true })
  await mkdir(grokHome, { recursive: true })
  await writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>RunBuild P2</title>')

  const start = () => startLocalServer({
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

  let server: LocalServer | undefined = await start()
  context.after(async () => {
    await server?.stop()
    await rm(root, { recursive: true, force: true })
  })

  const unauthorized = await fetch(new URL('/api/providers', server.url))
  assert.equal(unauthorized.status, 403, 'P2 control endpoints require the desktop local-session cookie')

  let request = await authenticatedSession(server)
  const bridge = await request('/api/bridge-config')
  assert.equal(bridge.status, 200)
  const bridgeConfig = await bridge.json() as {
    providerRegistry: { defaultProviderId: string; providers: Array<{ id: string; route: string | null }> }
    providerHealth: { providers: Array<{ providerId: string; status: string }> }
  }
  assert.equal(bridgeConfig.providerRegistry.defaultProviderId, 'grok-acp')
  assert.equal(bridgeConfig.providerRegistry.providers[0]?.id, 'grok-acp')
  assert.equal(bridgeConfig.providerRegistry.providers[0]?.route, '/acp')
  assert.equal(bridgeConfig.providerHealth.providers[0].status, 'degraded', 'an unreported optional model must not be presented as ready')
  assert.equal(JSON.stringify(bridgeConfig).includes('secret'), false)

  const registeredProvider = await request('/api/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'future-acp',
      label: 'Future ACP',
      enabled: true,
      modelIds: ['future-1'],
      capabilities: providerCapabilities,
    }),
  })
  assert.equal(registeredProvider.status, 201)
  const providerPayload = await registeredProvider.json() as { provider: { runtimeBinding: string; route: string | null } }
  assert.equal(providerPayload.provider.runtimeBinding, 'unbound')
  assert.equal(providerPayload.provider.route, null)
  const unboundSelection = await request('/api/providers/select', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: 'future-acp', modelId: 'future-1', requiredCapabilities: ['session-create'] }),
  })
  assert.equal(unboundSelection.status, 409)
  assert.equal((await unboundSelection.json() as { selection: { reason: string } }).selection.reason, 'provider-runtime-unbound')

  const memorySource = await appendEvent(request, {
    type: 'run.started', taskId: 'p2-memory-task', projectId: null, runId: 'p2-memory-run', source: 'acp',
    idempotencyKey: 'p2-memory-source', payload: { phase: 'memory-source' },
  })
  const memoryResponse = await request('/api/memories', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: null,
      sourceTaskId: 'p2-memory-task',
      sourceRunId: 'p2-memory-run',
      sourceEventId: memorySource.event.eventId,
      idempotencyKey: 'p2-memory-write',
      writePath: 'remember',
      title: '回答偏好',
      fact: '用户偏好简洁中文回答。API_KEY=sk-1234567890abcdef',
      confidence: 0.92,
      pinned: true,
    }),
  })
  assert.equal(memoryResponse.status, 201)
  const memory = (await memoryResponse.json() as { memory: { id: string; fact: string; provenance: { sourceEventIds: string[] } } }).memory
  assert.match(memory.id, /^mem_[a-f0-9]{64}$/)
  assert.equal(memory.fact.includes('sk-1234567890abcdef'), false, 'credential-shaped fact text must be redacted before persistence')
  assert.equal(memory.fact.includes('[REDACTED]'), true)
  assert.deepEqual(memory.provenance.sourceEventIds, [memorySource.event.eventId])

  const memoryEvents = await request('/api/task-events?taskId=p2-memory-task')
  assert.equal(memoryEvents.status, 200)
  const memoryEventTypes = (await memoryEvents.json() as { events: Array<{ type: string }> }).events.map((event) => event.type)
  assert.deepEqual(memoryEventTypes, ['run.started', 'memory.proposed', 'memory.committed'])

  const forgedVerifiedCause = await request('/api/memories', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: null,
      sourceTaskId: 'p2-memory-task',
      sourceRunId: 'p2-memory-run',
      sourceEventId: memorySource.event.eventId,
      idempotencyKey: 'p2-forged-verified-cause',
      writePath: 'verified-fault-cause',
      title: '伪造的验证原因',
      fact: '浏览器任意输入不能获得已验证标签。',
    }),
  })
  assert.equal(forgedVerifiedCause.status, 400, 'browser input must not self-label a fact as independently verified')

  const missingSourceEvent = await request('/api/memories', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: null,
      sourceTaskId: 'p2-memory-task',
      sourceRunId: 'p2-memory-run',
      idempotencyKey: 'p2-missing-memory-source-event',
      writePath: 'remember',
      title: '来源不完整',
      fact: '带任务来源的记忆必须指定可验证事件。',
    }),
  })
  assert.equal(missingSourceEvent.status, 400, 'sourced memory must point at a pre-existing event rather than its own proposal')

  const manualMemoryPayload = {
    projectId: null,
    idempotencyKey: 'p2-manual-memory-retry',
    writePath: 'accepted-decision',
    title: '手动确认决策',
    fact: '用户明确确认的决策可作为本地记忆保存。',
  }
  const manualMemory = await request('/api/memories', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(manualMemoryPayload),
  })
  assert.equal(manualMemory.status, 201)
  const manualMemoryRecord = (await manualMemory.json() as { memory: { id: string; provenance: { sourceEventIds: string[] } } }).memory
  const retriedManualMemory = await request('/api/memories', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(manualMemoryPayload),
  })
  assert.equal(retriedManualMemory.status, 200, 'manual memory retries must preserve a deterministic manual provenance ID')
  const retriedManualMemoryRecord = (await retriedManualMemory.json() as { memory: { id: string; provenance: { sourceEventIds: string[] } } }).memory
  assert.equal(retriedManualMemoryRecord.id, manualMemoryRecord.id)
  assert.deepEqual(retriedManualMemoryRecord.provenance.sourceEventIds, manualMemoryRecord.provenance.sourceEventIds)

  const contextResponse = await request('/api/memories/context', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: null, query: '请用简洁中文回答', currentSessionSummary: '本轮是一个本地编码任务。', maxChars: 1_500 }),
  })
  assert.equal(contextResponse.status, 200)
  const builtContext = await contextResponse.json() as { adapter: string; context: { text: string; includedMemoryIds: string[] } }
  assert.equal(builtContext.adapter, 'runbuild-deterministic-facts-v1')
  assert.equal(builtContext.context.includedMemoryIds.includes(memory.id), true)
  assert.equal(builtContext.context.text.includes('sk-1234567890abcdef'), false)

  const goalTaskId = 'p2-goal-task'
  const sourceRunId = 'p2-source-run'
  await appendEvent(request, {
    type: 'run.completed', taskId: goalTaskId, projectId: null, runId: sourceRunId, source: 'acp',
    idempotencyKey: 'p2-goal-terminal', payload: { terminal: true },
  })
  await appendEvent(request, {
    type: 'verification.recorded', taskId: goalTaskId, projectId: null, runId: sourceRunId, source: 'verifier',
    idempotencyKey: 'p2-goal-verification',
    payload: { status: 'verified', verifierId: 'tool-receipt-test', evidenceIds: ['tool:readback', 'tool:command'] },
  })
  const createdGoal = await request('/api/goal-executions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      taskId: goalTaskId,
      projectId: null,
      sourceRunId,
      authorizationMode: 'manual-current',
      operationId: 'p2-goal-create',
      goal: '完成生产级编码验收',
    }),
  })
  assert.equal(createdGoal.status, 201)
  const goal = (await createdGoal.json() as { goal: { runId: string; state: string; completionAccepted: boolean } }).goal
  assert.equal(goal.state, 'executing')
  assert.equal(goal.completionAccepted, false)

  const settledGoal = await request(`/api/goal-executions/${encodeURIComponent(goal.runId)}/settle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      taskId: goalTaskId,
      projectId: null,
      authorizationMode: 'manual-current',
      sourceRunId,
      operationId: 'p2-goal-settle',
    }),
  })
  assert.equal(settledGoal.status, 200)
  const settled = (await settledGoal.json() as { goal: { state: string; completionAccepted: boolean; independentVerifierReceiptCount: number } }).goal
  assert.equal(settled.state, 'verified')
  assert.equal(settled.completionAccepted, true)
  assert.equal(settled.independentVerifierReceiptCount, 1)

  const wrongGoalScope = await request(`/api/goal-executions/${encodeURIComponent(goal.runId)}?taskId=${goalTaskId}&projectId=root&authorizationMode=approve-running`)
  assert.equal(wrongGoalScope.status, 409, 'a broader/different authorization scope must not read a goal run')

  const subagent = await request(`/api/goal-executions/${encodeURIComponent(goal.runId)}/subagents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      taskId: goalTaskId,
      projectId: null,
      authorizationMode: 'manual-current',
      operationId: 'p2-subagent-create',
      requestedGrantIds: ['permission:manual-current'],
      executionMode: 'synchronous',
    }),
  })
  assert.equal(subagent.status, 201)
  const subagentRun = (await subagent.json() as { subagent: { subagentRunId: string; executionMode: string; state: string } }).subagent
  assert.equal(subagentRun.executionMode, 'synchronous')
  assert.equal(subagentRun.state, 'running')

  const reportedSubagent = await request(`/api/goal-executions/${encodeURIComponent(goal.runId)}/subagents/${encodeURIComponent(subagentRun.subagentRunId)}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: goalTaskId, projectId: null, authorizationMode: 'manual-current', operationId: 'p2-subagent-report', claimId: 'p2-child-claim' }),
  })
  assert.equal(reportedSubagent.status, 200)
  assert.equal((await reportedSubagent.json() as { subagent: { state: string } }).subagent.state, 'awaiting_parent_verification')
  const disconnectedSubagent = await request(`/api/goal-executions/${encodeURIComponent(goal.runId)}/subagents/${encodeURIComponent(subagentRun.subagentRunId)}/disconnect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: goalTaskId, projectId: null, authorizationMode: 'manual-current', operationId: 'p2-subagent-disconnect' }),
  })
  assert.equal(disconnectedSubagent.status, 200)
  assert.equal((await disconnectedSubagent.json() as { subagent: { state: string; recovery: string } }).subagent.state, 'reconnecting')
  const recoveredSubagent = await request(`/api/goal-executions/${encodeURIComponent(goal.runId)}/subagents/${encodeURIComponent(subagentRun.subagentRunId)}/recover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: goalTaskId, projectId: null, authorizationMode: 'manual-current', operationId: 'p2-subagent-recover' }),
  })
  assert.equal(recoveredSubagent.status, 200)
  const recovered = await recoveredSubagent.json() as { subagent: { state: string }; action: { kind: string; executionMode: string } }
  assert.equal(recovered.subagent.state, 'awaiting_parent_verification')
  assert.deepEqual(recovered.action, { kind: 'resume_subagent', executionMode: 'synchronous', subagentRunId: subagentRun.subagentRunId, parentRunId: goal.runId })

  await server.stop()
  server = await start()
  request = await authenticatedSession(server)
  const afterRestartProviders = await request('/api/providers')
  assert.equal(afterRestartProviders.status, 200)
  assert.equal((await afterRestartProviders.json() as { registry: { providers: Array<{ id: string }> } }).registry.providers.some((provider) => provider.id === 'future-acp'), true)
  const afterRestartMemories = await request('/api/memories?projectId=root&includeUserScoped=true')
  assert.equal(afterRestartMemories.status, 200)
  assert.equal((await afterRestartMemories.json() as { memories: Array<{ id: string }> }).memories.some((entry) => entry.id === memory.id), true)
  const afterRestartGoal = await request(`/api/goal-executions/${encodeURIComponent(goal.runId)}?taskId=${goalTaskId}&projectId=root&authorizationMode=manual-current`)
  assert.equal(afterRestartGoal.status, 200)
  assert.equal((await afterRestartGoal.json() as { goal: { completionAccepted: boolean } }).goal.completionAccepted, true)
})
