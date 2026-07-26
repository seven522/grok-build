import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { createProcessLeaseStore, type ProcessLease } from '../runner-ownership.ts'

/** Sandbox profiles accepted by xai-grok-pager. Default off so GUI tools (Godot) can open windows. */
const AGENT_SANDBOX_PROFILES = new Set(['off', 'workspace', 'read-only', 'strict', 'devbox'])

export function resolveAgentSandboxProfile(source: NodeJS.ProcessEnv = process.env): string {
  const configured = source.RUNBUILD_AGENT_SANDBOX?.trim().toLowerCase()
  if (configured && AGENT_SANDBOX_PROFILES.has(configured)) return configured
  // workspace seatbelt on macOS blocks reliable native GUI launch (Godot etc.).
  // Re-enable with RUNBUILD_AGENT_SANDBOX=workspace when you need the tighter profile.
  return 'off'
}

/**
 * Finder/Dock-launched Electron apps get a minimal PATH (/usr/bin:/bin:...).
 * Inject common developer prefixes so agent tools can find godot4, npx, node, etc.
 */
export function withDeveloperPath(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = source.HOME?.trim() || os.homedir()
  const prefixes = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.grok', 'bin'),
  ]
  const existing = (source.PATH || '/usr/bin:/bin:/usr/sbin:/sbin')
    .split(path.delimiter)
    .filter(Boolean)
  const seen = new Set(existing)
  const leading: string[] = []
  for (const prefix of prefixes) {
    if (!prefix || seen.has(prefix)) continue
    if (!existsSync(prefix)) continue
    leading.push(prefix)
    seen.add(prefix)
  }
  return {
    ...source,
    PATH: [...leading, ...existing].join(path.delimiter),
  }
}

export type RuntimeModelAvailability = {
  id: string
  available: boolean
  reason?: 'login-required' | 'credential-missing'
}

export type AgentRuntime = {
  connection: { target: string; secret: string } | null
  modelAvailability: RuntimeModelAvailability[]
  error?: string
  stop: () => Promise<void>
}

type ProcessLeaseStore = Pick<ReturnType<typeof createProcessLeaseStore>, 'ready' | 'claim' | 'release' | 'stop'>

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const reservePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer()
  server.unref()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = address && typeof address === 'object' ? address.port : 0
    server.close((error) => error ? reject(error) : resolve(port))
  })
})

const canConnect = (port: number) => new Promise<boolean>((resolve) => {
  const socket = net.createConnection({ host: '127.0.0.1', port })
  const finish = (connected: boolean) => {
    socket.removeAllListeners()
    socket.destroy()
    resolve(connected)
  }
  socket.setTimeout(250)
  socket.once('connect', () => finish(true))
  socket.once('timeout', () => finish(false))
  socket.once('error', () => finish(false))
})

const providerCredentialKeys = ['XAI_API_KEY', 'MIMO_API_KEY', 'DEEPSEEK_API_KEY'] as const
type ProviderCredentialKey = typeof providerCredentialKeys[number]

const hasCredential = (value: string | undefined) => Boolean(value?.trim())

function environmentWithExplicitProviderCredentials(source: NodeJS.ProcessEnv) {
  const environment: NodeJS.ProcessEnv = { ...source }
  const envFile = source.UNI_ENV_FILE
  if (!envFile || !existsSync(envFile)) return environment
  let contents = ''
  try { contents = readFileSync(envFile, 'utf8') } catch { return environment }
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match || !providerCredentialKeys.includes(match[1] as ProviderCredentialKey)) continue
    const key = match[1] as ProviderCredentialKey
    if (hasCredential(environment[key])) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (hasCredential(value)) environment[key] = value
  }
  return environment
}

export function resolveAgentRuntimeEnvironment(
  grokHome: string,
  source: NodeJS.ProcessEnv = process.env,
  authFallbackPaths: string[] = [],
) {
  const environment = withDeveloperPath(environmentWithExplicitProviderCredentials(source))
  if (
    hasCredential(environment.GROK_AUTH_PATH)
    || hasCredential(environment.GROK_AUTH)
    || hasCredential(environment.XAI_API_KEY)
  ) return environment
  const appAuthPath = path.join(grokHome, 'auth.json')
  if (existsSync(appAuthPath)) {
    environment.GROK_AUTH_PATH = appAuthPath
    return environment
  }
  const fallbackAuthPath = authFallbackPaths.find((candidate) => existsSync(candidate))
  if (fallbackAuthPath) environment.GROK_AUTH_PATH = fallbackAuthPath
  return environment
}

