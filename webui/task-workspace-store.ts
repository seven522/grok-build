import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

export const TASK_WORKSPACE_SCHEMA = 'runbuild.task-workspace.v1' as const
export const MAX_TASK_DRAFT_BYTES = 128 * 1024
export const MAX_TASK_ATTACHMENTS = 6
export const MAX_TASK_ATTACHMENT_BYTES = 12 * 1024 * 1024
export const MAX_TASK_ATTACHMENT_TOTAL_BYTES = MAX_TASK_ATTACHMENTS * MAX_TASK_ATTACHMENT_BYTES
export const MAX_TASK_WORKSPACE_REQUEST_BYTES = MAX_TASK_ATTACHMENT_BYTES + 8 * 1024

const MAX_STATE_BYTES = 2 * 1024 * 1024
const MAX_IDENTIFIER_LENGTH = 512
const MAX_ATTACHMENT_NAME_LENGTH = 160
const MAX_MIME_TYPE_LENGTH = 160
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const attachmentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const sha256Pattern = /^[a-f0-9]{64}$/
const mimeTypePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export type TaskWorkspaceScope = {
  taskId: string
  projectId: string | null
}

export type TaskAttachmentKind = 'image' | 'text' | 'file'

export type TaskAttachmentDescriptor = {
  id: string
  name: string
  kind: TaskAttachmentKind
  mimeType: string
  size: number
  sha256: string
  storedAt: string
}

export type TaskWorkspace = {
  version: 1
  taskId: string
  projectId: string | null
  lifecycle: {
    state: 'active' | 'archived'
    execution: 'idle' | 'running' | 'cancelling'
    createdAt: string
    updatedAt: string
    archivedAt?: string
    restoredAt?: string
  }
  draft: {
    text: string
    attachmentIds: string[]
    updatedAt: string
  }
  attachments: TaskAttachmentDescriptor[]
}

export type TaskProjectLifecycle = {
  version: 1
  projectId: string
  state: 'active' | 'archived' | 'detached'
  createdAt: string
  updatedAt: string
  archivedAt?: string
  detachedAt?: string
  restoredAt?: string
}

type TaskWorkspaceFile = {
  schema: typeof TASK_WORKSPACE_SCHEMA
  tasks: TaskWorkspace[]
  projects: TaskProjectLifecycle[]
}

export class TaskWorkspaceValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskWorkspaceValidationError'
  }
}

export class TaskWorkspaceConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskWorkspaceConflictError'
  }
}

export class TaskWorkspaceNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskWorkspaceNotFoundError'
  }
}

const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : ''

const plainObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const canonicalTimestamp = (value: unknown, label: string) => {
  if (typeof value !== 'string') throw new TaskWorkspaceValidationError(`${label} 无效`)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) throw new TaskWorkspaceValidationError(`${label} 无效`)
  return parsed.toISOString()
}

const identifier = (value: unknown, label: string, nullable = false): string | null => {
  if (nullable && value === null) return null
  if (
    typeof value !== 'string'
    || !value
    || value.length > MAX_IDENTIFIER_LENGTH
    || CONTROL_CHARACTERS.test(value)
    || value.includes('/')
    || value.includes('\\')
  ) throw new TaskWorkspaceValidationError(`${label} 无效`)
  return value
}

const scopeFrom = (value: { taskId: unknown; projectId: unknown }): TaskWorkspaceScope => ({
  taskId: identifier(value.taskId, 'taskId') as string,
  projectId: identifier(value.projectId, 'projectId', true),
})

const attachmentId = (value: unknown) => {
  if (typeof value !== 'string' || !attachmentIdPattern.test(value)) throw new TaskWorkspaceValidationError('attachmentId 无效')
  return value
}

