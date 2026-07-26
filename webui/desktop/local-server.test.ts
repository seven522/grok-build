import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_MODEL_PROFILE } from '../model-profile.ts'
import { type RuntimeModelAvailability } from './agent-runtime.ts'
import { startLocalServer, type DesktopInitializationSnapshot, type DesktopRuntimeState } from './local-server.ts'

const rejectedUpgrade = (serverUrl: string, headers: Record<string, string>) => new Promise<string>((resolve, reject) => {
  const url = new URL(serverUrl)
  const socket = connect(Number(url.port), url.hostname)
  let response = ''
  socket.once('error', reject)
  socket.once('connect', () => {
    const extraHeaders = Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\r\n')
    socket.write(`GET /acp HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdC1rZXk=\r\nSec-WebSocket-Version: 13\r\n${extraHeaders}\r\n\r\n`)
  })
  socket.on('data', (chunk) => {
    response += chunk.toString()
    if (response.includes('\r\n\r\n')) {
      socket.destroy()
      resolve(response)
    }
  })
})

test('desktop bridge config follows live runtime state without exposing its connection secret', async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'grok-build-desktop-server-'))
  const distDir = path.join(root, 'dist')
  const grokHome = path.join(root, 'runtime')
  mkdirSync(distDir, { recursive: true })
  mkdirSync(grokHome, { recursive: true })
  writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>RunBuild</title>')

  let runtimeState: DesktopRuntimeState = 'starting'
  let runtimeError: string | undefined
  let connection: { target: string; secret: string } | null = null
  let modelAvailability: RuntimeModelAvailability[] = [
    { id: 'grok-4.5', available: true },
    { id: 'mimo', available: false, reason: 'credential-missing' as const },
    { id: 'deepseek-v4-pro', available: false, reason: 'credential-missing' as const },
  ]
  let initialization: DesktopInitializationSnapshot = {
    state: 'starting',
    steps: [
      { id: 'workspace', label: '准备本地工作区', state: 'ready' },
      { id: 'workbench', label: '启动桌面工作台', state: 'ready' },
      { id: 'agent', label: '连接本地 Agent', state: 'running' },
    ],
  }
  const server = await startLocalServer({
    distDir,
    workspace: root,
    modelProfile: DEFAULT_MODEL_PROFILE,
    projectsRoot: path.join(grokHome, 'projects'),
    registryPath: path.join(grokHome, 'webui', 'projects.json'),
    preferencesPath: path.join(root, 'user-data', 'sidebar-preferences.json'),
    grokHome,
    binaryPath: process.execPath,
    getRootConnection: () => connection,
    getRuntimeState: () => runtimeState,
    getRuntimeError: () => runtimeError,
    getModelAvailability: () => modelAvailability,
    getInitializationSnapshot: () => initialization,
  })
  context.after(async () => {
    await server.stop()
    rmSync(root, { recursive: true, force: true })
  })

  const unauthorizedResponse = await fetch(new URL('/api/bridge-config', server.url))
  assert.equal(unauthorizedResponse.status, 403)

  const shellResponse = await fetch(server.url)
  assert.equal(shellResponse.status, 200)
  const contentSecurityPolicy = shellResponse.headers.get('content-security-policy') ?? ''
  assert.match(contentSecurityPolicy, new RegExp(`connect-src 'self' ws://127\\.0\\.0\\.1:${new URL(server.url).port}`))
  assert.equal(contentSecurityPolicy.includes('ws://127.0.0.1:*'), false)
  const cookie = shellResponse.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  const authenticatedFetch = (requestPath: string) => fetch(new URL(requestPath, server.url), { headers: { cookie } })

  const missingOriginMutation = await fetch(new URL('/api/projects/pick-directory', server.url), {
    method: 'POST',
    headers: { cookie },
  })
  assert.equal(missingOriginMutation.status, 403)
  const sameOriginMutation = await fetch(new URL('/api/projects/pick-directory', server.url), {
    method: 'POST',
    headers: { cookie, origin: new URL(server.url).origin },
  })
  assert.equal(sameOriginMutation.status, 501)

  const wrongOriginUpgrade = await rejectedUpgrade(server.url, { Cookie: cookie, Origin: 'https://malicious.example' })
  assert.match(wrongOriginUpgrade, /^HTTP\/1\.1 403 Forbidden/)
  const missingCookieUpgrade = await rejectedUpgrade(server.url, { Origin: new URL(server.url).origin })
  assert.match(missingCookieUpgrade, /^HTTP\/1\.1 403 Forbidden/)

  const initialResponse = await authenticatedFetch('/api/bridge-config')
  const initial = await initialResponse.json() as Record<string, unknown>
  assert.equal(initial.enabled, false)
  assert.equal(initial.modelProfile, 'grok-4.5')
  assert.equal(initial.runtimeState, 'starting')
  assert.deepEqual(initial.modelAvailability, modelAvailability)
  assert.deepEqual(initial.initialization, initialization)

  const catalogResponse = await authenticatedFetch('/api/session-catalog')
  assert.equal(catalogResponse.status, 200)
  assert.deepEqual(await catalogResponse.json(), { sessions: [] })

  const taskEventPayload = {
    type: 'task.created',
    taskId: 'session-alpha',
    projectId: null,
    runId: null,
    source: 'ui',
    idempotencyKey: 'task:session-alpha:created',
    payload: { title: 'Alpha' },
  }
  const taskEventResponse = await fetch(new URL('/api/task-events', server.url), {
    method: 'POST',
    headers: { cookie, origin: new URL(server.url).origin, 'content-type': 'application/json' },
    body: JSON.stringify(taskEventPayload),
  })
  assert.equal(taskEventResponse.status, 201)
  const taskEvent = await taskEventResponse.json() as { appended: boolean; event: { sequence: number; eventId: string } }
  assert.equal(taskEvent.appended, true)
  assert.equal(taskEvent.event.sequence, 1)
  assert.match(taskEvent.event.eventId, /^evt_[0-9a-f]{64}$/)
  const replayTaskEventResponse = await fetch(new URL('/api/task-events', server.url), {
    method: 'POST',
    headers: { cookie, origin: new URL(server.url).origin, 'content-type': 'application/json' },
    body: JSON.stringify(taskEventPayload),
  })
  assert.equal(replayTaskEventResponse.status, 200)
  assert.equal((await replayTaskEventResponse.json() as { appended: boolean }).appended, false)
  const taskEventsResponse = await authenticatedFetch('/api/task-events?taskId=session-alpha')
  assert.equal(taskEventsResponse.status, 200)
  const taskEvents = await taskEventsResponse.json() as {
    taskId: string
    events: Array<{ eventId: string; sequence: number; type: string; timestamp: string }>
    nextSequence: number
  }
  assert.equal(taskEvents.taskId, 'session-alpha')
  assert.equal(taskEvents.events.length, 1)
  assert.equal(taskEvents.events[0].eventId, taskEvent.event.eventId)
  assert.equal(taskEvents.events[0].sequence, 1)
  assert.equal(taskEvents.events[0].type, 'task.created')
  assert.match(taskEvents.events[0].timestamp, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(taskEvents.nextSequence, 2)

  const taskWorkspaceDraftResponse = await fetch(new URL('/api/task-workspaces/session-alpha/draft', server.url), {
    method: 'PUT',
    headers: { cookie, origin: new URL(server.url).origin, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: null, text: '桌面重启后继续这项工作' }),
  })
  assert.equal(taskWorkspaceDraftResponse.status, 200)
  const taskWorkspaceDraft = await taskWorkspaceDraftResponse.json() as { task: { draft: { text: string }; attachments: unknown[] } }
  assert.equal(taskWorkspaceDraft.task.draft.text, '桌面重启后继续这项工作')
  assert.deepEqual(taskWorkspaceDraft.task.attachments, [])

  const attachmentPayload = 'task attachment should stay out of state json'
  const taskWorkspaceAttachmentResponse = await fetch(new URL('/api/task-workspaces/session-alpha/attachments/notes-1?projectId=root&name=notes.txt&kind=text', server.url), {
    method: 'PUT',
    headers: { cookie, origin: new URL(server.url).origin, 'content-type': 'text/plain' },
    body: attachmentPayload,
  })
  assert.equal(taskWorkspaceAttachmentResponse.status, 201)
  const taskWorkspaceAttachment = await taskWorkspaceAttachmentResponse.json() as { attachment: { id: string; name: string; size: number; sha256: string } }
  assert.equal(taskWorkspaceAttachment.attachment.id, 'notes-1')
  assert.equal(taskWorkspaceAttachment.attachment.name, 'notes.txt')
  assert.equal(taskWorkspaceAttachment.attachment.size, Buffer.byteLength(attachmentPayload))
  assert.match(taskWorkspaceAttachment.attachment.sha256, /^[a-f0-9]{64}$/)

  const pendingAttachmentDraftResponse = await fetch(new URL('/api/task-workspaces/session-alpha/draft', server.url), {
    method: 'PUT',
    headers: { cookie, origin: new URL(server.url).origin, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: null, text: '附件待发送', attachmentIds: ['notes-1'] }),
  })
  assert.equal(pendingAttachmentDraftResponse.status, 200)

  const taskWorkspaceResponse = await authenticatedFetch('/api/task-workspaces/session-alpha?projectId=root')
  assert.equal(taskWorkspaceResponse.status, 200)
  const taskWorkspace = await taskWorkspaceResponse.json() as { task: { draft: { text: string; attachmentIds: string[] }; attachments: Array<{ id: string; name: string }> } }
  assert.equal(taskWorkspace.task.draft.text, '附件待发送')
  assert.deepEqual(taskWorkspace.task.draft.attachmentIds, ['notes-1'])
  assert.deepEqual(taskWorkspace.task.attachments.map((attachment) => ({ id: attachment.id, name: attachment.name })), [{ id: 'notes-1', name: 'notes.txt' }])
  assert.equal(JSON.stringify(taskWorkspace).includes(attachmentPayload), false)

  const taskAttachmentReadResponse = await authenticatedFetch('/api/task-workspaces/session-alpha/attachments/notes-1?projectId=root')
  assert.equal(taskAttachmentReadResponse.status, 200)
  assert.equal(taskAttachmentReadResponse.headers.get('content-disposition')?.includes('notes.txt'), true)
  assert.equal(await taskAttachmentReadResponse.text(), attachmentPayload)
  const wrongScopeResponse = await authenticatedFetch('/api/task-workspaces/session-alpha?projectId=project-other')
  assert.equal(wrongScopeResponse.status, 409)

  const archiveTaskResponse = await fetch(new URL('/api/task-workspaces/session-alpha/lifecycle', server.url), {
    method: 'POST',
    headers: { cookie, origin: new URL(server.url).origin, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: null, action: 'archive' }),
  })
  assert.equal(archiveTaskResponse.status, 200)
  assert.equal((await archiveTaskResponse.json() as { task: { lifecycle: { state: string } } }).task.lifecycle.state, 'archived')
  const restoreTaskResponse = await fetch(new URL('/api/task-workspaces/session-alpha/lifecycle', server.url), {
    method: 'POST',
    headers: { cookie, origin: new URL(server.url).origin, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: null, action: 'restore' }),
  })
  assert.equal(restoreTaskResponse.status, 200)
  assert.equal((await restoreTaskResponse.json() as { task: { lifecycle: { state: string } } }).task.lifecycle.state, 'active')

  const projectCreateResponse = await fetch(new URL('/api/projects', server.url), {
    method: 'POST',
    headers: { cookie, origin: new URL(server.url).origin, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Lifecycle Project' }),
  })
  assert.equal(projectCreateResponse.status, 201)
  const lifecycleProject = await projectCreateResponse.json() as { project: { id: string; rootPath: string } }
  const projectTaskDraftResponse = await fetch(new URL('/api/task-workspaces/project-task/draft', server.url), {
    method: 'PUT',
    headers: { cookie, origin: new URL(server.url).origin, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: lifecycleProject.project.id, text: 'project scoped draft' }),
  })
  assert.equal(projectTaskDraftResponse.status, 200)
  const projectTaskRunningResponse = await fetch(new URL('/api/task-workspaces/project-task/lifecycle', server.url), {
    method: 'POST',
    headers: { cookie, origin: new URL(server.url).origin, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: lifecycleProject.project.id, action: 'mark-running' }),
  })
  assert.equal(projectTaskRunningResponse.status, 200)
  const blockedProjectArchiveResponse = await fetch(new URL(`/api/task-workspaces/projects/${encodeURIComponent(lifecycleProject.project.id)}/lifecycle`, server.url), {
    method: 'POST',
    headers: { cookie, origin: new URL(server.url).origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'archive' }),
  })
  assert.equal(blockedProjectArchiveResponse.status, 409)
  const projectTaskIdleResponse = await fetch(new URL('/api/task-workspaces/project-task/lifecycle', server.url), {
    method: 'POST',
    headers: { cookie, origin: new URL(server.url).origin, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: lifecycleProject.project.id, action: 'mark-idle' }),
  })
  assert.equal(projectTaskIdleResponse.status, 200)
  const projectArchiveResponse = await fetch(new URL(`/api/task-workspaces/projects/${encodeURIComponent(lifecycleProject.project.id)}/lifecycle`, server.url), {
    method: 'POST',
    headers: { cookie, origin: new URL(server.url).origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'archive' }),
  })
  assert.equal(projectArchiveResponse.status, 200)
  assert.equal((await projectArchiveResponse.json() as { project: { state: string } }).project.state, 'archived')
  assert.equal(existsSync(lifecycleProject.project.rootPath), true)
  const projectsAfterArchiveResponse = await authenticatedFetch('/api/projects')
  assert.equal((await projectsAfterArchiveResponse.json() as { projects: Array<{ id: string }> }).projects.some((project) => project.id === lifecycleProject.project.id), true)

  const preferencesPayload = {
    version: 1,
    projectsExpanded: false,
    historyExpanded: true,
    projectSort: 'updated',
    historySort: 'priority',
    manualProjectOrder: ['project-a'],
    pinnedProjectIds: ['project-a'],
    pinnedConversationIds: ['session-a'],
    archivedConversationIds: ['session-b'],
    sidebarWidth: 300,
  }
  const preferencesResponse = await fetch(new URL('/api/sidebar-preferences', server.url), {
    method: 'PUT',
    headers: { cookie, origin: new URL(server.url).origin, 'content-type': 'application/json' },
    body: JSON.stringify(preferencesPayload),
  })
  assert.equal(preferencesResponse.status, 200)
  const persistedPreferencesResponse = await authenticatedFetch('/api/sidebar-preferences')
  assert.deepEqual(await persistedPreferencesResponse.json(), { preferences: preferencesPayload })

  connection = { target: 'ws://127.0.0.1:54321', secret: 'must-not-leave-main-process' }
  runtimeState = 'listening'
  initialization = {
    state: 'ready',
    steps: [
      { id: 'workspace', label: '准备本地工作区', state: 'ready' },
      { id: 'workbench', label: '启动桌面工作台', state: 'ready' },
      { id: 'agent', label: '连接本地 Agent', state: 'ready' },
    ],
  }
  const readyResponse = await authenticatedFetch('/api/bridge-config')
  const readyText = await readyResponse.text()
  const ready = JSON.parse(readyText) as Record<string, unknown>
  assert.equal(ready.enabled, true)
  assert.equal(ready.runtimeState, 'listening')
  assert.deepEqual(ready.modelAvailability, modelAvailability)
  assert.deepEqual(ready.initialization, initialization)
  assert.equal(readyText.includes('must-not-leave-main-process'), false)
  assert.equal(readyText.includes('54321'), false)

  connection = null
  runtimeState = 'failed'
  runtimeError = 'MIMO_API_KEY 未配置'
  modelAvailability = [
    { id: 'grok-4.5', available: false, reason: 'login-required' },
    { id: 'mimo', available: false, reason: 'credential-missing' },
    { id: 'deepseek-v4-pro', available: false, reason: 'credential-missing' },
  ]
  initialization = {
    state: 'degraded',
    steps: [
      { id: 'workspace', label: '准备本地工作区', state: 'ready' },
      { id: 'workbench', label: '启动桌面工作台', state: 'ready' },
      { id: 'agent', label: '连接本地 Agent', state: 'warning', detail: runtimeError },
    ],
  }
  const failedResponse = await authenticatedFetch('/api/bridge-config')
  const failed = await failedResponse.json() as Record<string, unknown>
  assert.equal(failed.enabled, false)
  assert.equal(failed.runtimeState, 'failed')
  assert.equal(failed.runtimeError, runtimeError)
  assert.deepEqual(failed.modelAvailability, modelAvailability)
  assert.deepEqual(failed.initialization, initialization)
})
