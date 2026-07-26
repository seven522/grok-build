import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export type ProjectSourceInput = {
  name: string
  mimeType: string
  size: number
  kind: 'image' | 'text'
  data: string
}

export type ProjectSource = Omit<ProjectSourceInput, 'data'> & {
  id: string
  relativePath: string
}

export type StoredProject = {
  id: string
  name: string
  rootPath: string
  location: 'managed' | 'external'
  instructions: string
  sources: ProjectSource[]
  defaultSandbox: 'workspace'
  createdAt: string
  updatedAt: string
}

export type ProjectFile = {
  path: string
  name: string
  kind: 'text' | 'image' | 'unsupported'
  mimeType: string
  size: number
}

export class ProjectFileNotFoundError extends Error {
  readonly code = 'file_not_found'

  constructor() {
    super('文件尚未创建')
    this.name = 'ProjectFileNotFoundError'
  }
}

type ProjectInput = {
  name?: unknown
  instructions?: unknown
  sources?: unknown
  rootPath?: unknown
}

const MAX_BODY_BYTES = 16 * 1024 * 1024
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_SOURCES = 12
const MAX_PROJECT_FILES = 500
const MAX_PROJECT_FILE_BYTES = 2 * 1024 * 1024
const IGNORED_PROJECT_DIRECTORIES = new Set(['.git', '.grok', 'node_modules', 'target', 'dist', 'release'])
const MANAGED_CODING_RULES_START = '<!-- personal-agent:managed-coding-rules:start -->'
const MANAGED_CODING_RULES_END = '<!-- personal-agent:managed-coding-rules:end -->'

const filePresentation = (fileName: string): Pick<ProjectFile, 'kind' | 'mimeType'> => {
  const extension = path.extname(fileName).toLowerCase()
  const images: Record<string, string> = {
    '.avif': 'image/avif',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  }
  if (images[extension]) return { kind: 'image', mimeType: images[extension] }
  const text: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.jsx': 'text/javascript; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.py': 'text/x-python; charset=utf-8',
    '.rs': 'text/plain; charset=utf-8',
    '.sh': 'text/x-shellscript; charset=utf-8',
    '.toml': 'text/plain; charset=utf-8',
    '.ts': 'text/plain; charset=utf-8',
    '.tsx': 'text/plain; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.yaml': 'text/yaml; charset=utf-8',
    '.yml': 'text/yaml; charset=utf-8',
  }
  return text[extension]
    ? { kind: 'text', mimeType: text[extension] }
    : { kind: 'unsupported', mimeType: 'application/octet-stream' }
}

const safeSlug = (value: string) => {
  const slug = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'project'
}

const safeFileName = (value: string) => {
  const base = path.basename(value).normalize('NFKC').replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-').trim()
  return (base || 'source').slice(0, 120)
}