const attachmentName = (value: unknown) => {
  if (typeof value !== 'string') throw new TaskWorkspaceValidationError('附件名称无效')
  const name = value.normalize('NFKC').trim()
  if (!name || name.length > MAX_ATTACHMENT_NAME_LENGTH || CONTROL_CHARACTERS.test(name) || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new TaskWorkspaceValidationError('附件名称无效')
  }
  return name
}

const attachmentKind = (value: unknown): TaskAttachmentKind => {
  if (value === 'image' || value === 'text' || value === 'file') return value
  throw new TaskWorkspaceValidationError('附件类型无效')
}

const attachmentMimeType = (value: unknown, kind: TaskAttachmentKind) => {
  if (typeof value !== 'string') throw new TaskWorkspaceValidationError('附件 MIME 类型无效')
  const mimeType = value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (!mimeType || mimeType.length > MAX_MIME_TYPE_LENGTH || !mimeTypePattern.test(mimeType)) throw new TaskWorkspaceValidationError('附件 MIME 类型无效')
  if (kind === 'image' && !['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
    throw new TaskWorkspaceValidationError('图片附件类型不受支持')
  }
  if (kind === 'text' && !(mimeType.startsWith('text/') || mimeType === 'application/json')) {
    throw new TaskWorkspaceValidationError('文本附件 MIME 类型无效')
  }
  return mimeType
}

const attachmentDescriptor = (value: unknown): TaskAttachmentDescriptor => {
  if (!plainObject(value)) throw new TaskWorkspaceValidationError('附件描述无效')
  const kind = attachmentKind(value.kind)
  const size = value.size
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_TASK_ATTACHMENT_BYTES) throw new TaskWorkspaceValidationError('附件大小无效')
  if (typeof value.sha256 !== 'string' || !sha256Pattern.test(value.sha256)) throw new TaskWorkspaceValidationError('附件 SHA-256 无效')
  return {
    id: attachmentId(value.id),
    name: attachmentName(value.name),
    kind,
    mimeType: attachmentMimeType(value.mimeType, kind),
    size,
    sha256: value.sha256,
    storedAt: canonicalTimestamp(value.storedAt, '附件保存时间'),
  }
}

const normalizeWorkspace = (value: unknown): TaskWorkspace => {
  if (!plainObject(value)) throw new TaskWorkspaceValidationError('任务工作区记录无效')
  if (value.version !== 1) throw new TaskWorkspaceValidationError('任务工作区版本无效')
  const scope = scopeFrom({ taskId: value.taskId, projectId: value.projectId })
  if (!plainObject(value.lifecycle) || !plainObject(value.draft) || !Array.isArray(value.attachments)) throw new TaskWorkspaceValidationError('任务工作区结构无效')
  const lifecycleState = value.lifecycle.state
  const execution = value.lifecycle.execution
  if (lifecycleState !== 'active' && lifecycleState !== 'archived') throw new TaskWorkspaceValidationError('任务生命周期状态无效')
  if (execution !== 'idle' && execution !== 'running' && execution !== 'cancelling') throw new TaskWorkspaceValidationError('任务执行状态无效')
  if (lifecycleState === 'archived' && execution !== 'idle') throw new TaskWorkspaceValidationError('归档任务不能处于执行中')
  if (typeof value.draft.text !== 'string' || Buffer.byteLength(value.draft.text, 'utf8') > MAX_TASK_DRAFT_BYTES || value.draft.text.includes('\0')) {
    throw new TaskWorkspaceValidationError('任务草稿无效')
  }
  if (!Array.isArray(value.draft.attachmentIds) || value.draft.attachmentIds.length > MAX_TASK_ATTACHMENTS) throw new TaskWorkspaceValidationError('草稿附件引用无效')
  if (value.attachments.length > MAX_TASK_ATTACHMENTS) throw new TaskWorkspaceValidationError('附件数量超过限制')
  const attachments = value.attachments.map(attachmentDescriptor)
  if (new Set(attachments.map((item) => item.id)).size !== attachments.length) throw new TaskWorkspaceValidationError('附件标识重复')
  const draftAttachmentIds = value.draft.attachmentIds.map(attachmentId)
  if (new Set(draftAttachmentIds).size !== draftAttachmentIds.length || draftAttachmentIds.some((id) => !attachments.some((attachment) => attachment.id === id))) {
    throw new TaskWorkspaceValidationError('草稿附件引用不存在')
  }
  const totalBytes = attachments.reduce((total, item) => total + item.size, 0)
  if (totalBytes > MAX_TASK_ATTACHMENT_TOTAL_BYTES) throw new TaskWorkspaceValidationError('附件总大小超过限制')
  const createdAt = canonicalTimestamp(value.lifecycle.createdAt, '任务创建时间')
  const updatedAt = canonicalTimestamp(value.lifecycle.updatedAt, '任务更新时间')
  const archivedAt = value.lifecycle.archivedAt === undefined ? undefined : canonicalTimestamp(value.lifecycle.archivedAt, '任务归档时间')
  const restoredAt = value.lifecycle.restoredAt === undefined ? undefined : canonicalTimestamp(value.lifecycle.restoredAt, '任务恢复时间')
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new TaskWorkspaceValidationError('任务更新时间无效')
  return {
    version: 1,
    ...scope,
    lifecycle: {
      state: lifecycleState,
      execution,
      createdAt,
      updatedAt,
      ...(archivedAt ? { archivedAt } : {}),
      ...(restoredAt ? { restoredAt } : {}),
    },
    draft: { text: value.draft.text, attachmentIds: draftAttachmentIds, updatedAt: canonicalTimestamp(value.draft.updatedAt, '草稿更新时间') },
    attachments,
  }
}

