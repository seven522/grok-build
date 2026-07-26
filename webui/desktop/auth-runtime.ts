import { spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

type LoginSpawnOptions = {
  cwd: string
  env: NodeJS.ProcessEnv
  stdio: ['ignore', 'ignore', 'ignore']
  shell: false
}

export type LoginProcessSpawner = (
  command: string,
  args: string[],
  options: LoginSpawnOptions,
) => ChildProcess

const loginOnlyEnvironmentKeys = [
  'GROK_AUTH',
  'GROK_AUTH_PATH',
  'XAI_API_KEY',
  'GROK_CODE_XAI_API_KEY',
  'GROK_DEPLOYMENT_KEY',
  'MIMO_API_KEY',
  'DEEPSEEK_API_KEY',
  'UNI_ENV_FILE',
  'GROK_AGENT_SECRET',
  'PERSONAL_AGENT_BRIDGE_SECRET',
  'PERSONAL_AGENT_BRIDGE_TARGET',
] as const

export function createXaiOAuthLoginEnvironment(
  grokHome: string,
  authPath: string,
  source: NodeJS.ProcessEnv = process.env,
) {
  const environment: NodeJS.ProcessEnv = { ...source, GROK_HOME: grokHome }
  for (const key of loginOnlyEnvironmentKeys) delete environment[key]
  environment.GROK_AUTH_PATH = authPath
  return environment
}

const defaultSpawner: LoginProcessSpawner = (command, args, options) => spawn(command, args, options)

type SerializedAuth = { key?: unknown; auth_mode?: unknown }
type AuthStore = Record<string, SerializedAuth>

const readAuthStore = (authPath: string, allowMissing = false): AuthStore => {
  try {
    const value = JSON.parse(readFileSync(authPath, 'utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid auth store')
    return value as AuthStore
  } catch (error) {
    if (allowMissing && !existsSync(authPath)) return {}
    throw error
  }
}

const readValidatedStagedAuthStore = (stagedAuthPath: string) => {
  const staged = readAuthStore(stagedAuthPath)
  const stagedEntries = Object.entries(staged)
  if (!stagedEntries.length || stagedEntries.some(([, auth]) => (
    !auth || typeof auth !== 'object' || typeof auth.key !== 'string' || !auth.key.trim()
  ))) throw new Error('xAI 登录未完成，请重试')
  return staged
}

const promoteAuthStore = (stagedAuthPath: string, authPath: string) => {
  const staged = readValidatedStagedAuthStore(stagedAuthPath)
  if (existsSync(authPath) && lstatSync(authPath).isSymbolicLink()) throw new Error('unsafe auth path')
  const current = readAuthStore(authPath, true)
  const merged: AuthStore = { ...current, ...staged }
  delete merged['https://accounts.x.ai/sign-in']
  const promotionPath = `${authPath}.${process.pid}.${Date.now()}.tmp`
  let promotionFd: number | null = null
  try {
    promotionFd = openSync(promotionPath, 'wx', 0o600)
    writeFileSync(promotionFd, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    fsyncSync(promotionFd)
    closeSync(promotionFd)
    promotionFd = null
    chmodSync(promotionPath, 0o600)
    renameSync(promotionPath, authPath)
  } finally {
    if (promotionFd !== null) closeSync(promotionFd)
    rmSync(promotionPath, { force: true })
  }
}

export async function runCliOAuthLogin(input: {
  binaryPath: string
  workspace: string
  grokHome: string
  environment?: NodeJS.ProcessEnv
  signal?: AbortSignal
  spawnProcess?: LoginProcessSpawner
  beforeCommit?: () => void | Promise<void>
}) {
  if (input.signal?.aborted) throw new Error('xAI 登录已取消')
  let stagingDirectory: string | undefined
  try {
    mkdirSync(input.grokHome, { recursive: true })
    const authPath = path.join(input.grokHome, 'auth.json')
    stagingDirectory = mkdtempSync(path.join(input.grokHome, '.auth-login-'))
    const stagedAuthPath = path.join(stagingDirectory, 'auth.json')
    chmodSync(stagingDirectory, 0o700)
    const configPath = path.join(input.grokHome, 'config.toml')
    if (existsSync(configPath)) {
      copyFileSync(configPath, path.join(stagingDirectory, 'config.toml'))
      chmodSync(path.join(stagingDirectory, 'config.toml'), 0o600)
    }

    const child = (input.spawnProcess ?? defaultSpawner)(
      input.binaryPath,
      ['login', '--oauth'],
      {
        cwd: input.workspace,
        env: createXaiOAuthLoginEnvironment(stagingDirectory, stagedAuthPath, input.environment),
        stdio: ['ignore', 'ignore', 'ignore'],
        shell: false,
      },
    )

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let cancellationRequested = false
      let forceKillTimer: NodeJS.Timeout | undefined
      const finish = (result: 'success' | 'cancelled' | 'failed') => {
        if (settled) return
        settled = true
        if (forceKillTimer) clearTimeout(forceKillTimer)
        input.signal?.removeEventListener('abort', cancel)
        if (result === 'success') resolve()
        else reject(new Error(result === 'cancelled' ? 'xAI 登录已取消' : 'xAI 登录未完成，请重试'))
      }
      const cancel = () => {
        cancellationRequested = true
        if (child.exitCode !== null || child.signalCode !== null) {
          finish('cancelled')
          return
        }
        child.kill('SIGTERM')
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, 2_000)
        forceKillTimer.unref()
      }

      input.signal?.addEventListener('abort', cancel, { once: true })
      if (input.signal?.aborted) cancel()
      child.once('error', () => finish(cancellationRequested ? 'cancelled' : 'failed'))
      child.once('exit', (code) => finish(cancellationRequested ? 'cancelled' : code === 0 ? 'success' : 'failed'))
    })

    readValidatedStagedAuthStore(stagedAuthPath)
    await input.beforeCommit?.()
    if (input.signal?.aborted) throw new Error('xAI 登录已取消')
    promoteAuthStore(stagedAuthPath, authPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (input.signal?.aborted || message === 'xAI 登录已取消') throw new Error('xAI 登录已取消')
    if (message === 'xAI 登录未完成，请重试') throw new Error(message)
    throw new Error('xAI 登录凭据无法安全保存，请重试')
  } finally {
    if (stagingDirectory) {
      try { rmSync(stagingDirectory, { recursive: true, force: true }) }
      catch { /* app-private 0700 staging remains inaccessible if cleanup itself fails */ }
    }
  }
}