const isInside = (parent: string, candidate: string) => {
  const relative = path.relative(parent, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

const ensureRealProjectDirectory = async (projectRoot: string, directoryName: '.grok' | 'references') => {
  const realRoot = await realpath(projectRoot)
  const target = path.join(realRoot, directoryName)
  try {
    const metadata = await lstat(target)
    if (metadata.isSymbolicLink()) throw new Error(`${directoryName} 不能是符号链接`)
    if (!metadata.isDirectory()) throw new Error(`${directoryName} 必须是普通文件夹`)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code !== 'ENOENT') throw error
    await mkdir(target)
  }
  const realTarget = await realpath(target)
  if (!isInside(realRoot, realTarget)) throw new Error(`${directoryName} 必须位于项目目录内`)
  return realTarget
}

const legacyProjectInstructions = (project: Pick<StoredProject, 'name' | 'instructions'>) => [
  `# ${project.name}`,
  '',
  project.instructions || 'Follow the user request and preserve the files in this project.',
  '',
  'Project reference files are stored in `./references`.',
  'Treat this directory as the project workspace. Do not access sibling project directories unless the user explicitly asks.',
  '',
].join('\n')

const projectInstructions = (project: Pick<StoredProject, 'name' | 'instructions'>) => [
  MANAGED_CODING_RULES_START,
  `# ${project.name} coding rules`,
  '',
  '## Project request',
  '',
  project.instructions || 'Implement the user request precisely and preserve existing behavior outside its scope.',
  '',
  'Project reference files are stored in `./references`.',
  'Treat this directory as the project workspace. Do not access sibling project directories unless the user explicitly asks.',
  '',
  '## Engineering protocol',
  '',
  '1. Before editing, read the applicable project instructions, current Git changes, the owning module, and the nearest tests.',
  '2. Reproduce the requested behavior or state clearly why reproduction is unavailable. Do not guess from filenames or model output.',
  '3. Make the smallest cohesive change that solves the root cause. Preserve unrelated code, public contracts, and user work.',
  '4. Keep logic simple, explicit, and consistent with local patterns. Add comments only where intent or a non-obvious constraint needs explaining.',
  '5. For large features, trace callers and downstream consumers, then implement in independently verifiable increments without opportunistic refactors.',
  '6. Run the narrowest relevant check first, then adjacent regression checks. Review the final diff before reporting completion.',
  '',
  '## Native application boundary',
  '',
  '- A process ID or zero exit code does not prove that a native application rendered a usable window.',
  '- Treat a GUI launch blocked by the workspace sandbox as an execution-boundary limitation, not evidence that project rendering or scene code is broken.',
  '- Do not add executable launcher files, force rendering backends, or rewrite visual nodes solely to work around a sandbox-only launch failure.',
  '- Use RunBuild desktop system launch and its visual confirmation when available; otherwise report the launch as blocked and preserve the project.',
  '',
  '## Project memory',
  '',
  '- For non-trivial work, search project memory when memory tools are available before choosing an implementation.',
  '- Treat remembered facts as leads: verify paths, APIs, behavior, and tests against the current checkout.',
  '- Retain only confirmed, reusable decisions and conventions. Never retain secrets, credentials, or unverified guesses.',
  MANAGED_CODING_RULES_END,
  '',
].join('\n')

const mergeProjectInstructions = (
  existing: string,
  project: Pick<StoredProject, 'name' | 'instructions'>,
  previousProject?: Pick<StoredProject, 'name' | 'instructions'>,
) => {
  const managed = projectInstructions(project).trimEnd()
  const current = previousProject && existing.trimEnd() === legacyProjectInstructions(previousProject).trimEnd()
    ? ''
    : existing.trimEnd()
  const start = current.indexOf(MANAGED_CODING_RULES_START)
  const end = current.indexOf(MANAGED_CODING_RULES_END)
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) {
    throw new Error('AGENTS.md 中的受管编码规则标记不完整，请先修复后重试')
  }
  if (start < 0) return current ? `${current}\n\n${managed}\n` : `${managed}\n`

  const before = current.slice(0, start).trimEnd()
  const after = current.slice(end + MANAGED_CODING_RULES_END.length).trim()
  return [before, managed, after].filter(Boolean).join('\n\n') + '\n'
}

const writeProjectInstructions = async (
  projectRoot: string,
  project: Pick<StoredProject, 'name' | 'instructions'>,
  previousProject?: Pick<StoredProject, 'name' | 'instructions'>,
) => {
  const target = path.join(projectRoot, 'AGENTS.md')
  let existing = ''
  try {
    const metadata = await lstat(target)
    if (metadata.isSymbolicLink()) throw new Error('AGENTS.md 是符号链接，无法安全写入项目编码规则')
    if (!metadata.isFile()) throw new Error('AGENTS.md 不是普通文件，无法安全写入项目编码规则')
    existing = await readFile(target, 'utf8')
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code !== 'ENOENT') throw error
  }
  await writeFile(target, mergeProjectInstructions(existing, project, previousProject), 'utf8')
}

async function readJsonBody(request: IncomingMessage): Promise<ProjectInput> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new Error('请求内容超过 16MB')
    chunks.push(buffer)
  }
  if (!chunks.length) return {}
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求内容必须是 JSON 对象')
  return value as ProjectInput
}

function normalizeSources(value: unknown): ProjectSourceInput[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_SOURCES).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('项目来源格式无效')
    const item = entry as Record<string, unknown>
    const name = typeof item.name === 'string' ? safeFileName(item.name) : ''
    const mimeType = typeof item.mimeType === 'string' ? item.mimeType.slice(0, 120) : 'application/octet-stream'
    const kind = item.kind === 'image' ? 'image' : item.kind === 'text' ? 'text' : null
    const data = typeof item.data === 'string' ? item.data : ''
    const size = typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : 0
    if (!name || !kind || !data) throw new Error('项目来源缺少名称、类型或内容')
    const decodedBytes = kind === 'image' ? Buffer.byteLength(data, 'base64') : Buffer.byteLength(data, 'utf8')
    if (decodedBytes > MAX_SOURCE_BYTES || size > MAX_SOURCE_BYTES) throw new Error(`${name} 超过 2MB`)
    return { name, mimeType, kind, data, size: decodedBytes }
  })
}