const normalizeProjectLifecycle = (value: unknown): TaskProjectLifecycle => {
  if (!plainObject(value) || value.version !== 1) throw new TaskWorkspaceValidationError('项目生命周期记录无效')
  if (value.state !== 'active' && value.state !== 'archived' && value.state !== 'detached') throw new TaskWorkspaceValidationError('项目生命周期状态无效')
  const createdAt = canonicalTimestamp(value.createdAt, '项目创建时间')
  const updatedAt = canonicalTimestamp(value.updatedAt, '项目更新时间')
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new TaskWorkspaceValidationError('项目更新时间无效')
  const archivedAt = value.archivedAt === undefined ? undefined : canonicalTimestamp(value.archivedAt, '项目归档时间')
  const detachedAt = value.detachedAt === undefined ? undefined : canonicalTimestamp(value.detachedAt, '项目脱离时间')
  const restoredAt = value.restoredAt === undefined ? undefined : canonicalTimestamp(value.restoredAt, '项目恢复时间')
  return {
    version: 1,
    projectId: identifier(value.projectId, 'projectId') as string,
    state: value.state,
    createdAt,
    updatedAt,
    ...(archivedAt ? { archivedAt } : {}),
    ...(detachedAt ? { detachedAt } : {}),
    ...(restoredAt ? { restoredAt } : {}),
  }
}

const normalizeFile = (value: unknown): TaskWorkspaceFile => {
  if (!plainObject(value) || value.schema !== TASK_WORKSPACE_SCHEMA || !Array.isArray(value.tasks) || !Array.isArray(value.projects)) {
    throw new TaskWorkspaceValidationError('任务工作区状态文件无效')
  }
  const tasks = value.tasks.map(normalizeWorkspace)
  const projects = value.projects.map(normalizeProjectLifecycle)
  if (new Set(tasks.map((task) => `${task.projectId ?? 'root'}\0${task.taskId}`)).size !== tasks.length) throw new TaskWorkspaceValidationError('任务作用域重复')
  if (new Set(projects.map((project) => project.projectId)).size !== projects.length) throw new TaskWorkspaceValidationError('项目生命周期重复')
  return { schema: TASK_WORKSPACE_SCHEMA, tasks, projects }
}

