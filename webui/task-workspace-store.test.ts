import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  MAX_TASK_ATTACHMENT_BYTES,
  MAX_TASK_ATTACHMENTS,
  MAX_TASK_DRAFT_BYTES,
  TaskWorkspaceConflictError,
  TaskWorkspaceValidationError,
  createTaskWorkspaceStore,
} from './task-workspace-store.ts'

test('persists scoped drafts and opaque attachment blobs without putting payloads in task state', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-task-workspace-'))
  const storageDir = path.join(temporaryRoot, 'task-workspaces')
  const store = createTaskWorkspaceStore({ storageDir })
  const scope = { taskId: 'task-alpha', projectId: 'project-alpha' }
  const payload = Buffer.from('opaque attachment payload: do-not-copy-into-state', 'utf8')
  try {
    const initial = await store.saveDraft({ ...scope, text: '继续实现恢复链路' })
    assert.equal(initial.draft.text, '继续实现恢复链路')
    assert.equal(initial.attachments.length, 0)

    const attachment = await store.uploadAttachment({
      ...scope,
      attachmentId: 'notes-1',
      name: 'notes.txt',
      kind: 'text',
      mimeType: 'text/plain; charset=utf-8',
      contentLength: payload.length,
      body: [payload],
    })
    assert.equal(attachment.name, 'notes.txt')
    assert.equal(attachment.size, payload.length)
    assert.match(attachment.sha256, /^[a-f0-9]{64}$/)

    const restored = await store.task(scope)
    assert.equal(restored.draft.text, '继续实现恢复链路')
    assert.deepEqual(restored.attachments, [attachment])
    const rawState = await readFile(store.statePath, 'utf8')
    assert.equal(rawState.includes(payload.toString('utf8')), false)
    assert.equal(rawState.includes(payload.toString('base64')), false)
    assert.equal(rawState.includes('notes-1.blob'), false)
    assert.equal((await lstat(store.statePath)).mode & 0o777, 0o600)

    const storedBlob = await store.readAttachment({ ...scope, attachmentId: 'notes-1' })
    assert.deepEqual(await readFile(storedBlob.filePath), payload)
    assert.equal((await lstat(storedBlob.filePath)).mode & 0o777, 0o600)

    const pendingDraft = await store.saveDraft({ ...scope, text: '附件尚未发送，恢复后仍应在输入框中', attachmentIds: ['notes-1'] })
    assert.deepEqual(pendingDraft.draft.attachmentIds, ['notes-1'])
    await assert.rejects(
      () => store.saveDraft({ ...scope, text: 'bad reference', attachmentIds: ['missing-attachment'] }),
      TaskWorkspaceValidationError,
    )

    await assert.rejects(
      () => store.task({ taskId: scope.taskId, projectId: 'project-other' }),
      TaskWorkspaceConflictError,
    )
    await assert.rejects(
      () => store.uploadAttachment({
        ...scope,
        attachmentId: 'unsafe-name',
        name: '../credential.txt',
        kind: 'text',
        mimeType: 'text/plain',
        body: [Buffer.from('x')],
      }),
      TaskWorkspaceValidationError,
    )

    await store.changeTaskLifecycle({ ...scope, action: 'archive' })
    assert.equal((await store.task(scope)).lifecycle.state, 'archived')
    await store.changeTaskLifecycle({ ...scope, action: 'restore' })
    const afterRestore = await store.task(scope)
    assert.equal(afterRestore.lifecycle.state, 'active')
    assert.equal(afterRestore.draft.text, '附件尚未发送，恢复后仍应在输入框中')
    assert.deepEqual(afterRestore.draft.attachmentIds, ['notes-1'])
    assert.equal(afterRestore.attachments[0]?.sha256, attachment.sha256)

    const sentDraft = await store.saveDraft({ ...scope, text: '附件已发送，不应重新放入输入框', attachmentIds: [] })
    assert.deepEqual(sentDraft.draft.attachmentIds, [])
    assert.equal(sentDraft.attachments[0]?.id, 'notes-1')
    assert.deepEqual(await readFile((await store.readAttachment({ ...scope, attachmentId: 'notes-1' })).filePath), payload)

    const restartedStore = createTaskWorkspaceStore({ storageDir })
    assert.deepEqual(await restartedStore.task(scope), sentDraft)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('rejects oversized drafts without replacing the last durable state and blocks project archive during active work', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-task-workspace-lifecycle-'))
  const storageDir = path.join(temporaryRoot, 'task-workspaces')
  const projectFolder = path.join(temporaryRoot, 'real-project-folder')
  const store = createTaskWorkspaceStore({ storageDir })
  const scope = { taskId: 'task-bravo', projectId: 'project-bravo' }
  try {
    await mkdir(projectFolder)
    await store.saveDraft({ ...scope, text: 'last known good draft' })
    await assert.rejects(
      () => store.saveDraft({ ...scope, text: 'x'.repeat(MAX_TASK_DRAFT_BYTES + 1) }),
      TaskWorkspaceValidationError,
    )
    assert.equal((await store.task(scope)).draft.text, 'last known good draft')

    await assert.rejects(
      () => store.uploadAttachment({
        ...scope,
        attachmentId: 'too-large',
        name: 'too-large.bin',
        kind: 'file',
        mimeType: 'application/octet-stream',
        contentLength: MAX_TASK_ATTACHMENT_BYTES + 1,
        body: [],
      }),
      TaskWorkspaceValidationError,
    )
    await assert.rejects(
      () => store.uploadAttachment({
        ...scope,
        attachmentId: 'wrong-image-type',
        name: 'wrong-image.txt',
        kind: 'image',
        mimeType: 'text/plain',
        body: [Buffer.from('x')],
      }),
      TaskWorkspaceValidationError,
    )
    for (let index = 0; index < MAX_TASK_ATTACHMENTS; index += 1) {
      await store.uploadAttachment({
        ...scope,
        attachmentId: `count-${index}`,
        name: `count-${index}.txt`,
        kind: 'text',
        mimeType: 'text/plain',
        body: [Buffer.from(String(index))],
      })
    }
    await assert.rejects(
      () => store.uploadAttachment({
        ...scope,
        attachmentId: 'count-overflow',
        name: 'count-overflow.txt',
        kind: 'text',
        mimeType: 'text/plain',
        body: [Buffer.from('overflow')],
      }),
      TaskWorkspaceValidationError,
    )

    await store.changeTaskLifecycle({ ...scope, action: 'mark-running' })
    await assert.rejects(
      () => store.changeProjectLifecycle({ projectId: scope.projectId!, action: 'archive' }),
      TaskWorkspaceConflictError,
    )
    await store.changeTaskLifecycle({ ...scope, action: 'mark-idle' })
    const archived = await store.changeProjectLifecycle({ projectId: scope.projectId!, action: 'archive' })
    assert.equal(archived.state, 'archived')
    const restored = await store.changeProjectLifecycle({ projectId: scope.projectId!, action: 'restore' })
    assert.equal(restored.state, 'active')
    const detached = await store.changeProjectLifecycle({ projectId: scope.projectId!, action: 'detach' })
    assert.equal(detached.state, 'detached')
    assert.deepEqual((await store.listProjectLifecycle()).map((entry) => entry.projectId), [scope.projectId])
    assert.equal(existsSync(projectFolder), true)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