export function createProjectRegistry(options: { projectsRoot: string; registryPath: string }) {
  const projectsRoot = path.resolve(options.projectsRoot)
  const registryPath = path.resolve(options.registryPath)
  let mutationQueue: Promise<void> = Promise.resolve()

  const serializeMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation, operation)
    mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  const ensureStorage = async () => {
    await mkdir(projectsRoot, { recursive: true })
    await mkdir(path.dirname(registryPath), { recursive: true })
  }

  const list = async (): Promise<StoredProject[]> => {
    await ensureStorage()
    try {
      const parsed = JSON.parse(await readFile(registryPath, 'utf8')) as unknown
      return Array.isArray(parsed) ? parsed as StoredProject[] : []
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code === 'ENOENT') return []
      throw error
    }
  }

  const persist = async (projects: StoredProject[]) => {
    await ensureStorage()
    const temporary = `${registryPath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(projects, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, registryPath)
  }

  const writeSources = async (projectRoot: string, sourceInputs: ProjectSourceInput[]) => {
    const referencesRoot = await ensureRealProjectDirectory(projectRoot, 'references')
    const stored: ProjectSource[] = []
    for (const source of sourceInputs) {
      const fileName = `${randomUUID().slice(0, 8)}-${safeFileName(source.name)}`
      const target = path.resolve(referencesRoot, fileName)
      if (!isInside(referencesRoot, target)) throw new Error('项目来源路径无效')
      await writeFile(target, source.kind === 'image' ? Buffer.from(source.data, 'base64') : source.data)
      stored.push({
        id: randomUUID(),
        name: source.name,
        mimeType: source.mimeType,
        size: source.size,
        kind: source.kind,
        relativePath: path.posix.join('references', fileName),
      })
    }
    return stored
  }

  const create = (input: ProjectInput): Promise<StoredProject> => serializeMutation(async () => {
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : ''
    const instructions = typeof input.instructions === 'string' ? input.instructions.trim().slice(0, 20_000) : ''
    if (!name) throw new Error('项目名称不能为空')
    const id = randomUUID()
    const rootPath = path.resolve(projectsRoot, `${safeSlug(name)}-${id.slice(0, 8)}`)
    if (!isInside(projectsRoot, rootPath)) throw new Error('项目目录无效')
    const timestamp = new Date().toISOString()
    const project: StoredProject = {
      id,
      name,
      rootPath,
      location: 'managed',
      instructions,
      sources: [],
      defaultSandbox: 'workspace',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await mkdir(rootPath, { recursive: true })
    await ensureRealProjectDirectory(rootPath, '.grok')
    project.sources = await writeSources(rootPath, normalizeSources(input.sources))
    await writeProjectInstructions(rootPath, project)
    const projects = await list()
    await persist([...projects, project])
    return project
  })

  const importExisting = (input: ProjectInput): Promise<StoredProject> => serializeMutation(async () => {
    const requestedPath = typeof input.rootPath === 'string' ? input.rootPath.trim() : ''
    if (!requestedPath) throw new Error('请选择已有项目文件夹')

    const resolvedRoot = path.resolve(requestedPath)
    const metadata = await stat(resolvedRoot)
    if (!metadata.isDirectory()) throw new Error('选择的路径不是文件夹')

    const realRoot = await realpath(resolvedRoot)
    const projects = await list()
    if (projects.some((project) => path.resolve(project.rootPath) === realRoot)) throw new Error('这个文件夹已经作为项目添加')

    const name = (typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '') || path.basename(realRoot)
    const instructions = typeof input.instructions === 'string' ? input.instructions.trim().slice(0, 20_000) : ''
    const timestamp = new Date().toISOString()
    const project: StoredProject = {
      id: randomUUID(),
      name,
      rootPath: realRoot,
      location: 'external',
      instructions,
      sources: [],
      defaultSandbox: 'workspace',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await ensureRealProjectDirectory(realRoot, '.grok')
    project.sources = await writeSources(realRoot, normalizeSources(input.sources))
    await writeProjectInstructions(realRoot, project)
    await persist([...projects, project])
    return project
  })

  const update = (id: string, input: ProjectInput): Promise<StoredProject> => serializeMutation(async () => {
    const projects = await list()
    const index = projects.findIndex((project) => project.id === id)
    if (index < 0) throw new Error('项目不存在')
    const current = projects[index]
    const resolvedRoot = path.resolve(current.rootPath)
    if (current.location !== 'external' && !isInside(projectsRoot, resolvedRoot)) throw new Error('项目目录不在受管范围内')
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 80) : current.name
    const instructions = typeof input.instructions === 'string' ? input.instructions.trim().slice(0, 20_000) : current.instructions
    const addedSources = await writeSources(resolvedRoot, normalizeSources(input.sources))
    const updated: StoredProject = {
      ...current,
      name,
      instructions,
      sources: [...current.sources, ...addedSources].slice(0, MAX_SOURCES),
      updatedAt: new Date().toISOString(),
    }
    await writeProjectInstructions(resolvedRoot, updated, current)
    projects[index] = updated
    await persist(projects)
    return updated
  })

  const projectById = async (id: string) => {
    const project = (await list()).find((entry) => entry.id === id)
    if (!project) throw new Error('项目不存在')
    const rootPath = path.resolve(project.rootPath)
    if (project.location !== 'external' && !isInside(projectsRoot, rootPath)) throw new Error('项目目录不在受管范围内')
    const metadata = await stat(rootPath)
    if (!metadata.isDirectory()) throw new Error('项目目录不存在')
    return { project, rootPath: await realpath(rootPath) }
  }

  const listFiles = async (id: string): Promise<ProjectFile[]> => {
    const { rootPath } = await projectById(id)
    const files: ProjectFile[] = []
    const walk = async (directory: string, relativeDirectory = '', depth = 0): Promise<void> => {
      if (depth > 8 || files.length >= MAX_PROJECT_FILES) return
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        if (files.length >= MAX_PROJECT_FILES) return
        if (entry.name.startsWith('.') || (entry.isDirectory() && IGNORED_PROJECT_DIRECTORIES.has(entry.name))) continue
        const relativePath = path.posix.join(relativeDirectory, entry.name)
        const target = path.resolve(rootPath, relativePath)
        if (!isInside(rootPath, target)) continue
        if (entry.isDirectory()) {
          await walk(target, relativePath, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        const metadata = await stat(target)
        const presentation = filePresentation(entry.name)
        files.push({ path: relativePath, name: entry.name, size: metadata.size, ...presentation })
      }
    }
    await walk(rootPath)
    return files
  }

  const readProjectFile = async (id: string, relativePath: string) => {
    const { rootPath } = await projectById(id)
    const normalized = relativePath.replaceAll('\\', '/').replace(/^\/+/, '')
    if (!normalized) throw new Error('文件路径不能为空')
    const target = path.resolve(rootPath, normalized)
    if (!isInside(rootPath, target)) throw new Error('文件不在项目目录内')
    try {
      const targetLink = await lstat(target)
      if (targetLink.isSymbolicLink()) throw new Error('符号链接文件不支持预览')
      const [realRootPath, realTarget] = await Promise.all([realpath(rootPath), realpath(target)])
      if (!isInside(realRootPath, realTarget)) throw new Error('文件不在项目目录内')
      const metadata = await stat(realTarget)
      if (!metadata.isFile()) throw new Error('目标不是文件')
      if (metadata.size > MAX_PROJECT_FILE_BYTES) throw new Error('文件超过 2MB，无法预览')
      const presentation = filePresentation(realTarget)
      if (presentation.kind === 'unsupported') throw new Error('当前文件类型不支持预览')
      return { data: await readFile(realTarget), size: metadata.size, ...presentation }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code === 'ENOENT') throw new ProjectFileNotFoundError()
      throw error
    }
  }

  return { list, create, importExisting, update, listFiles, readProjectFile, projectsRoot, registryPath }
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

export function projectRegistryMiddleware(registry: ReturnType<typeof createProjectRegistry>) {
  return async (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api/projects' && request.method === 'GET') {
      try { sendJson(response, 200, { projects: await registry.list() }) } catch (error) { next(error) }
      return
    }
    if (url.pathname === '/api/projects' && request.method === 'POST') {
      try { sendJson(response, 201, { project: await registry.create(await readJsonBody(request)) }) }
      catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : '无法创建项目' }) }
      return
    }
    if (url.pathname === '/api/projects/import' && request.method === 'POST') {
      try { sendJson(response, 201, { project: await registry.importExisting(await readJsonBody(request)) }) }
      catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : '无法添加项目文件夹' }) }
      return
    }
    const filesMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/files$/i)
    if (filesMatch && request.method === 'GET') {
      try { sendJson(response, 200, { files: await registry.listFiles(filesMatch[1]) }) }
      catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : '无法读取项目文件' }) }
      return
    }
    const fileMatch = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/file$/i)
    if (fileMatch && request.method === 'GET') {
      try {
        const file = await registry.readProjectFile(fileMatch[1], url.searchParams.get('path') ?? '')
        response.statusCode = 200
        response.setHeader('content-type', file.mimeType)
        response.setHeader('cache-control', 'no-store')
        response.setHeader('x-content-type-options', 'nosniff')
        response.end(file.data)
      } catch (error) {
        if (error instanceof ProjectFileNotFoundError) {
          sendJson(response, 404, { code: error.code, error: error.message })
        } else {
          sendJson(response, 400, { error: error instanceof Error ? error.message : '无法预览文件' })
        }
      }
      return
    }
    const match = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)$/i)
    if (match && request.method === 'PATCH') {
      try { sendJson(response, 200, { project: await registry.update(match[1], await readJsonBody(request)) }) }
      catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : '无法更新项目' }) }
      return
    }
    next()
  }
}