const emptyFile = (): TaskWorkspaceFile => ({ schema: TASK_WORKSPACE_SCHEMA, tasks: [], projects: [] })

const sameScope = (left: TaskWorkspaceScope, right: TaskWorkspaceScope) => left.taskId === right.taskId && left.projectId === right.projectId

const pathHash = (scope: TaskWorkspaceScope) => createHash('sha256').update(`${scope.projectId ?? 'root'}\0${scope.taskId}`, 'utf8').digest('hex')

const safeDirectory = async (directory: string, label: string) => {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const metadata = await lstat(directory)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new TaskWorkspaceValidationError(`${label} 必须是普通文件夹`)
  try { await chmod(directory, 0o700) } catch { /* The filesystem may not support chmod. */ }
  return path.resolve(directory)
}

const contentDisposition = (name: string) => `attachment; filename*=UTF-8''${encodeURIComponent(name)}`

export type TaskWorkspaceStore = ReturnType<typeof createTaskWorkspaceStore>

export function createTaskWorkspaceStore(options: { storageDir: string }) {
  const storageDir = path.resolve(options.storageDir)
  const statePath = path.join(storageDir, 'state.json')
  const blobsRoot = path.join(storageDir, 'blobs')
  let operationQueue: Promise<void> = Promise.resolve()

  const serialize = <T>(operation: () => Promise<T>) => {
    const result = operationQueue.then(operation, operation)
    operationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  const ensureStorage = async () => {
    await safeDirectory(storageDir, '任务工作区目录')
    await safeDirectory(blobsRoot, '任务附件目录')
  }

  const readState = async (): Promise<TaskWorkspaceFile> => {
    await ensureStorage()
    try {
      const metadata = await lstat(statePath)
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_STATE_BYTES || (metadata.mode & 0o077) !== 0) {
        throw new TaskWorkspaceValidationError('任务工作区状态文件不安全')
      }
      return normalizeFile(JSON.parse(await readFile(statePath, 'utf8')) as unknown)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return emptyFile()
      throw error
    }
  }

  const persistState = async (state: TaskWorkspaceFile) => {
    const normalized = normalizeFile(state)
    const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try { await chmod(temporary, 0o600) } catch { /* Creation mode is restrictive on supported filesystems. */ }
    await rename(temporary, statePath)
  }

  const taskFor = (state: TaskWorkspaceFile, scope: TaskWorkspaceScope, create = false) => {
    const existing = state.tasks.find((task) => task.taskId === scope.taskId)
    if (existing && !sameScope(existing, scope)) throw new TaskWorkspaceConflictError('任务已绑定到其他项目作用域')
    if (existing) return existing
    if (!create) throw new TaskWorkspaceNotFoundError('任务工作区不存在')
    const timestamp = new Date().toISOString()
    const task: TaskWorkspace = {
      version: 1,
      ...scope,
      lifecycle: { state: 'active', execution: 'idle', createdAt: timestamp, updatedAt: timestamp },
      draft: { text: '', attachmentIds: [], updatedAt: timestamp },
      attachments: [],
    }
    state.tasks.push(task)
    return task
  }

  const blobDirectory = (scope: TaskWorkspaceScope) => path.join(blobsRoot, pathHash(scope))
  const blobPath = (scope: TaskWorkspaceScope, id: string) => path.join(blobDirectory(scope), `${attachmentId(id)}.blob`)

  const task = (scopeInput: TaskWorkspaceScope) => serialize(async () => {
    const scope = scopeFrom(scopeInput)
    const state = await readState()
    const existing = taskFor(state, scope)
    return clone(existing)
  })

  const listTasks = (input: { projectId?: string | null; includeArchived?: boolean } = {}) => serialize(async () => {
    const state = await readState()
    const projectId = input.projectId === undefined ? undefined : identifier(input.projectId, 'projectId', true)
    return state.tasks
      .filter((task) => projectId === undefined || task.projectId === projectId)
      .filter((task) => input.includeArchived || task.lifecycle.state !== 'archived')
      .sort((left, right) => right.lifecycle.updatedAt.localeCompare(left.lifecycle.updatedAt))
      .map(clone)
  })

  const saveDraft = (input: { taskId: unknown; projectId: unknown; text: unknown; attachmentIds?: unknown }) => serialize(async () => {
    const scope = scopeFrom(input)
    if (typeof input.text !== 'string' || input.text.includes('\0') || Buffer.byteLength(input.text, 'utf8') > MAX_TASK_DRAFT_BYTES) {
      throw new TaskWorkspaceValidationError('任务草稿超过限制或格式无效')
    }
    const state = await readState()
    const workspace = taskFor(state, scope, true)
    const attachmentIds = input.attachmentIds === undefined
      ? workspace.draft.attachmentIds
      : (() => {
          if (!Array.isArray(input.attachmentIds) || input.attachmentIds.length > MAX_TASK_ATTACHMENTS) throw new TaskWorkspaceValidationError('草稿附件引用无效')
          const ids = input.attachmentIds.map(attachmentId)
          if (new Set(ids).size !== ids.length || ids.some((id) => !workspace.attachments.some((attachment) => attachment.id === id))) {
            throw new TaskWorkspaceValidationError('草稿附件引用不存在')
          }
          return ids
        })()
    const timestamp = new Date().toISOString()
    workspace.draft = { text: input.text, attachmentIds, updatedAt: timestamp }
    workspace.lifecycle.updatedAt = timestamp
    await persistState(state)
    return clone(workspace)
  })

  const changeTaskLifecycle = (input: { taskId: unknown; projectId: unknown; action: unknown }) => serialize(async () => {
    const scope = scopeFrom(input)
    if (!['archive', 'restore', 'mark-running', 'mark-idle', 'mark-cancelling'].includes(String(input.action))) {
      throw new TaskWorkspaceValidationError('任务生命周期操作无效')
    }
    const state = await readState()
    const workspace = taskFor(state, scope, true)
    const timestamp = new Date().toISOString()
    if (input.action === 'archive') {
      if (workspace.lifecycle.execution !== 'idle') throw new TaskWorkspaceConflictError('执行中的任务不能归档')
      workspace.lifecycle.state = 'archived'
      workspace.lifecycle.archivedAt = timestamp
    } else if (input.action === 'restore') {
      workspace.lifecycle.state = 'active'
      workspace.lifecycle.restoredAt = timestamp
    } else if (input.action === 'mark-running') {
      if (workspace.lifecycle.state !== 'active') throw new TaskWorkspaceConflictError('归档任务不能开始执行')
      workspace.lifecycle.execution = 'running'
    } else if (input.action === 'mark-cancelling') {
      if (workspace.lifecycle.execution !== 'running') throw new TaskWorkspaceConflictError('当前任务不在执行中')
      workspace.lifecycle.execution = 'cancelling'
    } else {
      workspace.lifecycle.execution = 'idle'
    }
    workspace.lifecycle.updatedAt = timestamp
    await persistState(state)
    return clone(workspace)
  })

  const uploadAttachment = (input: TaskWorkspaceScope & {
    attachmentId: unknown
    name: unknown
    kind: unknown
    mimeType: unknown
    body: AsyncIterable<Buffer | Uint8Array>
    contentLength?: number
  }) => serialize(async () => {
    const scope = scopeFrom(input)
    const id = attachmentId(input.attachmentId)
    const kind = attachmentKind(input.kind)
    const name = attachmentName(input.name)
    const mimeType = attachmentMimeType(input.mimeType, kind)
    if (input.contentLength !== undefined && (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1 || input.contentLength > MAX_TASK_ATTACHMENT_BYTES)) {
      throw new TaskWorkspaceValidationError('附件 Content-Length 无效')
    }
    const state = await readState()
    const workspace = taskFor(state, scope, true)
    const previous = workspace.attachments.find((attachment) => attachment.id === id)
    if (!previous && workspace.attachments.length >= MAX_TASK_ATTACHMENTS) throw new TaskWorkspaceValidationError(`每个任务最多保存 ${MAX_TASK_ATTACHMENTS} 个附件`)
    const directory = await safeDirectory(blobDirectory(scope), '任务附件目录')
    const target = blobPath(scope, id)
    const temporary = path.join(directory, `.${id}.${process.pid}.${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    const digest = createHash('sha256')
    let bytes = 0
    try {
      for await (const chunk of input.body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > MAX_TASK_ATTACHMENT_BYTES) throw new TaskWorkspaceValidationError(`单个附件不能超过 ${MAX_TASK_ATTACHMENT_BYTES / (1024 * 1024)}MB`)
        digest.update(buffer)
        await handle.write(buffer)
      }
      if (!bytes) throw new TaskWorkspaceValidationError('附件不能为空')
      const total = workspace.attachments.reduce((sum, attachment) => sum + attachment.size, 0) - (previous?.size ?? 0) + bytes
      if (total > MAX_TASK_ATTACHMENT_TOTAL_BYTES) throw new TaskWorkspaceValidationError('任务附件总大小超过限制')
      await handle.sync()
    } catch (error) {
      await handle.close()
      await rm(temporary, { force: true })
      throw error
    }
    await handle.close()
    const timestamp = new Date().toISOString()
    const descriptor: TaskAttachmentDescriptor = {
      id,
      name,
      kind,
      mimeType,
      size: bytes,
      sha256: digest.digest('hex'),
      storedAt: timestamp,
    }
    const nextAttachments = previous
      ? workspace.attachments.map((attachment) => attachment.id === id ? descriptor : attachment)
      : [...workspace.attachments, descriptor]
    const backup = path.join(directory, `.${id}.${process.pid}.${randomUUID()}.backup`)
    let movedPrevious = false
    try {
      try {
        const existing = await lstat(target)
        if (existing.isSymbolicLink() || !existing.isFile()) throw new TaskWorkspaceValidationError('任务附件文件不安全')
        await rename(target, backup)
        movedPrevious = true
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
      }
      await rename(temporary, target)
      workspace.attachments = nextAttachments
      workspace.lifecycle.updatedAt = timestamp
      await persistState(state)
      if (movedPrevious) await rm(backup, { force: true })
      return clone(descriptor)
    } catch (error) {
      await rm(target, { force: true })
      if (movedPrevious) await rename(backup, target).catch(() => undefined)
      await rm(temporary, { force: true })
      throw error
    }
  })

  const readAttachment = (scopeInput: TaskWorkspaceScope & { attachmentId: unknown }) => serialize(async () => {
    const scope = scopeFrom(scopeInput)
    const id = attachmentId(scopeInput.attachmentId)
    const state = await readState()
    const workspace = taskFor(state, scope)
    const descriptor = workspace.attachments.find((attachment) => attachment.id === id)
    if (!descriptor) throw new TaskWorkspaceNotFoundError('任务附件不存在')
    const filePath = blobPath(scope, id)
    let metadata
    try { metadata = await lstat(filePath) } catch { throw new TaskWorkspaceNotFoundError('任务附件文件不存在') }
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== descriptor.size || (metadata.mode & 0o077) !== 0) {
      throw new TaskWorkspaceValidationError('任务附件文件不安全或已损坏')
    }
    return { descriptor: clone(descriptor), filePath }
  })

  const listProjectLifecycle = () => serialize(async () => clone([...(await readState()).projects].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))))

  const changeProjectLifecycle = (input: { projectId: unknown; action: unknown }) => serialize(async () => {
    const projectId = identifier(input.projectId, 'projectId') as string
    if (!['archive', 'restore', 'detach'].includes(String(input.action))) throw new TaskWorkspaceValidationError('项目生命周期操作无效')
    const state = await readState()
    if (input.action !== 'restore') {
      const busyTask = state.tasks.find((task) => task.projectId === projectId && task.lifecycle.execution !== 'idle')
      if (busyTask) throw new TaskWorkspaceConflictError(`项目存在执行中的任务 ${busyTask.taskId}`)
    }
    const timestamp = new Date().toISOString()
    let lifecycle = state.projects.find((project) => project.projectId === projectId)
    if (!lifecycle) {
      lifecycle = { version: 1, projectId, state: 'active', createdAt: timestamp, updatedAt: timestamp }
      state.projects.push(lifecycle)
    }
    if (input.action === 'archive') {
      lifecycle.state = 'archived'
      lifecycle.archivedAt = timestamp
    } else if (input.action === 'detach') {
      lifecycle.state = 'detached'
      lifecycle.detachedAt = timestamp
    } else {
      lifecycle.state = 'active'
      lifecycle.restoredAt = timestamp
    }
    lifecycle.updatedAt = timestamp
    await persistState(state)
    return clone(lifecycle)
  })

  return {
    storageDir,
    statePath,
    task,
    listTasks,
    saveDraft,
    changeTaskLifecycle,
    uploadAttachment,
    readAttachment,
    listProjectLifecycle,
    changeProjectLifecycle,
  }
}

const readJsonBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_TASK_DRAFT_BYTES + 8 * 1024) throw new TaskWorkspaceValidationError('请求内容超过草稿大小限制')
    chunks.push(buffer)
  }
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { throw new TaskWorkspaceValidationError('请求内容必须是 JSON') }
  if (!plainObject(parsed)) throw new TaskWorkspaceValidationError('请求内容必须是 JSON 对象')
  return parsed
}

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.statusCode = status
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

const decodeSegment = (value: string, label: string) => {
  try { return identifier(decodeURIComponent(value), label) as string } catch (error) {
    if (error instanceof URIError) throw new TaskWorkspaceValidationError(`${label} 无效`)
    throw error
  }
}

const queryScope = (url: URL, taskId: string): TaskWorkspaceScope => {
  const project = url.searchParams.get('projectId')
  if (project === 'root') return { taskId, projectId: null }
  if (project === null) throw new TaskWorkspaceValidationError('projectId 作用域必填')
  return { taskId, projectId: identifier(project, 'projectId') as string }
}

const contentLength = (request: IncomingMessage) => {
  const raw = request.headers['content-length']
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) throw new TaskWorkspaceValidationError('Content-Length 无效')
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new TaskWorkspaceValidationError('Content-Length 无效')
  return value
}

const requestErrorStatus = (error: unknown) => {
  if (error instanceof TaskWorkspaceNotFoundError) return 404
  if (error instanceof TaskWorkspaceConflictError) return 409
  if (error instanceof TaskWorkspaceValidationError) return 400
  return 500
}

export function taskWorkspaceMiddleware(
  store: TaskWorkspaceStore,
  options: {
    assertProjectLifecycleAllowed?: (projectId: string, action: 'archive' | 'restore' | 'detach') => Promise<void>
  } = {},
) {
  return async (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/api/task-workspaces' && !url.pathname.startsWith('/api/task-workspaces/')) return next()
    try {
      if (url.pathname === '/api/task-workspaces' && request.method === 'GET') {
        const rawProjectId = url.searchParams.get('projectId')
        const projectId = rawProjectId === null ? undefined : rawProjectId === 'root' ? null : identifier(rawProjectId, 'projectId') as string
        sendJson(response, 200, { tasks: await store.listTasks({ projectId, includeArchived: url.searchParams.get('includeArchived') === 'true' }) })
        return
      }
      if (url.pathname === '/api/task-workspaces/projects' && request.method === 'GET') {
        sendJson(response, 200, { projects: await store.listProjectLifecycle() })
        return
      }
      const projectLifecycle = url.pathname.match(/^\/api\/task-workspaces\/projects\/([^/]+)\/lifecycle$/)
      if (projectLifecycle && request.method === 'POST') {
        const projectId = decodeSegment(projectLifecycle[1]!, 'projectId')
        const body = await readJsonBody(request)
        const action = body.action
        if (action !== 'archive' && action !== 'restore' && action !== 'detach') throw new TaskWorkspaceValidationError('项目生命周期操作无效')
        await options.assertProjectLifecycleAllowed?.(projectId, action)
        sendJson(response, 200, { project: await store.changeProjectLifecycle({ projectId, action }) })
        return
      }
      const attachment = url.pathname.match(/^\/api\/task-workspaces\/([^/]+)\/attachments\/([^/]+)$/)
      if (attachment) {
        const taskId = decodeSegment(attachment[1]!, 'taskId')
        const scope = queryScope(url, taskId)
        const id = decodeSegment(attachment[2]!, 'attachmentId')
        if (request.method === 'GET') {
          const result = await store.readAttachment({ ...scope, attachmentId: id })
          response.statusCode = 200
          response.setHeader('cache-control', 'no-store')
          response.setHeader('x-content-type-options', 'nosniff')
          response.setHeader('content-type', result.descriptor.mimeType)
          response.setHeader('content-disposition', contentDisposition(result.descriptor.name))
          response.setHeader('content-length', String(result.descriptor.size))
          createReadStream(result.filePath).on('error', (error) => response.destroy(error)).pipe(response)
          return
        }
        if (request.method === 'PUT') {
          const descriptor = await store.uploadAttachment({
            ...scope,
            attachmentId: id,
            name: url.searchParams.get('name') ?? '',
            kind: url.searchParams.get('kind') ?? '',
            mimeType: request.headers['content-type'] ?? '',
            body: request,
            contentLength: contentLength(request),
          })
          sendJson(response, 201, { attachment: descriptor })
          return
        }
        response.statusCode = 405
        response.setHeader('allow', 'GET, PUT')
        response.end(JSON.stringify({ error: 'Method not allowed' }))
        return
      }
      const taskLifecycle = url.pathname.match(/^\/api\/task-workspaces\/([^/]+)\/lifecycle$/)
      if (taskLifecycle && request.method === 'POST') {
        const taskId = decodeSegment(taskLifecycle[1]!, 'taskId')
        const body = await readJsonBody(request)
        sendJson(response, 200, { task: await store.changeTaskLifecycle({ taskId, projectId: body.projectId, action: body.action }) })
        return
      }
      const draft = url.pathname.match(/^\/api\/task-workspaces\/([^/]+)\/draft$/)
      if (draft && request.method === 'PUT') {
        const taskId = decodeSegment(draft[1]!, 'taskId')
        const body = await readJsonBody(request)
        sendJson(response, 200, { task: await store.saveDraft({ taskId, projectId: body.projectId, text: body.text, attachmentIds: body.attachmentIds }) })
        return
      }
      const task = url.pathname.match(/^\/api\/task-workspaces\/([^/]+)$/)
      if (task && request.method === 'GET') {
        const taskId = decodeSegment(task[1]!, 'taskId')
        sendJson(response, 200, { task: await store.task(queryScope(url, taskId)) })
        return
      }
      if (url.pathname.startsWith('/api/task-workspaces')) {
        response.statusCode = 405
        response.setHeader('allow', 'GET, POST, PUT')
        response.end(JSON.stringify({ error: 'Method not allowed' }))
        return
      }
      next()
    } catch (error) {
      sendJson(response, requestErrorStatus(error), { error: error instanceof Error ? error.message : '任务工作区操作失败' })
    }
  }
}
