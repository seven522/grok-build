import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

export type ProcessIdentity = {
  pid: number
  startedAt: string
  commandHash: string
}

export type ProcessInspection =
  | { state: 'present'; identity: ProcessIdentity }
  | { state: 'missing' }
  | { state: 'unavailable'; reason: string }

export type ProcessInspector = (pid: number) => Promise<ProcessInspection>

export type ProcessLeaseRuntimeState = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'

/**
 * Metadata that makes an active lease inspectable without storing secrets or
 * raw command-line arguments. `kind` + `subjectId` remain the canonical
 * runner/subject identity; this object describes the exact runtime behind it.
 */
export type ProcessLeaseRuntime = {
  port: number
  binaryPath: string
  commandHash: string
  workspaceRealpath: string
  startedAt: string
  heartbeatAt: string
  state: ProcessLeaseRuntimeState
}

export type ProcessLeaseRuntimeInput = {
  port: number
  binaryPath: string
  workspace: string
  command: {
    executable: string
    args: readonly string[]
  }
  startedAt?: string
  state?: ProcessLeaseRuntimeState
}

export type ProcessLeaseRecord = {
  version: 1
  leaseId: string
  kind: string
  subjectId: string
  createdAt: string
  runtime: ProcessLeaseRuntime
  owner: {
    instanceId: string
    label: string
    pid: number
    identity: ProcessIdentity
  }
  process: {
    pid: number
    identity: ProcessIdentity
    processGroup: boolean
  }
}

export type ProcessLease = ProcessLeaseRecord

export type LeaseCleanupResult = {
  status: 'passed' | 'failed' | 'not_required'
  summary: string
  resourceIds: string[]
  outcome: 'stopped' | 'already-exited' | 'identity-mismatch' | 'active-owner' | 'unavailable' | 'failed'
}

export type LeaseRecoveryResult = LeaseCleanupResult & {
  leaseId?: string
}

export type LeaseHeartbeatResult = {
  status: 'updated' | 'not_required' | 'failed'
  summary: string
  lease?: ProcessLease
}

export type ProcessLeaseStoreOptions = {
  leaseRoot: string
  ownerLabel?: string
  ownerInstanceId?: string
  inspectProcess?: ProcessInspector
  watchdog?: boolean
  watchdogIntervalMs?: number
  gracefulShutdownMs?: number
  heartbeatIntervalMs?: number
}

const execFileAsync = promisify(execFile)
const leaseFileSuffix = '.lease.json'
const safeLeaseSegment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const processIdentityHash = (command: string) => createHash('sha256').update(command).digest('hex')

export const runtimeCommandHash = (command: { executable: string; args: readonly string[] }) => createHash('sha256')
  .update(JSON.stringify([command.executable, ...command.args]))
  .digest('hex')

export const processIdentityMatches = (left: ProcessIdentity, right: ProcessIdentity) => (
  left.pid === right.pid
  && left.startedAt === right.startedAt
  && left.commandHash === right.commandHash
)

export async function inspectLocalProcess(pid: number): Promise<ProcessInspection> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'missing' }
  if (process.platform === 'win32') return { state: 'unavailable', reason: '当前平台没有安全的进程启动身份检查' }
  try {
    const { stdout } = await execFileAsync('/bin/ps', [
      '-ww', '-p', String(pid), '-o', 'pid=', '-o', 'lstart=', '-o', 'command=',
    ], { encoding: 'utf8', timeout: 1_500, maxBuffer: 32 * 1024 })
    const line = String(stdout).trim()
    const match = line.match(/^(\d+)\s+(.{24})\s+(.+)$/)
    if (!match || Number(match[1]) !== pid) return { state: 'unavailable', reason: '无法解析进程身份' }
    return {
      state: 'present',
      identity: {
        pid,
        startedAt: match[2],
        commandHash: processIdentityHash(match[3]),
      },
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 1 || code === '1' || code === 'ESRCH') return { state: 'missing' }
    return { state: 'unavailable', reason: error instanceof Error ? error.message : '进程身份检查失败' }
  }
}

/**
 * A spawned executable may briefly appear as its shebang/interpreter before
 * `exec` finishes.  Persisting that transient command hash would make an
 * otherwise owned process look foreign at shutdown, so require two matching
 * observations before writing a lease.
 */