function availabilityFromEnvironment(
  grokHome: string,
  credentials: NodeJS.ProcessEnv,
): RuntimeModelAvailability[] {
  const configuredAuthPath = credentials.GROK_AUTH_PATH?.trim()
  const authPath = configuredAuthPath || path.join(grokHome, 'auth.json')
  const hasStoredCredential = (() => {
    try {
      const value = JSON.parse(readFileSync(authPath, 'utf8')) as unknown
      return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).some((entry) => (
        entry && typeof entry === 'object' && typeof (entry as { key?: unknown }).key === 'string' && Boolean((entry as { key: string }).key.trim())
      )))
    } catch {
      return false
    }
  })()
  const grokAvailable = hasCredential(credentials.XAI_API_KEY)
    || hasCredential(credentials.GROK_AUTH)
    || hasStoredCredential
  const mimoAvailable = hasCredential(credentials.MIMO_API_KEY)
  const deepseekAvailable = hasCredential(credentials.DEEPSEEK_API_KEY)
  return [
    grokAvailable
      ? { id: 'grok-4.5', available: true }
      : { id: 'grok-4.5', available: false, reason: 'login-required' },
    mimoAvailable
      ? { id: 'mimo', available: true }
      : { id: 'mimo', available: false, reason: 'credential-missing' },
    deepseekAvailable
      ? { id: 'deepseek-v4-pro', available: true }
      : { id: 'deepseek-v4-pro', available: false, reason: 'credential-missing' },
  ]
}

export function inspectRuntimeModelAvailability(
  grokHome: string,
  env: NodeJS.ProcessEnv = process.env,
  authFallbackPaths: string[] = [],
): RuntimeModelAvailability[] {
  return availabilityFromEnvironment(grokHome, resolveAgentRuntimeEnvironment(grokHome, env, authFallbackPaths))
}

const startupCredentialError = (
  modelProfile: string,
  availability: RuntimeModelAvailability[],
) => {
  if (availability.find((entry) => entry.id === modelProfile)?.available !== false) return null
  if (modelProfile === 'grok-4.5') return 'xAI 登录状态或 XAI_API_KEY 未配置，桌面客户端没有启动 Agent'
  if (modelProfile === 'mimo') return 'MIMO_API_KEY 未配置，桌面客户端没有启动 Agent'
  if (modelProfile === 'deepseek-v4-pro') return 'DEEPSEEK_API_KEY 未配置，桌面客户端没有启动 Agent'
  return null
}

