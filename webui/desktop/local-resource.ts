import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

export type TrustedLocalResource = { kind: 'file' | 'directory'; path: string }

const safeFileExtensions = new Set([
  '.avif', '.bmp', '.c', '.cc', '.conf', '.cpp', '.cs', '.css', '.csv', '.dart', '.diff', '.env.example',
  '.gif', '.go', '.godot', '.h', '.hpp', '.html', '.ini', '.java', '.jpeg', '.jpg', '.js', '.json', '.jsx',
  '.kt', '.kts', '.lua', '.md', '.mjs', '.mm', '.pdf', '.plist', '.png', '.py', '.rb', '.rs', '.scss', '.sh',
  '.sql', '.svg', '.swift', '.toml', '.ts', '.tsx', '.txt', '.vue', '.webp', '.xml', '.yaml', '.yml', '.zig',
])
const safeExtensionlessNames = new Set(['Dockerfile', 'LICENSE', 'Makefile', 'README'])

const insideRoot = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const registeredProjectRoots = async (registryPath: string) => {
  try {
    const parsed = JSON.parse(await readFile(registryPath, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const rootPath = (entry as Record<string, unknown>).rootPath
      return typeof rootPath === 'string' && rootPath.trim() ? [rootPath] : []
    })
  } catch {
    return []
  }
}

const safeDocument = (target: string) => {
  const base = path.basename(target)
  if (safeExtensionlessNames.has(base)) return true
  const lower = base.toLowerCase()
  return [...safeFileExtensions].some((extension) => lower.endsWith(extension))
}

export async function resolveTrustedLocalResource(options: {
  target: unknown
  workspace: string
  registryPath: string
}): Promise<TrustedLocalResource> {
  if (typeof options.target !== 'string' || !options.target.trim() || options.target.length > 4_096 || options.target.includes('\0')) {
    throw new Error('无效的本地文件路径')
  }
  const requested = path.resolve(options.target)
  const metadata = await lstat(requested)
  if (metadata.isSymbolicLink()) throw new Error('不能打开符号链接')
  const resolved = await realpath(requested)
  const roots = [options.workspace, ...await registeredProjectRoots(options.registryPath)]
  const allowedRoots = (await Promise.all(roots.map(async (root) => {
    try { return await realpath(path.resolve(root)) }
    catch { return null }
  }))).filter((root): root is string => Boolean(root))
  if (!allowedRoots.some((root) => insideRoot(root, resolved))) throw new Error('文件不在当前工作区或已登记项目中')
  if (metadata.isDirectory()) return { kind: 'directory', path: resolved }
  if (!metadata.isFile() || !safeDocument(resolved)) throw new Error('该文件类型不能从聊天中直接打开')
  return { kind: 'file', path: resolved }
}
