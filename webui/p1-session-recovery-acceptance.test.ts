import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DEFAULT_MODEL_PROFILE } from './model-profile.ts'
import {
  createSessionRecoverySnapshot,
  createSessionReliabilityState,
  markTransportConnected,
  markTransportDisconnected,
  planPromptRetry,
  startPrompt,
} from './session-reliability.ts'
import { startLocalServer } from './desktop/local-server.ts'

type LocalServer = Awaited<ReturnType<typeof startLocalServer>>

type StoredAttachment = {
  id: string
  name: string
  kind: string
  mimeType: string
  size: number
  sha256: string
}

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

test('P1 session recovery keeps archived drafts and opaque attachments while an interrupted run stays ended', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runbuild-p1-session-recovery-'))
  const distDir = path.join(root, 'dist')
  const grokHome = path.join(root, 'runtime')
  await mkdir(distDir, { recursive: true })
  await mkdir(grokHome, { recursive: true })
  await writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>RunBuild P1 recovery</title>')

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

  const taskId = 'p1-recovery-task'
  const attachmentId = 'p1-note'
  const draftText = '重连后保留草稿，但不要自动继续上次运行。'
  const attachmentPayload = 'opaque-attachment-body-must-never-appear-in-workspace-json'
  let request = await authenticatedSession(server)

  const uploaded = await request(`/api/task-workspaces/${taskId}/attachments/${attachmentId}?projectId=root&name=recovery-notes.txt&kind=text`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: attachmentPayload,
  })
  assert.equal(uploaded.status, 201)
  const attachment = (await uploaded.json() as { attachment: StoredAttachment }).attachment
  assert.deepEqual({ id: attachment.id, name: attachment.name, kind: attachment.kind, mimeType: attachment.mimeType }, {
    id: attachmentId,
    name: 'recovery-notes.txt',
    kind: 'text',
    mimeType: 'text/plain',
  })

  const savedDraft = await request(`/api/task-workspaces/${taskId}/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: null, text: draftText, attachmentIds: [attachmentId] }),
  })
  assert.equal(savedDraft.status, 200)
  assert.equal((await savedDraft.json() as { task: { draft: { text: string; attachmentIds: string[] } } }).task.draft.text, draftText)

  const workspaceBeforeArchive = await request(`/api/task-workspaces/${taskId}?projectId=root`)
  assert.equal(workspaceBeforeArchive.status, 200)
  const workspaceBeforeArchiveText = await workspaceBeforeArchive.text()
  assert.equal(workspaceBeforeArchiveText.includes(attachmentPayload), false, 'opaque attachment bytes must not enter workspace state JSON')
  const workspaceBeforeArchiveJson = JSON.parse(workspaceBeforeArchiveText) as {
    task: { draft: { text: string; attachmentIds: string[] }; attachments: StoredAttachment[] }
  }
  assert.equal(workspaceBeforeArchiveJson.task.draft.text, draftText)
  assert.deepEqual(workspaceBeforeArchiveJson.task.draft.attachmentIds, [attachmentId])
  assert.deepEqual(workspaceBeforeArchiveJson.task.attachments.map(({ id, name }) => ({ id, name })), [{ id: attachmentId, name: 'recovery-notes.txt' }])

  const attachmentRead = await request(`/api/task-workspaces/${taskId}/attachments/${attachmentId}?projectId=root`)
  assert.equal(attachmentRead.status, 200)
  assert.equal(await attachmentRead.text(), attachmentPayload)
  const crossScopeRead = await request(`/api/task-workspaces/${taskId}/attachments/${attachmentId}?projectId=unrelated-project`)
  assert.equal(crossScopeRead.status, 409, 'a different project scope must not read the root-task attachment')
  assert.equal((await crossScopeRead.text()).includes(attachmentPayload), false)

  const archived = await request(`/api/task-workspaces/${taskId}/lifecycle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: null, action: 'archive' }),
  })
  assert.equal(archived.status, 200)
  assert.equal((await archived.json() as { task: { lifecycle: { state: string } } }).task.lifecycle.state, 'archived')
  const activeList = await request('/api/task-workspaces?projectId=root')
  assert.equal(activeList.status, 200)
  assert.equal((await activeList.json() as { tasks: Array<{ taskId: string }> }).tasks.some((task) => task.taskId === taskId), false)
  const archiveList = await request('/api/task-workspaces?projectId=root&includeArchived=true')
  assert.equal(archiveList.status, 200)
  assert.equal((await archiveList.json() as { tasks: Array<{ taskId: string; lifecycle: { state: string } }> }).tasks.some((task) => task.taskId === taskId && task.lifecycle.state === 'archived'), true)

  await server.stop()
  server = await start()
  request = await authenticatedSession(server)

  const restored = await request(`/api/task-workspaces/${taskId}/lifecycle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: null, action: 'restore' }),
  })
  assert.equal(restored.status, 200)
  assert.equal((await restored.json() as { task: { lifecycle: { state: string } } }).task.lifecycle.state, 'active')
  const recoveredWorkspace = await request(`/api/task-workspaces/${taskId}?projectId=root`)
  assert.equal(recoveredWorkspace.status, 200)
  const recovered = await recoveredWorkspace.json() as {
    task: { draft: { text: string; attachmentIds: string[] }; attachments: StoredAttachment[] }
  }
  assert.equal(recovered.task.draft.text, draftText)
  assert.deepEqual(recovered.task.draft.attachmentIds, [attachmentId])
  assert.deepEqual(recovered.task.attachments.map(({ id, sha256, size }) => ({ id, sha256, size })), [{
    id: attachment.id,
    sha256: attachment.sha256,
    size: attachment.size,
  }])
  const recoveredAttachment = await request(`/api/task-workspaces/${taskId}/attachments/${attachmentId}?projectId=root`)
  assert.equal(recoveredAttachment.status, 200)
  assert.equal(await recoveredAttachment.text(), attachmentPayload)

  const composer = {
    draft: recovered.task.draft.text,
    attachments: recovered.task.attachments,
  } as const
  const started = startPrompt(createSessionReliabilityState(), {
    runId: 'p1-recovery-run',
    startedAtMs: 1_000,
    timeoutMs: 1_000,
  })
  assert.equal(started.kind, 'started')
  if (started.kind !== 'started') throw new Error('expected a connected prompt to start')
  const disconnected = markTransportDisconnected(started.state, {
    nowMs: 1_200,
    reason: 'desktop socket closed',
    policy: { baseDelayMs: 100, maxDelayMs: 1_000, maxAttempts: 2 },
  })
  assert.equal(disconnected.state.task?.phase, 'failed')
  const reconnected = markTransportConnected(disconnected.state)
  const snapshot = createSessionRecoverySnapshot(reconnected.state, composer)
  assert.equal(snapshot.composer, composer, 'recovery must retain the caller-owned persisted draft and attachments')
  assert.equal(snapshot.composer.attachments, composer.attachments)
  assert.equal(snapshot.message.code, 'task_failed')
  assert.equal(snapshot.message.taskCompleted, false, 'a socket reconnect is not completion evidence')
  assert.deepEqual(reconnected.actions, [], 'reconnecting transport must not resume the interrupted run')
  const retry = planPromptRetry(reconnected.state, composer)
  assert.equal(retry.kind, 'retry', 'the user may start a new retry after the interrupted run has ended')
})