const inspectSettledProcess = async (inspectProcess: ProcessInspector, pid: number): Promise<ProcessInspection> => {
  let current = await inspectProcess(pid)
  if (current.state !== 'present') return current
  let stableSince = Date.now()
  const deadline = stableSince + 2_000
  while (Date.now() < deadline) {
    await delay(25)
    const next = await inspectProcess(pid)
    if (next.state !== 'present') return next
    if (processIdentityMatches(current.identity, next.identity)) {
      if (Date.now() - stableSince >= 300) return next
      continue
    }
    current = next
    stableSince = Date.now()
  }
  return current
}

const runtimeStates = new Set<ProcessLeaseRuntimeState>(['starting', 'running', 'stopping', 'stopped', 'failed'])
const stateTransitions: Record<ProcessLeaseRuntimeState, readonly ProcessLeaseRuntimeState[]> = {
  starting: ['starting', 'running', 'stopping', 'failed'],
  running: ['running', 'stopping', 'failed'],
  stopping: ['stopping', 'stopped', 'failed'],
  stopped: ['stopped'],
  failed: ['failed'],
}

const isCanonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value
}

const isSafeCanonicalPath = (value: unknown) => (
  typeof value === 'string'
  && value.length > 0
  && value.length <= 4_096
  && !value.includes('\0')
  && path.isAbsolute(value)
  && path.normalize(value) === value
)

const resolveRuntimePath = (input: string, description: string, type: 'file' | 'directory') => {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new Error(`${description} 不合法`)
  let resolved: string
  let metadata: ReturnType<typeof lstatSync>
  try {
    resolved = realpathSync(path.resolve(input))
    metadata = lstatSync(resolved)
  } catch {
    throw new Error(`${description} 不存在或无法解析为真实路径`)
  }
  if (metadata.isSymbolicLink() || (type === 'file' ? !metadata.isFile() : !metadata.isDirectory())) {
    throw new Error(`${description} 必须是普通${type === 'file' ? '文件' : '目录'}`)
  }
  return resolved
}

const validateCommandInput = (command: ProcessLeaseRuntimeInput['command']) => {
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('Runner 命令不合法')
  if (!Array.isArray(command.args)) throw new Error('Runner 命令不合法')
  const values = [command.executable, ...command.args]
  if (values.some((value) => typeof value !== 'string' || !value || value.includes('\0') || value.length > 4_096)) {
    throw new Error('Runner 命令不合法')
  }
  if (values.reduce((length, value) => length + value.length, 0) > 16_384) throw new Error('Runner 命令过长')
}

const runtimeForClaim = (input: ProcessLeaseRuntimeInput, now: string): ProcessLeaseRuntime => {
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535) throw new Error('Runner 端口不合法')
  validateCommandInput(input.command)
  const startedAt = input.startedAt ?? now
  if (!isCanonicalTimestamp(startedAt)) throw new Error('Runner 启动时间不合法')
  if (Date.parse(startedAt) > Date.parse(now)) throw new Error('Runner 启动时间不能晚于租约创建时间')
  const state = input.state ?? 'starting'
  if (!runtimeStates.has(state)) throw new Error('Runner 状态不合法')
  return {
    port: input.port,
    binaryPath: resolveRuntimePath(input.binaryPath, 'Runner 二进制路径', 'file'),
    commandHash: runtimeCommandHash(input.command),
    workspaceRealpath: resolveRuntimePath(input.workspace, 'Runner 工作区', 'directory'),
    startedAt,
    heartbeatAt: now,
    state,
  }
}

