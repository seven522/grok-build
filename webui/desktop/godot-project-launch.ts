import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

type RegisteredProject = { id?: unknown; rootPath?: unknown }

export type GodotProjectLaunchReceipt = {
  launchId: string
  status: 'awaiting_visual_confirmation'
  projectId: string
  projectRoot: string
  applicationPath: string
  launchedAt: string
}

type LaunchCommand = (executable: string, args: readonly string[]) => Promise<void>

const defaultLaunchCommand: LaunchCommand = (executable, args) => new Promise((resolve, reject) => {
  execFile(executable, [...args], { timeout: 10_000, windowsHide: true }, (error) => {
    if (error) reject(error)
    else resolve()
  })
})

const ordinaryDirectory = async (target: string, label: string) => {
  const metadata = await lstat(target)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`${label}不是普通文件夹`)
  return realpath(target)
}

const ordinaryFile = async (target: string, label: string) => {
  const metadata = await lstat(target)
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label}不是普通文件`)
  return realpath(target)
}

export async function resolveRegisteredGodotProject(options: {
  projectId: unknown
  registryPath: string
}) {
  if (typeof options.projectId !== 'string' || !options.projectId.trim() || options.projectId.length > 200) {
    throw new Error('无效的项目标识')
  }
  const parsed = JSON.parse(await readFile(options.registryPath, 'utf8')) as unknown
  if (!Array.isArray(parsed)) throw new Error('项目登记表格式无效')
  const project = parsed.find((entry): entry is RegisteredProject => (
    Boolean(entry)
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && (entry as RegisteredProject).id === options.projectId
  ))
  if (!project || typeof project.rootPath !== 'string' || !path.isAbsolute(project.rootPath)) {
    throw new Error('项目未登记或目录无效')
  }
  const projectRoot = await ordinaryDirectory(path.resolve(project.rootPath), '项目目录')
  await ordinaryFile(path.join(projectRoot, 'project.godot'), 'project.godot ')
  return { projectId: options.projectId, projectRoot }
}

export async function resolveGodotApplication(options: {
  platform: NodeJS.Platform
  homeDirectory: string
  configuredApplication?: string
}) {
  if (options.platform !== 'darwin') throw new Error('当前版本的系统侧 Godot 启动仅支持 macOS')
  const candidates = [
    options.configuredApplication,
    '/Applications/Godot.app',
    path.join(options.homeDirectory, 'Applications', 'Godot.app'),
    path.join(options.homeDirectory, 'Desktop', 'Godot.app'),
    // Common local install locations used with Homebrew/godot4 symlinks.
    path.join(options.homeDirectory, 'Downloads', 'Godot.app'),
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue
    try {
      const applicationPath = await ordinaryDirectory(path.resolve(candidate), 'Godot 应用')
      await ordinaryFile(path.join(applicationPath, 'Contents', 'MacOS', 'Godot'), 'Godot 可执行文件')
      return applicationPath
    } catch { /* try the next fixed candidate */ }
  }
  throw new Error('未找到受信任的 Godot.app；请安装到“应用程序”文件夹，或设置 RUNBUILD_GODOT_APP')
}

export async function launchRegisteredGodotProject(options: {
  projectId: unknown
  registryPath: string
  platform: NodeJS.Platform
  homeDirectory: string
  configuredApplication?: string
  launchCommand?: LaunchCommand
  now?: () => Date
}): Promise<GodotProjectLaunchReceipt> {
  const project = await resolveRegisteredGodotProject(options)
  const applicationPath = await resolveGodotApplication(options)
  const launchCommand = options.launchCommand ?? defaultLaunchCommand
  await launchCommand('/usr/bin/open', ['-na', applicationPath, '--args', '--path', project.projectRoot])
  return {
    launchId: randomUUID(),
    status: 'awaiting_visual_confirmation',
    projectId: project.projectId,
    projectRoot: project.projectRoot,
    applicationPath,
    launchedAt: (options.now?.() ?? new Date()).toISOString(),
  }
}
