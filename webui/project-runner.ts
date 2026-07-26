import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { createProjectRegistry, StoredProject } from './project-registry'
import { createProcessLeaseStore, type ProcessLease, type ProcessLeaseStoreOptions } from './runner-ownership.ts'

export type RunnerStatus = {
  projectId: string
  state: 'stopped' | 'starting' | 'running' | 'error'
  pid?: number
  port?: number
  startedAt?: string
  error?: string
}

type RunnerRecord = RunnerStatus & {
  child: ChildProcess
  secret: string
  lease: ProcessLease
}

type RunnerStart = {
  promise: Promise<RunnerStatus>
  abort: AbortController
}

type CommandFactory = (input: { project: StoredProject; port: number }) => { command: string; args: string[] }

type RunnerOptions = {
  registry: ReturnType<typeof createProjectRegistry>
  binaryPath: string
  modelProfile: string
  grokHome: string
  logsRoot: string
  getEnvironment?: () => NodeJS.ProcessEnv
  commandFactory?: CommandFactory
  startupTimeoutMs?: number
  leaseOptions?: Omit<ProcessLeaseStoreOptions, 'leaseRoot'>
}

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const ensureRunnerHome = (projectRoot: string) => {
  const realRoot = realpathSync(projectRoot)
  const runnerHome = path.join(realRoot, '.grok')
  if (existsSync(runnerHome)) {
    const metadata = lstatSync(runnerHome)
    if (metadata.isSymbolicLink()) throw new Error('.grok 不能是符号链接')
    if (!metadata.isDirectory()) throw new Error('.grok 必须是普通文件夹')
  } else {
    mkdirSync(runnerHome)
  }
  const realRunnerHome = realpathSync(runnerHome)
  const relative = path.relative(realRoot, realRunnerHome)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('.grok 必须位于项目目录内')
  return realRunnerHome
}