const validateLeaseRecord = (value: unknown): ProcessLeaseRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<ProcessLeaseRecord>
  const process = record.process as Partial<ProcessLeaseRecord['process']> | undefined
  const owner = record.owner as Partial<ProcessLeaseRecord['owner']> | undefined
  const runtime = record.runtime as Partial<ProcessLeaseRuntime> | undefined
  const isIdentity = (identity: unknown): identity is ProcessIdentity => {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return false
    const candidate = identity as Partial<ProcessIdentity>
    return Number.isSafeInteger(candidate.pid)
      && (candidate.pid ?? 0) > 0
      && typeof candidate.startedAt === 'string'
      && Boolean(candidate.startedAt)
      && typeof candidate.commandHash === 'string'
      && /^[a-f0-9]{64}$/.test(candidate.commandHash)
  }
  if (
    record.version !== 1
    || typeof record.leaseId !== 'string'
    || !record.leaseId
    || typeof record.kind !== 'string'
    || !safeLeaseSegment.test(record.kind)
    || typeof record.subjectId !== 'string'
    || !safeLeaseSegment.test(record.subjectId)
    || typeof record.createdAt !== 'string'
    || !isCanonicalTimestamp(record.createdAt)
    || !runtime
    || !Number.isSafeInteger(runtime.port)
    || (runtime.port ?? 0) < 1
    || (runtime.port ?? 0) > 65_535
    || !isSafeCanonicalPath(runtime.binaryPath)
    || typeof runtime.commandHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(runtime.commandHash)
    || !isSafeCanonicalPath(runtime.workspaceRealpath)
    || !isCanonicalTimestamp(runtime.startedAt)
    || !isCanonicalTimestamp(runtime.heartbeatAt)
    || Date.parse(runtime.heartbeatAt) < Date.parse(runtime.startedAt)
    || typeof runtime.state !== 'string'
    || !runtimeStates.has(runtime.state as ProcessLeaseRuntimeState)
    || !owner
    || typeof owner.instanceId !== 'string'
    || !owner.instanceId
    || typeof owner.label !== 'string'
    || !owner.label
    || !Number.isSafeInteger(owner.pid)
    || (owner.pid ?? 0) <= 0
    || !isIdentity(owner.identity)
    || !process
    || !Number.isSafeInteger(process.pid)
    || (process.pid ?? 0) <= 0
    || typeof process.processGroup !== 'boolean'
    || !isIdentity(process.identity)
    || process.pid !== process.identity.pid
    || owner.pid !== owner.identity.pid
  ) return null
  return record as ProcessLeaseRecord
}

const leaseResourceIds = (record: ProcessLeaseRecord) => [
  `lease:${record.leaseId}`,
  `process:${record.process.pid}`,
  `subject:${record.kind}:${record.subjectId}`,
]

const resultFor = (
  record: ProcessLeaseRecord,
  status: LeaseCleanupResult['status'],
  outcome: LeaseCleanupResult['outcome'],
  summary: string,
): LeaseCleanupResult => ({ status, outcome, summary, resourceIds: leaseResourceIds(record) })

const ensureLeaseRoot = (input: string) => {
  mkdirSync(input, { recursive: true, mode: 0o700 })
  const metadata = lstatSync(input)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('Runner 租约目录必须是普通文件夹')
  const resolved = path.resolve(input)
  try { chmodSync(resolved, 0o700) } catch { /* Retain existing permissions when the filesystem cannot chmod. */ }
  return resolved
}

const leaseFileName = (kind: string, subjectId: string) => {
  if (!safeLeaseSegment.test(kind) || !safeLeaseSegment.test(subjectId)) throw new Error('Runner 租约标识不合法')
  return `${kind}--${subjectId}${leaseFileSuffix}`
}

const readLeaseFile = (filePath: string): ProcessLeaseRecord | null => {
  if (!existsSync(filePath)) return null
  try {
    const metadata = lstatSync(filePath)
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 32 * 1024) return null
    return validateLeaseRecord(JSON.parse(readFileSync(filePath, 'utf8')))
  } catch {
    return null
  }
}

const writeNewLeaseFile = (filePath: string, record: ProcessLeaseRecord) => {
  const descriptor = openSync(filePath, 'wx', 0o600)
  try {
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, { encoding: 'utf8' })
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  try { chmodSync(filePath, 0o600) } catch { /* Creation mode is already restrictive. */ }
}

const replaceLeaseFile = (filePath: string, record: ProcessLeaseRecord) => {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, { encoding: 'utf8' })
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporaryPath, filePath)
    try { chmodSync(filePath, 0o600) } catch { /* The replacement was created with restrictive permissions. */ }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temporaryPath)) {
      try { unlinkSync(temporaryPath) } catch { /* The temporary file may have been renamed or removed. */ }
    }
  }
}

