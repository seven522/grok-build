import { createReadStream } from 'node:fs'
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { StoredProject } from './project-registry.ts'

export type SessionCatalogEntry = {
  id: string
  title: string
  createdAt: string
  cwd: string
  projectId: string | null
}

type ProjectRegistryReader = { list: () => Promise<StoredProject[]> }
type SessionSummary = {
  info?: { id?: unknown; cwd?: unknown }
  session_summary?: unknown
  updated_at?: unknown
  created_at?: unknown
  num_chat_messages?: unknown
}

const MAX_SUMMARY_BYTES = 512 * 1024
const MAX_HISTORY_PREFIX_BYTES = 512 * 1024
const MAX_SESSION_DIRECTORIES = 2_000
const DEFAULT_SCOPE_LIMIT = 50
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/
const IMAGE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.(?:avif|gif|jpe?g|png|webp)$/i
const imageContentTypes: Record<string, string> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

const asText = (value: unknown) => typeof value === 'string' ? value.trim() : ''

const displayTitle = (value: string) => value
  .replace(/[\u0000-\u001f\u007f]+/g, ' ')
  .replace(/`{3,}/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 120)

const isInternalText = (value: string) => {
  const normalized = value.trimStart().toLowerCase()
  return normalized.startsWith('<system-reminder>')
    || normalized.startsWith('<environment_context>')
    || normalized.startsWith('<permissions instructions>')
}

const isInternalPrompt = (row: Record<string, unknown>, value: string) =>
  Boolean(asText(row.synthetic_reason)) || isInternalText(value)

const readSmallTextFile = async (target: string, maxBytes: number) => {
  try {
    const metadata = await lstat(target)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) return ''
    return await readFile(target, 'utf8')
  } catch {
    return ''
  }
}

const firstUserPrompt = async (sessionDirectory: string) => {
  const target = path.join(sessionDirectory, 'chat_history.jsonl')
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    const metadata = await lstat(target)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) return ''
    handle = await open(target, 'r')
    const bytes = Math.min(metadata.size, MAX_HISTORY_PREFIX_BYTES)
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      let item: unknown
      try { item = JSON.parse(line) } catch { continue }
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const row = item as Record<string, unknown>
      if (row.type !== 'user' || !Array.isArray(row.content)) continue
      const text = row.content
        .filter((part): part is Record<string, unknown> => Boolean(part && typeof part === 'object' && !Array.isArray(part)))
        .filter((part) => part.type === 'text')
        .map((part) => asText(part.text))
        .filter(Boolean)
        .join(' ')
      if (text && !isInternalPrompt(row, text)) return displayTitle(text)
    }
  } catch {
    return ''
  } finally {
    await handle?.close().catch(() => undefined)
  }
  return ''
}

const canonicalDirectory = async (value: string) => {
  try { return await realpath(value) } catch { return path.resolve(value) }
}

const isDirectory = async (target: string) => {
  try {
    const metadata = await lstat(target)
    return metadata.isDirectory() && !metadata.isSymbolicLink()
  } catch {
    return false
  }
}

const workspaceDirectories = async (sessionsRoot: string, cwd: string) => {
  const direct = path.join(sessionsRoot, encodeURIComponent(cwd))
  if (await isDirectory(direct)) return [direct]
  try {
    const entries = await readdir(sessionsRoot, { withFileTypes: true })
    const matches: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      let decoded = ''
      try { decoded = decodeURIComponent(entry.name) } catch { continue }
      if (await canonicalDirectory(decoded) === cwd) matches.push(path.join(sessionsRoot, entry.name))
    }
    return matches
  } catch {
    return []
  }
}

const readScope = async (options: {
  home: string
  cwd: string
  projectId: string | null
  limit: number
}) => {
  const cwd = await canonicalDirectory(options.cwd)
  const sessionsRoot = path.join(await canonicalDirectory(options.home), 'sessions')
  const workspaces = await workspaceDirectories(sessionsRoot, cwd)
  const candidates: Array<{ entry: SessionCatalogEntry; sessionDirectory: string; hasTitle: boolean }> = []

  for (const workspaceDirectory of workspaces) {
    let sessionDirectories: string[] = []
    try {
      sessionDirectories = (await readdir(workspaceDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== 'subagents')
        // Session IDs are UUIDv7-like and sort newest-first; sort before the safety cap so readdir order cannot hide recent sessions.
        .sort((left, right) => right.name.localeCompare(left.name))
        .slice(0, MAX_SESSION_DIRECTORIES)
        .map((entry) => path.join(workspaceDirectory, entry.name))
    } catch {
      continue
    }

    const rows = await Promise.all(sessionDirectories.map(async (sessionDirectory) => {
      const source = await readSmallTextFile(path.join(sessionDirectory, 'summary.json'), MAX_SUMMARY_BYTES)
      if (!source) return null
      let summary: SessionSummary
      try { summary = JSON.parse(source) as SessionSummary } catch { return null }
      const id = asText(summary.info?.id)
      const summaryCwd = asText(summary.info?.cwd)
      if (!id || !summaryCwd || await canonicalDirectory(summaryCwd) !== cwd) return null
      const summaryTitle = displayTitle(asText(summary.session_summary))
      const title = isInternalText(summaryTitle) ? '' : summaryTitle
      const createdAt = asText(summary.updated_at) || asText(summary.created_at) || new Date(0).toISOString()
      return {
        entry: { id, title, createdAt, cwd: summaryCwd, projectId: options.projectId },
        sessionDirectory,
        hasTitle: Boolean(title),
      }
    }))
    candidates.push(...rows.filter((row): row is NonNullable<typeof row> => Boolean(row)))
  }

  const selected = candidates
    .sort((left, right) => right.entry.createdAt.localeCompare(left.entry.createdAt))
    .slice(0, options.limit)

  return Promise.all(selected.map(async ({ entry, sessionDirectory, hasTitle }) => ({
    ...entry,
    title: hasTitle ? entry.title : await firstUserPrompt(sessionDirectory) || '新会话',
  })))
}

export async function listSessionCatalog(options: {
  grokHome: string
  workspace: string
  projects: StoredProject[]
  limitPerScope?: number
}) {
  const limit = Math.max(1, Math.min(options.limitPerScope ?? DEFAULT_SCOPE_LIMIT, 200))
  const scopes = [
    { home: options.grokHome, cwd: options.workspace, projectId: null as string | null },
    ...options.projects.map((project) => ({
      home: path.join(project.rootPath, '.grok'),
      cwd: project.rootPath,
      projectId: project.id,
    })),
  ].filter((scope) => scope.cwd.trim())

  const groups = await Promise.all(scopes.map(async (scope) => {
    if (!await isDirectory(scope.home)) return []
    return readScope({ ...scope, limit })
  }))
  const byId = new Map<string, SessionCatalogEntry>()
  for (const entry of groups.flat()) {
    const current = byId.get(entry.id)
    if (!current || entry.createdAt > current.createdAt) byId.set(entry.id, entry)
  }
  return [...byId.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export async function resolveSessionImage(options: {
  grokHome: string
  workspace: string
  projects: StoredProject[]
  sessionId: string
  filename: string
}) {
  if (!SESSION_ID_PATTERN.test(options.sessionId) || !IMAGE_FILE_PATTERN.test(options.filename)) return null
  const scopes = [
    { home: options.grokHome, cwd: options.workspace },
    ...options.projects.map((project) => ({ home: path.join(project.rootPath, '.grok'), cwd: project.rootPath })),
  ].filter((scope) => scope.cwd.trim())

  for (const scope of scopes) {
    const cwd = await canonicalDirectory(scope.cwd)
    const sessionsRoot = path.join(await canonicalDirectory(scope.home), 'sessions')
    for (const workspaceDirectory of await workspaceDirectories(sessionsRoot, cwd)) {
      const sessionDirectory = path.join(workspaceDirectory, options.sessionId)
      if (!await isDirectory(sessionDirectory)) continue
      const imagePath = path.join(sessionDirectory, 'images', options.filename)
      try {
        const metadata = await lstat(imagePath)
        if (!metadata.isFile() || metadata.isSymbolicLink()) continue
        const realSession = await realpath(sessionDirectory)
        const realImage = await realpath(imagePath)
        const relative = path.relative(realSession, realImage)
        if (relative.startsWith('..') || path.isAbsolute(relative)) continue
        return { path: realImage, size: metadata.size, contentType: imageContentTypes[path.extname(realImage).toLowerCase()] }
      } catch { /* try the next known session scope */ }
    }
  }
  return null
}

export function sessionMediaMiddleware(options: {
  grokHome: string
  workspace: string
  registry: ProjectRegistryReader
}) {
  return async (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const match = pathname.match(/^\/api\/session-media\/([^/]+)\/images\/([^/]+)$/)
    if (!match) return next()
    if (!['GET', 'HEAD'].includes(request.method ?? '')) {
      response.statusCode = 405
      response.setHeader('allow', 'GET, HEAD')
      response.end()
      return
    }
    try {
      const media = await resolveSessionImage({
        grokHome: options.grokHome,
        workspace: options.workspace,
        projects: await options.registry.list(),
        sessionId: match[1],
        filename: match[2],
      })
      if (!media?.contentType) {
        response.statusCode = 404
        response.end()
        return
      }
      response.statusCode = 200
      response.setHeader('cache-control', 'private, max-age=31536000, immutable')
      response.setHeader('content-length', String(media.size))
      response.setHeader('content-type', media.contentType)
      if (request.method === 'HEAD') response.end()
      else createReadStream(media.path).pipe(response)
    } catch (error) {
      next(error)
    }
  }
}

export function sessionCatalogMiddleware(options: {
  grokHome: string
  workspace: string
  registry: ProjectRegistryReader
}) {
  return async (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname !== '/api/session-catalog') return next()
    if (request.method !== 'GET') {
      response.statusCode = 405
      response.setHeader('allow', 'GET')
      response.end()
      return
    }
    try {
      const sessions = await listSessionCatalog({
        grokHome: options.grokHome,
        workspace: options.workspace,
        projects: await options.registry.list(),
      })
      response.statusCode = 200
      response.setHeader('cache-control', 'no-store')
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.end(JSON.stringify({ sessions }))
    } catch (error) {
      next(error)
    }
  }
}