const inheritSharedAuthPath = (environment: NodeJS.ProcessEnv, grokHome: string) => {
  if (environment.GROK_AUTH_PATH?.trim() || environment.GROK_AUTH?.trim() || environment.XAI_API_KEY?.trim()) return
  const sharedAuthPath = path.resolve(grokHome, 'auth.json')
  let metadata
  try { metadata = lstatSync(sharedAuthPath) } catch { return }
  if (!metadata.isFile() || metadata.isSymbolicLink()) return
  environment.GROK_AUTH_PATH = sharedAuthPath
}

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

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const tomlSection = (source: string, section: string) => {
  const lines = source.trimEnd().split('\n')
  const sectionPattern = new RegExp(`^\\s*\\[${escapeRegExp(section)}\\]\\s*$`)
  const sectionStart = lines.findIndex((line) => sectionPattern.test(line))
  if (sectionStart < 0) return null
  const nextSection = lines.findIndex((line, index) => index > sectionStart && /^\s*\[/.test(line))
  return lines.slice(sectionStart, nextSection < 0 ? lines.length : nextSection).join('\n').trimEnd()
}

const ensureTomlSectionFrom = (source: string, fallback: string, section: string) => {
  if (tomlSection(source, section)) return source
  const fallbackSection = tomlSection(fallback, section)
  if (!fallbackSection) return source
  const current = source.trimEnd()
  return `${current}${current ? '\n\n' : ''}${fallbackSection}\n`
}

const modelSectionName = (modelProfile: string) => {
  const key = /^[A-Za-z0-9_-]+$/.test(modelProfile) ? modelProfile : JSON.stringify(modelProfile)
  return `model.${key}`
}

const setTomlSectionValue = (
  source: string,
  section: string,
  key: string,
  value: string,
  overwrite = true,
) => {
  const lines = source.trimEnd().split('\n')
  const sectionPattern = new RegExp(`^\\s*\\[${escapeRegExp(section)}\\]\\s*$`)
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`)
  const sectionStart = lines.findIndex((line) => sectionPattern.test(line))
  if (sectionStart < 0) {
    if (lines.length === 1 && lines[0] === '') lines.pop()
    if (lines.length && lines.at(-1) !== '') lines.push('')
    lines.push(`[${section}]`, `${key} = ${value}`)
    return `${lines.join('\n')}\n`
  }

  let sectionEnd = lines.findIndex((line, index) => index > sectionStart && /^\s*\[/.test(line))
  if (sectionEnd < 0) sectionEnd = lines.length
  const keyIndex = lines.findIndex((line, index) => index > sectionStart && index < sectionEnd && keyPattern.test(line))
  if (keyIndex >= 0) {
    if (overwrite) lines[keyIndex] = `${key} = ${value}`
  } else {
    lines.splice(sectionStart + 1, 0, `${key} = ${value}`)
  }
  return `${lines.join('\n')}\n`
}

const configForCodingRunner = (source: string, sharedSource: string, modelProfile: string) => {
  const withDefinition = ensureTomlSectionFrom(source, sharedSource, modelSectionName(modelProfile))
  const withModel = setTomlSectionValue(withDefinition, 'models', 'default', JSON.stringify(modelProfile))
  const withMemory = setTomlSectionValue(withModel, 'memory', 'enabled', 'true', false)
  // Match interactive Grok CLI defaults: auto-approve tools, keep yolo off.
  const withSafeApproval = setTomlSectionValue(withMemory, 'ui', 'yolo', 'false')
  return setTomlSectionValue(withSafeApproval, 'ui', 'permission_mode', '"always-approve"')
}

/** Default off: workspace seatbelt blocks reliable Godot/GUI launch on macOS. Override with RUNBUILD_AGENT_SANDBOX. */
export const resolveProjectRunnerSandbox = (source: NodeJS.ProcessEnv = process.env): string => {
  const configured = source.RUNBUILD_AGENT_SANDBOX?.trim().toLowerCase()
  if (configured && ['off', 'workspace', 'read-only', 'strict', 'devbox'].includes(configured)) return configured
  return 'off'
}

/** Auto-approve tool calls by default (parity with Grok CLI always-approve). Set RUNBUILD_ALWAYS_APPROVE=0 to require prompts. */
export const resolveProjectRunnerAlwaysApprove = (source: NodeJS.ProcessEnv = process.env): boolean => {
  const raw = source.RUNBUILD_ALWAYS_APPROVE?.trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false
  return true
}

export const defaultProjectRunnerCommand = (
  binaryPath: string,
  modelProfile: string,
  port: number,
  source: NodeJS.ProcessEnv = process.env,
) => {
  const args = [
    '--sandbox',
    resolveProjectRunnerSandbox(source),
  ]
  if (resolveProjectRunnerAlwaysApprove(source)) args.push('--always-approve')
  args.push(
    '--permission-mode',
    'default',
    '--model',
    modelProfile,
    'agent',
    'serve',
    '--bind',
    `127.0.0.1:${port}`,
  )
  return { command: binaryPath, args }
}

export function createProjectRunnerManager(options: RunnerOptions) {
  const runners = new Map<string, RunnerRecord>()
  const starts = new Map<string, RunnerStart>()
  const leases = createProcessLeaseStore({
    leaseRoot: path.join(options.logsRoot, 'leases'),
    ownerLabel: 'RunBuild project Runner manager',
    ...options.leaseOptions,
  })
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000
  let stopping = false
  let quiescing = false
  let stopAllPromise: Promise<void> | null = null
  let stopActivePromise: Promise<void> | null = null

  const stoppingError = () => new Error('Runner 管理器正在停止')
  const childHasExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null
  const stopUnleasedChild = async (child: ChildProcess, processGroup: boolean) => {
    if (!child.pid || childHasExited(child)) return
    const target = processGroup ? -child.pid : child.pid
    try { process.kill(target, 'SIGTERM') } catch { return }
    const deadline = Date.now() + 2_000
    while (!childHasExited(child) && Date.now() < deadline) await delay(50)
    if (childHasExited(child)) return
    try { process.kill(target, 'SIGKILL') } catch { /* The child may have exited between checks. */ }
  }

  const publicStatus = (record: RunnerRecord): RunnerStatus => ({
    projectId: record.projectId,
    state: record.state,
    pid: record.pid,
    port: record.port,
    startedAt: record.startedAt,
    error: record.error,
  })

  const status = (projectId: string): RunnerStatus => {
    const record = runners.get(projectId)
    return record ? publicStatus(record) : { projectId, state: 'stopped' }
  }

  const start = async (projectId: string): Promise<RunnerStatus> => {
    if (stopping || quiescing) throw stoppingError()
    const existing = runners.get(projectId)
    if (existing && existing.child.exitCode === null && existing.state === 'running') return publicStatus(existing)
    const pending = starts.get(projectId)
    if (pending) return pending.promise

    const abort = new AbortController()
    const shouldStop = () => stopping || quiescing || abort.signal.aborted
    const throwIfStopping = () => {
      if (shouldStop()) throw stoppingError()
    }

    let operation!: Promise<RunnerStatus>
    operation = (async () => {
      const project = (await options.registry.list()).find((entry) => entry.id === projectId)
      throwIfStopping()
      if (!project) throw new Error('项目不存在')
      const resolvedRoot = realpathSync(path.resolve(project.rootPath))
      const runnerHome = ensureRunnerHome(resolvedRoot)
      const sharedConfig = path.join(options.grokHome, 'config.toml')
      const runnerConfig = path.join(runnerHome, 'config.toml')
      const sharedConfigSource = existsSync(sharedConfig) ? readFileSync(sharedConfig, 'utf8') : ''
      const configSource = existsSync(runnerConfig)
        ? readFileSync(runnerConfig, 'utf8')
        : sharedConfigSource
      writeFileSync(
        runnerConfig,
        configForCodingRunner(configSource, sharedConfigSource, options.modelProfile),
        { encoding: 'utf8', mode: 0o600 },
      )
      chmodSync(runnerConfig, 0o600)
      const port = await reservePort()
      throwIfStopping()
      const secret = randomBytes(24).toString('hex')
      mkdirSync(options.logsRoot, { recursive: true })
      const logPath = path.join(options.logsRoot, `${project.id}.log`)
      const logFd = openSync(logPath, 'a', 0o600)
      const childEnvironment: NodeJS.ProcessEnv = { ...(options.getEnvironment?.() ?? process.env) }
      inheritSharedAuthPath(childEnvironment, options.grokHome)
      for (const key of [
        'PERSONAL_AGENT_BRIDGE_ENABLED',
        'PERSONAL_AGENT_BRIDGE_SECRET',
        'PERSONAL_AGENT_BRIDGE_TARGET',
        'PERSONAL_AGENT_PROJECTS_ROOT',
        'PERSONAL_AGENT_PROJECT_REGISTRY',
        'PERSONAL_AGENT_WORKSPACE',
      ]) delete childEnvironment[key]
      Object.assign(childEnvironment, {
        GROK_AGENT_SECRET: secret,
        GROK_HOME: runnerHome,
        PERSONAL_AGENT_PROJECT_ID: project.id,
        PERSONAL_AGENT_PROJECT_ROOT: resolvedRoot,
        PERSONAL_AGENT_PORT: String(port),
      })
      const command = options.commandFactory?.({ project, port })
        ?? defaultProjectRunnerCommand(options.binaryPath, options.modelProfile, port, childEnvironment)
      const processGroup = process.platform !== 'win32'
      const startedAt = new Date().toISOString()
      const child = spawn(command.command, command.args, {
        cwd: resolvedRoot,
        env: childEnvironment,
        stdio: ['ignore', logFd, logFd],
        detached: processGroup,
      })
      closeSync(logFd)
      let spawnError: Error | null = null
      let lifecycleRecord: RunnerRecord | null = null
      child.once('error', (error) => {
        spawnError = error
        if (!lifecycleRecord) return
        lifecycleRecord.state = 'error'
        lifecycleRecord.error = error.message
        void leases.release(lifecycleRecord.lease)
      })
      if (!child.pid) {
        await delay(0)
        throw spawnError ?? new Error('Runner 启动后没有返回进程标识')
      }
      if (spawnError) throw spawnError
      let lease: ProcessLease
      try {
        lease = await leases.claim({
          kind: 'project-runner',
          subjectId: project.id,
          pid: child.pid,
          processGroup,
          runtime: {
            port,
            binaryPath: command.command,
            workspace: resolvedRoot,
            command: { executable: command.command, args: command.args },
            startedAt,
            state: 'starting',
          },
        })
      } catch (error) {
        await stopUnleasedChild(child, processGroup)
        throw error
      }
      if (spawnError) {
        await leases.stop(lease)
        throw spawnError
      }
      const record: RunnerRecord = {
        projectId,
        state: 'starting',
        pid: child.pid,
        port,
        startedAt,
        child,
        secret,
        lease,
      }
      lifecycleRecord = record
      runners.set(projectId, record)
      let exitHandled = false
      const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (exitHandled) return
        exitHandled = true
        void leases.release(record.lease)
        if (record.state !== 'error' && record.state !== 'stopped') {
          record.state = code === 0 ? 'stopped' : 'error'
          if (code !== 0) record.error = `Runner 已退出 (${signal ?? code ?? 'unknown'})`
        }
      }
      child.once('exit', handleExit)
      if (childHasExited(child)) handleExit(child.exitCode, child.signalCode)

      const deadline = Date.now() + startupTimeoutMs
      while (Date.now() < deadline) {
        if (shouldStop()) {
          await stop(projectId)
          throw stoppingError()
        }
        if (child.exitCode !== null || record.state === 'error') throw new Error(record.error || `Runner 启动失败，退出码 ${child.exitCode}`)
        const connected = await canConnect(port)
        if (shouldStop()) {
          await stop(projectId)
          throw stoppingError()
        }
        if (connected) {
          const heartbeat = await leases.heartbeat(record.lease, { state: 'running' })
          if (heartbeat.status !== 'updated') {
            record.state = 'error'
            record.error = `Runner 已就绪但无法确认运行租约：${heartbeat.summary}`
            const cleanup = await leases.stop(record.lease)
            if (cleanup.status === 'failed') record.error = `${record.error}；${cleanup.summary}`
            runners.delete(projectId)
            throw new Error(record.error)
          }
          record.state = 'running'
          return publicStatus(record)
        }
        await delay(75)
      }
      record.state = 'error'
      record.error = 'Runner 启动超时'
      const cleanup = await leases.stop(record.lease)
      if (cleanup.status === 'failed') record.error = `${record.error}；${cleanup.summary}`
      runners.delete(projectId)
      throw new Error(record.error)
    })().finally(() => {
      if (starts.get(projectId)?.promise === operation) starts.delete(projectId)
    })
    starts.set(projectId, { promise: operation, abort })
    return operation
  }

  const stop = async (projectId: string): Promise<RunnerStatus> => {
    const record = runners.get(projectId)
    if (!record) return { projectId, state: 'stopped' }
    record.state = 'stopped'
    const cleanup = await leases.stop(record.lease)
    if (cleanup.status === 'failed') {
      record.state = 'error'
      record.error = cleanup.summary
      throw new Error(cleanup.summary)
    }
    runners.delete(projectId)
    return { projectId, state: 'stopped' }
  }

  const quiesce = () => {
    if (stopActivePromise) return stopActivePromise
    quiescing = true
    const pendingStarts = [...starts.values()]
    for (const pending of pendingStarts) pending.abort.abort()
    stopActivePromise = (async () => {
      await Promise.allSettled(pendingStarts.map((pending) => pending.promise))
      await Promise.all([...runners.keys()].map(stop))
    })().finally(() => {
      stopActivePromise = null
    })
    return stopActivePromise
  }

  const resume = () => {
    if (!stopping) quiescing = false
  }

  const stopActive = async () => {
    try { await quiesce() }
    finally { resume() }
  }

  const stopAll = () => {
    if (stopAllPromise) return stopAllPromise
    stopping = true
    stopAllPromise = quiesce()
    return stopAllPromise
  }

  const connection = (projectId: string) => {
    const record = runners.get(projectId)
    if (!record || record.state !== 'running' || !record.port) return null
    return { target: `ws://127.0.0.1:${record.port}`, secret: record.secret }
  }

  return {
    start,
    stop,
    stopActive,
    quiesce,
    resume,
    stopAll,
    status,
    connection,
    leaseRecovery: leases.ready,
    list: () => [...runners.values()].map(publicStatus),
  }
}

export function projectRunnerMiddleware(manager: ReturnType<typeof createProjectRunnerManager>) {
  return async (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api/runners' && request.method === 'GET') {
      sendJson(response, 200, { runners: manager.list() })
      return
    }
    const match = url.pathname.match(/^\/api\/runners\/([0-9a-f-]+)$/i)
    if (!match) {
      next()
      return
    }
    try {
      if (request.method === 'POST') sendJson(response, 200, { runner: await manager.start(match[1]) })
      else if (request.method === 'DELETE') sendJson(response, 200, { runner: await manager.stop(match[1]) })
      else next()
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : 'Runner 操作失败' })
    }
  }
}