const removeLeaseFile = (filePath: string, expectedLeaseId?: string) => {
  const record = readLeaseFile(filePath)
  if (expectedLeaseId && record?.leaseId !== expectedLeaseId) return false
  if (!record && expectedLeaseId && existsSync(filePath)) return false
  try {
    unlinkSync(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    return false
  }
}

const guardianProgram = String.raw`
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const leasePath = process.env.RUNBUILD_LEASE_PATH;
const leaseId = process.env.RUNBUILD_LEASE_ID;
const interval = Math.max(25, Number(process.env.RUNBUILD_LEASE_GUARDIAN_INTERVAL || 750));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const same = (left, right) => left && right && left.pid === right.pid && left.startedAt === right.startedAt && left.commandHash === right.commandHash;
const inspect = (pid) => new Promise((resolve) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return resolve({ state: 'missing' });
  execFile('/bin/ps', ['-ww', '-p', String(pid), '-o', 'pid=', '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', timeout: 1500, maxBuffer: 32768 }, (error, stdout) => {
    if (error) return resolve(error.code === 1 || error.code === 'ESRCH' ? { state: 'missing' } : { state: 'unavailable' });
    const match = String(stdout).trim().match(/^(\d+)\s+(.{24})\s+(.+)$/);
    if (!match || Number(match[1]) !== pid) return resolve({ state: 'unavailable' });
    resolve({ state: 'present', identity: { pid, startedAt: match[2], commandHash: hash(match[3]) } });
  });
});
const read = () => {
  try {
    const record = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
    if (!record || record.version !== 1 || record.leaseId !== leaseId || !record.owner || !record.process) return null;
    return record;
  } catch { return null; }
};
let remembered = read();
const terminateRemembered = async () => {
  if (!remembered) return process.exit(0);
  const current = await inspect(remembered.process.pid);
  if (current.state !== 'present' || !same(current.identity, remembered.process.identity)) return process.exit(0);
  try { process.kill(remembered.process.processGroup ? -remembered.process.pid : remembered.process.pid, 'SIGTERM'); } catch { return process.exit(0); }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const latest = await inspect(remembered.process.pid);
    if (latest.state !== 'present' || !same(latest.identity, remembered.process.identity)) return process.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const latest = await inspect(remembered.process.pid);
  if (latest.state === 'present' && same(latest.identity, remembered.process.identity)) {
    try { process.kill(remembered.process.processGroup ? -remembered.process.pid : remembered.process.pid, 'SIGKILL'); } catch {}
  }
  process.exit(0);
};
const tick = async () => {
  const record = read();
  if (!record) return terminateRemembered();
  remembered = record;
  const child = await inspect(record.process.pid);
  if (child.state === 'missing') return process.exit(0);
  if (child.state !== 'present' || !same(child.identity, record.process.identity)) return process.exit(0);
  const owner = await inspect(record.owner.pid);
  if (owner.state === 'unavailable') return;
  if (owner.state === 'present' && same(owner.identity, record.owner.identity)) return;
  await terminateRemembered();
};
void tick();
setInterval(() => { void tick(); }, interval);
`

const startLeaseGuardian = (record: ProcessLeaseRecord, filePath: string, intervalMs: number) => {
  if (process.platform === 'win32') return
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    RUNBUILD_LEASE_PATH: filePath,
    RUNBUILD_LEASE_ID: record.leaseId,
    RUNBUILD_LEASE_GUARDIAN_INTERVAL: String(Math.max(25, intervalMs)),
  }
  if (process.versions.electron) environment.ELECTRON_RUN_AS_NODE = '1'
  try {
    const guardian = spawn(process.execPath, ['-e', guardianProgram], {
      detached: true,
      stdio: 'ignore',
      env: environment,
    })
    guardian.once('error', () => undefined)
    guardian.unref()
  } catch {
    // Stale-lease recovery remains available even when a platform cannot launch a guardian.
  }
}

