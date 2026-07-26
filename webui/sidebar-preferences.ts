import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

export type SidebarPreferences = {
  version: 1
  projectsExpanded: boolean
  historyExpanded: boolean
  projectSort: 'priority' | 'updated' | 'manual'
  historySort: 'priority' | 'created'
  manualProjectOrder: string[]
  pinnedProjectIds: string[]
  pinnedConversationIds: string[]
  archivedConversationIds: string[]
  sidebarWidth: number
}

const MAX_LIST_ITEMS = 2_000
const MAX_ID_LENGTH = 512
const SIDEBAR_MIN_WIDTH = 224
const SIDEBAR_MAX_WIDTH = 420

const stringList = (value: unknown) => {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) return null
  const entries = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0 && entry.length <= MAX_ID_LENGTH)
  if (entries.length !== value.length) return null
  return [...new Set(entries)]
}

export function normalizeSidebarPreferences(value: unknown): SidebarPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (input.version !== 1 || typeof input.projectsExpanded !== 'boolean' || typeof input.historyExpanded !== 'boolean') return null
  if (!['priority', 'updated', 'manual'].includes(String(input.projectSort))) return null
  if (!['priority', 'created'].includes(String(input.historySort))) return null
  if (typeof input.sidebarWidth !== 'number' || !Number.isFinite(input.sidebarWidth)) return null
  const manualProjectOrder = stringList(input.manualProjectOrder)
  const pinnedProjectIds = stringList(input.pinnedProjectIds)
  const pinnedConversationIds = stringList(input.pinnedConversationIds)
  const archivedConversationIds = stringList(input.archivedConversationIds)
  if (!manualProjectOrder || !pinnedProjectIds || !pinnedConversationIds || !archivedConversationIds) return null
  return {
    version: 1,
    projectsExpanded: input.projectsExpanded,
    historyExpanded: input.historyExpanded,
    projectSort: input.projectSort as SidebarPreferences['projectSort'],
    historySort: input.historySort as SidebarPreferences['historySort'],
    manualProjectOrder,
    pinnedProjectIds,
    pinnedConversationIds,
    archivedConversationIds,
    sidebarWidth: Math.min(Math.max(Math.round(input.sidebarWidth), SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH),
  }
}

export function createSidebarPreferencesStore(preferencesPath: string) {
  let writeQueue: Promise<void> = Promise.resolve()

  const read = async () => {
    await writeQueue.catch(() => undefined)
    try {
      return normalizeSidebarPreferences(JSON.parse(await readFile(preferencesPath, 'utf8')))
    } catch {
      return null
    }
  }

  const write = async (value: unknown) => {
    const preferences = normalizeSidebarPreferences(value)
    if (!preferences) throw new Error('无效的侧边栏偏好设置')
    writeQueue = writeQueue.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(preferencesPath), { recursive: true })
      const temporaryPath = `${preferencesPath}.${process.pid}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporaryPath, preferencesPath)
    })
    await writeQueue
    return preferences
  }

  return { read, write }
}

const readJsonBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 256 * 1024) throw new Error('请求内容超过 256KB')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

export function sidebarPreferencesMiddleware(store: ReturnType<typeof createSidebarPreferencesStore>) {
  return async (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname !== '/api/sidebar-preferences') return next()
    response.setHeader('cache-control', 'no-store')
    response.setHeader('content-type', 'application/json; charset=utf-8')
    if (request.method === 'GET') {
      response.statusCode = 200
      response.end(JSON.stringify({ preferences: await store.read() }))
      return
    }
    if (request.method === 'PUT') {
      try {
        const preferences = await store.write(await readJsonBody(request))
        response.statusCode = 200
        response.end(JSON.stringify({ preferences }))
      } catch (error) {
        response.statusCode = 400
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : '无法保存侧边栏偏好设置' }))
      }
      return
    }
    response.statusCode = 405
    response.setHeader('allow', 'GET, PUT')
    response.end(JSON.stringify({ error: 'Method not allowed' }))
  }
}