export function configWithDefaultModel(source: string, modelProfile: string) {
  const lines = source.split(/\r?\n/)
  const sectionStart = lines.findIndex((line) => /^\s*\[models\]\s*$/.test(line))
  const modelLine = `default = ${JSON.stringify(modelProfile)}`
  if (sectionStart < 0) {
    const current = source.trimEnd()
    return `${current}${current ? '\n\n' : ''}[models]\n${modelLine}\n`
  }
  let sectionEnd = lines.findIndex((line, index) => index > sectionStart && /^\s*\[/.test(line))
  if (sectionEnd < 0) sectionEnd = lines.length
  const defaultIndex = lines.findIndex((line, index) => index > sectionStart && index < sectionEnd && /^\s*default\s*=/.test(line))
  if (defaultIndex >= 0) lines[defaultIndex] = modelLine
  else lines.splice(sectionStart + 1, 0, modelLine)
  return `${lines.join('\n').trimEnd()}\n`
}

export function configWithSafeAccessDefaults(source: string) {
  const setUiValue = (current: string, key: string, value: string) => {
    const lines = current.split(/\r?\n/)
    const sectionStart = lines.findIndex((line) => /^\s*\[ui\]\s*$/.test(line))
    if (sectionStart < 0) {
      const existing = current.trimEnd()
      return `${existing}${existing ? '\n\n' : ''}[ui]\n${key} = ${value}\n`
    }
    let sectionEnd = lines.findIndex((line, index) => index > sectionStart && /^\s*\[/.test(line))
    if (sectionEnd < 0) sectionEnd = lines.length
    const keyPattern = new RegExp(`^\\s*${key}\\s*=`)
    const keyIndex = lines.findIndex((line, index) => index > sectionStart && index < sectionEnd && keyPattern.test(line))
    if (keyIndex >= 0) lines[keyIndex] = `${key} = ${value}`
    else lines.splice(sectionStart + 1, 0, `${key} = ${value}`)
    return `${lines.join('\n').trimEnd()}\n`
  }
  // Parity with Grok CLI: tools auto-approved; yolo stays off.
  return setUiValue(setUiValue(source, 'yolo', 'false'), 'permission_mode', '"always-approve"')
}

export function ensureRuntimeConfig(grokHome: string, modelProfile: string) {
  mkdirSync(grokHome, { recursive: true })
  const configPath = path.join(grokHome, 'config.toml')
  if (existsSync(configPath)) {
    const source = readFileSync(configPath, 'utf8')
    const next = configWithSafeAccessDefaults(configWithDefaultModel(source, modelProfile))
    if (next !== source) writeFileSync(configPath, next, { encoding: 'utf8', mode: 0o600 })
    chmodSync(configPath, 0o600)
    return
  }
  writeFileSync(configPath, [
    '[models]',
    `default = ${JSON.stringify(modelProfile)}`,
    'default_reasoning_effort = "medium"',
    '',
    '[model.mimo]',
    'model = "mimo-v2.5-pro"',
    'base_url = "https://api.xiaomimimo.com/v1"',
    'name = "MiMo"',
    'env_key = "MIMO_API_KEY"',
    'api_backend = "chat_completions"',
    '',
    '[model.deepseek-v4-pro]',
    'model = "deepseek-v4-pro"',
    'base_url = "https://api.deepseek.com"',
    'name = "DeepSeek V4 Pro"',
    'env_key = "DEEPSEEK_API_KEY"',
    'api_backend = "chat_completions"',
    '',
    '[ui]',
    'permission_mode = "always-approve"',
    'yolo = false',
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 })
}

export async function startAgentRuntime(input: {
  binaryPath: string
  workspace: string
  grokHome: string
  modelProfile: string
  environment?: NodeJS.ProcessEnv
  authFallbackPaths?: string[]
  leaseStore?: ProcessLeaseStore
  signal?: AbortSignal
  onStateChange?: (runtime: AgentRuntime) => void
}): Promise<AgentRuntime> {
  let child: ChildProcess | null = null
  let lease: ProcessLease | null = null
  let stopRequested = false
  const leaseStore = input.leaseStore ?? createProcessLeaseStore({
    leaseRoot: path.join(input.grokHome, 'leases'),
    ownerLabel: 'RunBuild desktop Agent runtime',
  })
  const childEnvironment = resolveAgentRuntimeEnvironment(
    input.grokHome,
    input.environment ?? process.env,
    input.authFallbackPaths,
  )
  const modelAvailability = availabilityFromEnvironment(input.grokHome, childEnvironment)
  const childHasExited = () => Boolean(child && (child.exitCode !== null || child.signalCode !== null))
  const waitForExit = async (milliseconds: number) => {
    const deadline = Date.now() + milliseconds
    while (!childHasExited() && Date.now() < deadline) await delay(50)
  }
  const runtime: AgentRuntime = {
    connection: null,
    modelAvailability,
    stop: async () => {
      stopRequested = true
      runtime.connection = null
      const ownedLease = lease
      lease = null
      if (ownedLease) {
        const cleanup = await leaseStore.stop(ownedLease)
        if (cleanup.status === 'failed') throw new Error(cleanup.summary)
        await waitForExit(3_000)
        return
      }
      if (!child || childHasExited()) return
      const childPid = child.pid
      if (!childPid) return
      const processGroup = process.platform !== 'win32'
      const target = processGroup ? -childPid : childPid
      try { process.kill(target, 'SIGTERM') } catch { return }
      await waitForExit(2_000)
      if (!childHasExited()) {
        try { process.kill(target, 'SIGKILL') } catch { return }
        await waitForExit(1_000)
      }
    },
  }
  if (input.signal?.aborted) return { ...runtime, error: 'Agent 启动已取消' }
  if (!existsSync(input.binaryPath)) return { ...runtime, error: `找不到 Agent 程序：${input.binaryPath}` }
  const credentialError = startupCredentialError(input.modelProfile, modelAvailability)
  if (credentialError) return { ...runtime, error: credentialError }

  await leaseStore.ready
  if (input.signal?.aborted) return { ...runtime, error: 'Agent 启动已取消' }

  const port = await reservePort()
  if (input.signal?.aborted) return { ...runtime, error: 'Agent 启动已取消' }
  const secret = randomBytes(24).toString('hex')
  const logPath = path.join(input.grokHome, 'desktop-agent.log')
  mkdirSync(input.grokHome, { recursive: true })
  const logFd = openSync(logPath, 'a', 0o600)
  Object.assign(childEnvironment, { GROK_AGENT_SECRET: secret, GROK_HOME: input.grokHome })
  for (const key of [
    'PERSONAL_AGENT_BRIDGE_ENABLED',
    'PERSONAL_AGENT_BRIDGE_SECRET',
    'PERSONAL_AGENT_BRIDGE_TARGET',
    'PERSONAL_AGENT_PROJECTS_ROOT',
    'PERSONAL_AGENT_PROJECT_REGISTRY',
  ]) delete childEnvironment[key]
  const processGroup = process.platform !== 'win32'
  const sandboxProfile = resolveAgentSandboxProfile(childEnvironment)
  const alwaysApproveRaw = childEnvironment.RUNBUILD_ALWAYS_APPROVE?.trim().toLowerCase()
  const alwaysApprove = !(alwaysApproveRaw === '0' || alwaysApproveRaw === 'false' || alwaysApproveRaw === 'no' || alwaysApproveRaw === 'off')
  const commandArgs = [
    '--sandbox', sandboxProfile,
    ...(alwaysApprove ? ['--always-approve'] as const : []),
    '--permission-mode', 'default',
    '--model', input.modelProfile,
    'agent', 'serve',
    '--bind', `127.0.0.1:${port}`,
  ]
  const startedAt = new Date().toISOString()
  try {
    child = spawn(input.binaryPath, commandArgs, {
      cwd: input.workspace,
      env: childEnvironment,
      stdio: ['ignore', logFd, logFd],
      detached: processGroup,
    })
  } finally {
    closeSync(logFd)
  }

  const abortStartup = () => { void runtime.stop() }
  input.signal?.addEventListener('abort', abortStartup, { once: true })

  let spawnError = ''
  let runtimeReady = false
  const reportRuntimeExit = (reason: string) => {
    if (!runtimeReady || stopRequested || input.signal?.aborted) return
    runtime.connection = null
    runtime.error = `${reason}；日志：${logPath}`
    input.onStateChange?.(runtime)
  }
  child.once('error', (error) => {
    spawnError = error.message
    reportRuntimeExit(`Agent 运行中断 (${error.message})`)
  })
  child.once('exit', (code, signal) => {
    const ownedLease = lease
    lease = null
    if (ownedLease) void leaseStore.release(ownedLease)
    reportRuntimeExit(`Agent 已退出 (${signal ?? code ?? 'unknown'})`)
  })
  if (!child.pid) {
    await delay(0)
    input.signal?.removeEventListener('abort', abortStartup)
    return { ...runtime, error: `${spawnError || 'Agent 启动后没有返回进程标识'}；日志：${logPath}` }
  }
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (input.signal?.aborted) {
      await runtime.stop()
      input.signal.removeEventListener('abort', abortStartup)
      return { ...runtime, error: 'Agent 启动已取消' }
    }
    if (spawnError || childHasExited()) {
      const reason = spawnError || `Agent 已退出 (${child.signalCode ?? child.exitCode ?? 'unknown'})`
      await runtime.stop()
      input.signal?.removeEventListener('abort', abortStartup)
      return { ...runtime, error: `${reason}；日志：${logPath}` }
    }
    if (await canConnect(port)) {
      if (childHasExited()) {
        input.signal?.removeEventListener('abort', abortStartup)
        return { ...runtime, error: `Agent 已退出 (${child.signalCode ?? child.exitCode ?? 'unknown'})；日志：${logPath}` }
      }
      // A script/shebang launcher can briefly expose an interpreter command
      // before the serving process has exec'd. Claim only after the endpoint
      // is reachable so the persisted command identity is the real Agent.
      const childPid = child.pid
      if (!childPid) {
        input.signal?.removeEventListener('abort', abortStartup)
        return { ...runtime, error: `Agent 启动后没有返回进程标识；日志：${logPath}` }
      }
      try {
        lease = await leaseStore.claim({
          kind: 'desktop-agent',
          subjectId: 'root-agent',
          pid: childPid,
          processGroup,
          runtime: {
            port,
            binaryPath: input.binaryPath,
            workspace: input.workspace,
            command: { executable: input.binaryPath, args: commandArgs },
            startedAt,
            state: 'running',
          },
        })
      } catch (error) {
        await runtime.stop()
        input.signal?.removeEventListener('abort', abortStartup)
        return { ...runtime, error: `无法建立 Agent 进程租约：${error instanceof Error ? error.message : '未知错误'}；日志：${logPath}` }
      }
      if (childHasExited()) {
        const ownedLease = lease
        lease = null
        if (ownedLease) await leaseStore.release(ownedLease)
        input.signal?.removeEventListener('abort', abortStartup)
        return { ...runtime, error: `Agent 已退出 (${child.signalCode ?? child.exitCode ?? 'unknown'})；日志：${logPath}` }
      }
      runtime.connection = { target: `ws://127.0.0.1:${port}`, secret }
      runtime.error = undefined
      runtimeReady = true
      input.signal?.removeEventListener('abort', abortStartup)
      return runtime
    }
    await delay(75)
  }
  await runtime.stop()
  input.signal?.removeEventListener('abort', abortStartup)
  return { ...runtime, error: `Agent 启动超时；日志：${logPath}` }
}