export function createProcessLeaseStore(options: ProcessLeaseStoreOptions) {
  const leaseRoot = ensureLeaseRoot(options.leaseRoot)
  const inspectProcess = options.inspectProcess ?? inspectLocalProcess
  const ownerLabel = options.ownerLabel ?? 'RunBuild'
  const ownerInstanceId = options.ownerInstanceId ?? randomUUID()
  const gracefulShutdownMs = options.gracefulShutdownMs ?? 2_000
  const watchdogEnabled = options.watchdog ?? true
  const watchdogIntervalMs = options.watchdogIntervalMs ?? 750
  const heartbeatIntervalMs = Math.max(250, options.heartbeatIntervalMs ?? 5_000)
  const ownerIdentityPromise = inspectProcess(process.pid)

  const filePathFor = (kind: string, subjectId: string) => path.join(leaseRoot, leaseFileName(kind, subjectId))

  type ActiveLease = {
    record: ProcessLeaseRecord
    released: boolean
    queue: Promise<void>
    timer?: ReturnType<typeof setInterval>
  }
  const activeLeases = new Map<string, ActiveLease>()

  const inspectionMatches = async (record: ProcessLeaseRecord) => {
    const inspection = await inspectProcess(record.process.pid)
    if (inspection.state !== 'present') return inspection
    return processIdentityMatches(inspection.identity, record.process.identity)
      ? inspection
      : { state: 'identity-mismatch' as const }
  }

  const release = async (lease: ProcessLease) => {
    const active = activeLeases.get(lease.leaseId)
    if (active) {
      active.released = true
      if (active.timer) clearInterval(active.timer)
      await active.queue
      activeLeases.delete(lease.leaseId)
    }
    return removeLeaseFile(
      filePathFor(lease.kind, lease.subjectId),
      lease.leaseId,
    )
  }

  const heartbeat = async (
    lease: ProcessLease,
    update: { state?: ProcessLeaseRuntimeState } = {},
  ): Promise<LeaseHeartbeatResult> => {
    const active = activeLeases.get(lease.leaseId)
    if (!active || active.released) {
      return { status: 'not_required', summary: 'Runner 租约已释放，不更新心跳' }
    }

    let result: LeaseHeartbeatResult = { status: 'failed', summary: 'Runner 心跳未执行' }
    const operation = active.queue.then(async () => {
      if (active.released) {
        result = { status: 'not_required', summary: 'Runner 租约已释放，不更新心跳' }
        return
      }
      const filePath = filePathFor(lease.kind, lease.subjectId)
      const current = readLeaseFile(filePath)
      if (!current || current.leaseId !== lease.leaseId) {
        result = { status: 'not_required', summary: 'Runner 租约不存在或已由其他实例接管，不更新心跳' }
        return
      }
      if (
        current.owner.instanceId !== lease.owner.instanceId
        || !processIdentityMatches(current.owner.identity, lease.owner.identity)
        || !processIdentityMatches(current.process.identity, lease.process.identity)
      ) {
        result = { status: 'not_required', summary: 'Runner 租约身份已变化，不更新心跳' }
        return
      }
      const processInspection = await inspectionMatches(current)
      if (processInspection.state === 'missing') {
        result = { status: 'not_required', summary: `Runner ${current.process.pid} 已退出，不更新心跳` }
        return
      }
      if (processInspection.state === 'identity-mismatch') {
        result = { status: 'not_required', summary: `Runner ${current.process.pid} 的身份已变化，不更新心跳` }
        return
      }
      if (processInspection.state === 'unavailable') {
        result = { status: 'failed', summary: `无法安全检查 Runner ${current.process.pid} 的进程身份：${processInspection.reason}` }
        return
      }
      const state = update.state ?? current.runtime.state
      if (!stateTransitions[current.runtime.state].includes(state)) {
        result = { status: 'failed', summary: `Runner 状态不能从 ${current.runtime.state} 迁移到 ${state}` }
        return
      }
      const next: ProcessLeaseRecord = {
        ...current,
        runtime: {
          ...current.runtime,
          state,
          heartbeatAt: new Date().toISOString(),
        },
      }
      try {
        replaceLeaseFile(filePath, next)
        active.record = next
        result = { status: 'updated', summary: `Runner ${current.process.pid} 心跳已更新`, lease: next }
      } catch (error) {
        result = { status: 'failed', summary: `无法写入 Runner 心跳：${error instanceof Error ? error.message : '未知错误'}` }
      }
    })
    active.queue = operation.then(() => undefined, () => undefined)
    await operation
    return result
  }

  const activateLease = (record: ProcessLeaseRecord) => {
    const active: ActiveLease = { record, released: false, queue: Promise.resolve() }
    activeLeases.set(record.leaseId, active)
    active.timer = setInterval(() => { void heartbeat(record) }, heartbeatIntervalMs)
    active.timer.unref?.()
  }

  const terminate = async (lease: ProcessLease): Promise<LeaseCleanupResult> => {
    const firstInspection = await inspectionMatches(lease)
    if (firstInspection.state === 'unavailable') return resultFor(lease, 'failed', 'unavailable', `无法安全检查 Runner ${lease.process.pid} 的进程身份：${firstInspection.reason}`)
    if (firstInspection.state === 'missing') return resultFor(lease, 'not_required', 'already-exited', `Runner ${lease.process.pid} 已退出，未发送清理信号`)
    if (firstInspection.state === 'identity-mismatch') return resultFor(lease, 'not_required', 'identity-mismatch', `Runner ${lease.process.pid} 的身份已变化，未发送清理信号`)

    const target = lease.process.processGroup ? -lease.process.pid : lease.process.pid
    try {
      process.kill(target, 'SIGTERM')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return resultFor(lease, 'not_required', 'already-exited', `Runner ${lease.process.pid} 已退出，未发送清理信号`)
      return resultFor(lease, 'failed', 'failed', `无法停止 Runner ${lease.process.pid}：${error instanceof Error ? error.message : '未知错误'}`)
    }

    const deadline = Date.now() + gracefulShutdownMs
    while (Date.now() < deadline) {
      const inspection = await inspectionMatches(lease)
      if (inspection.state === 'missing') return resultFor(lease, 'passed', 'stopped', `Runner ${lease.process.pid} 已正常停止`)
      if (inspection.state === 'identity-mismatch') return resultFor(lease, 'not_required', 'identity-mismatch', `Runner ${lease.process.pid} 的身份已变化，未发送后续清理信号`)
      if (inspection.state === 'unavailable') return resultFor(lease, 'failed', 'unavailable', `Runner ${lease.process.pid} 已收到停止信号，但无法验证退出：${inspection.reason}`)
      await delay(50)
    }

    const lastInspection = await inspectionMatches(lease)
    if (lastInspection.state === 'missing') return resultFor(lease, 'passed', 'stopped', `Runner ${lease.process.pid} 已正常停止`)
    if (lastInspection.state === 'identity-mismatch') return resultFor(lease, 'not_required', 'identity-mismatch', `Runner ${lease.process.pid} 的身份已变化，未发送强制清理信号`)
    if (lastInspection.state === 'unavailable') return resultFor(lease, 'failed', 'unavailable', `Runner ${lease.process.pid} 无法安全验证后续身份：${lastInspection.reason}`)
    try {
      process.kill(target, 'SIGKILL')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return resultFor(lease, 'passed', 'stopped', `Runner ${lease.process.pid} 已停止`)
      return resultFor(lease, 'failed', 'failed', `Runner ${lease.process.pid} 未能强制停止：${error instanceof Error ? error.message : '未知错误'}`)
    }
    const forceDeadline = Date.now() + 1_000
    while (Date.now() < forceDeadline) {
      const inspection = await inspectionMatches(lease)
      if (inspection.state === 'missing') return resultFor(lease, 'passed', 'stopped', `Runner ${lease.process.pid} 已强制停止`)
      if (inspection.state === 'identity-mismatch') return resultFor(lease, 'not_required', 'identity-mismatch', `Runner ${lease.process.pid} 的身份已变化，未发送后续清理信号`)
      if (inspection.state === 'unavailable') return resultFor(lease, 'failed', 'unavailable', `Runner ${lease.process.pid} 已发送强制停止信号，但无法验证退出：${inspection.reason}`)
      await delay(50)
    }
    return resultFor(lease, 'failed', 'failed', `Runner ${lease.process.pid} 在强制停止后仍在运行`)
  }

  const recoverFile = async (filePath: string): Promise<LeaseRecoveryResult> => {
    const record = readLeaseFile(filePath)
    if (!record) {
      const removed = removeLeaseFile(filePath)
      return {
        status: removed ? 'not_required' : 'failed',
        outcome: removed ? 'identity-mismatch' : 'failed',
        summary: removed ? '已移除无效 Runner 租约记录，未向任何进程发送信号' : '无法读取或移除无效 Runner 租约记录',
        resourceIds: [],
      }
    }
    if (path.resolve(filePath) !== filePathFor(record.kind, record.subjectId)) {
      const removed = removeLeaseFile(filePath)
      return {
        ...resultFor(record, removed ? 'not_required' : 'failed', 'identity-mismatch', removed
          ? '已移除路径与 Runner 身份不匹配的租约记录，未向任何进程发送信号'
          : '路径与 Runner 身份不匹配的租约记录无法移除'),
        leaseId: record.leaseId,
      }
    }
    const child = await inspectProcess(record.process.pid)
    if (child.state === 'unavailable') return {
      ...resultFor(record, 'failed', 'unavailable', `无法安全检查 Runner ${record.process.pid} 的进程身份：${child.reason}`),
      leaseId: record.leaseId,
    }
    if (child.state === 'missing' || !processIdentityMatches(child.identity, record.process.identity)) {
      const removed = await release(record)
      return {
        ...resultFor(record, removed ? 'not_required' : 'failed', child.state === 'missing' ? 'already-exited' : 'identity-mismatch', removed
          ? `Runner ${record.process.pid} 已退出或身份不匹配；已移除旧租约，未向任何进程发送信号`
          : `Runner ${record.process.pid} 已退出或身份不匹配，但无法移除旧租约`),
        leaseId: record.leaseId,
      }
    }
    const owner = await inspectProcess(record.owner.pid)
    if (owner.state === 'unavailable') return {
      ...resultFor(record, 'failed', 'unavailable', `无法安全检查租约所有者 ${record.owner.pid}：${owner.reason}`),
      leaseId: record.leaseId,
    }
    if (owner.state === 'present' && processIdentityMatches(owner.identity, record.owner.identity)) return {
      ...resultFor(record, 'not_required', 'active-owner', `Runner ${record.process.pid} 仍由活动所有者 ${record.owner.pid} 持有，未接管或终止`),
      leaseId: record.leaseId,
    }
    const cleanup = await terminate(record)
    if (cleanup.status === 'failed') return { ...cleanup, leaseId: record.leaseId }
    const removed = await release(record)
    return {
      ...cleanup,
      status: removed ? cleanup.status : 'failed',
      summary: removed ? `${cleanup.summary}；已移除失效租约` : `${cleanup.summary}；但无法移除失效租约`,
      leaseId: record.leaseId,
    }
  }

  const recover = async () => {
    let entries: string[]
    try { entries = readdirSync(leaseRoot).filter((entry) => entry.endsWith(leaseFileSuffix)) }
    catch (error) {
      return [{
        status: 'failed' as const,
        outcome: 'unavailable' as const,
        summary: `无法枚举 Runner 租约：${error instanceof Error ? error.message : '未知错误'}`,
        resourceIds: [],
      }]
    }
    return Promise.all(entries.map((entry) => recoverFile(path.join(leaseRoot, entry))))
  }

  const ready = recover()

  const claim = async (input: {
    kind: string
    subjectId: string
    pid: number
    processGroup?: boolean
    runtime: ProcessLeaseRuntimeInput
  }): Promise<ProcessLease> => {
    await ready
    const owner = await ownerIdentityPromise
    if (owner.state !== 'present') throw new Error('无法建立当前桌面进程的安全身份，拒绝启动 Runner')
    const child = await inspectSettledProcess(inspectProcess, input.pid)
    if (child.state !== 'present') throw new Error('无法建立 Runner 的安全进程身份，拒绝接管')
    const createdAt = new Date().toISOString()
    const record: ProcessLeaseRecord = {
      version: 1,
      leaseId: randomUUID(),
      kind: input.kind,
      subjectId: input.subjectId,
      createdAt,
      runtime: runtimeForClaim(input.runtime, createdAt),
      owner: {
        instanceId: ownerInstanceId,
        label: ownerLabel,
        pid: process.pid,
        identity: owner.identity,
      },
      process: {
        pid: input.pid,
        identity: child.identity,
        processGroup: Boolean(input.processGroup),
      },
    }
    const filePath = filePathFor(record.kind, record.subjectId)
    try {
      writeNewLeaseFile(filePath, record)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await recoverFile(filePath)
      try {
        writeNewLeaseFile(filePath, record)
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(`Runner ${record.subjectId} 已由活动实例持有，拒绝重复启动`)
        }
        throw retryError
      }
    }
    if (watchdogEnabled) startLeaseGuardian(record, filePath, watchdogIntervalMs)
    activateLease(record)
    return record
  }

  const stop = async (lease: ProcessLease) => {
    await heartbeat(lease, { state: 'stopping' })
    const cleanup = await terminate(lease)
    if (cleanup.status !== 'failed') await release(lease)
    return cleanup
  }

  return {
    leaseRoot,
    ownerInstanceId,
    ready,
    claim,
    release,
    heartbeat,
    terminate,
    stop,
    recover,
    getLeasePath: filePathFor,
  }
}
