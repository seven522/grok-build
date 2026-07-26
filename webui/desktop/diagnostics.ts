import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { inspectLocalProcess, type ProcessIdentity, type ProcessInspection, type ProcessInspector } from '../runner-ownership.ts'

export type DiagnosticHealth = 'ready' | 'degraded' | 'unavailable' | 'missing' | 'unknown' | 'not-required'
export type DiagnosticStorageKind = 'directory' | 'file'
export type DesktopDiagnosticLogSource = 'desktop-agent'
export type DesktopDiagnosticPermissionId = 'microphone' | 'screen-recording' | 'accessibility' | 'full-disk-access'
export type DesktopDiagnosticPermissionState = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown' | 'not-required'
export type FullDiskAccessState = 'granted' | 'denied' | 'unknown' | 'not-required'

export type ModelAvailability = {
  id: string
  available: boolean
  reason?: 'login-required' | 'credential-missing'
}

export type DiagnosticProvider = {
  id: string
  label: string
  status: 'ready' | 'unavailable'
  reason?: 'login-required' | 'credential-missing'
}

export type DiagnosticConnector = {
  id: string
  label: string
  status: 'ready' | 'degraded' | 'unavailable'
  detail: string
}

export type DiagnosticStorageLocation = {
  id: 'workspace' | 'runtime' | 'desktop-user-data' | 'projects' | 'leases' | 'runner-logs' | 'task-events' | 'task-workspaces' | 'project-registry' | 'desktop-agent-log'
  label: string
  path: string
  kind: DiagnosticStorageKind
  status: 'ready' | 'missing' | 'unavailable'
  sizeBytes?: number
}

export type RootRuntimeSummary = {
  state: string
  connected: boolean
  modelProfile: string
  error?: string
  lease: {
    status: 'active' | 'missing' | 'invalid' | 'unavailable'
    id?: string
    pid?: number
    port?: number
    runtimeState?: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'
    startedAt?: string
    heartbeatAt?: string
  }
  process: {
    status: 'present' | 'missing' | 'identity-mismatch' | 'unavailable' | 'not-recorded'
    pid?: number
  }
}

export type DesktopDiagnosticPermission = {
  id: DesktopDiagnosticPermissionId
  label: string
  state: DesktopDiagnosticPermissionState
  canRequest: boolean
  canOpenSettings: boolean
  detail: string
}

export type DesktopDiagnosticPermissions = {
  platform: NodeJS.Platform
  permissions: DesktopDiagnosticPermission[]
}

export type DesktopDiagnosticsSnapshot = {
  generatedAt: string
  scope: 'local-only'
  providers: DiagnosticProvider[]
  connectors: DiagnosticConnector[]
  runtime: RootRuntimeSummary
  storage: DiagnosticStorageLocation[]
  permissions: DesktopDiagnosticPermissions
  logs: Array<{
    source: DesktopDiagnosticLogSource
    status: 'available' | 'missing' | 'unavailable'
  }>
}

export type DesktopDiagnosticLogTail = {
  source: DesktopDiagnosticLogSource
  status: 'available' | 'missing' | 'unavailable'
  lines: string[]
  truncated: boolean
  redactions: number
}

export type DesktopDiagnosticPermissionRequestResult = {
  permission: DesktopDiagnosticPermissionId
  outcome: 'requested' | 'already-granted' | 'system-settings-required' | 'not-required'
  permissions: DesktopDiagnosticPermissions
}

export type DesktopDiagnosticRestartResult = {
  status: 'restarted' | 'degraded' | 'failed' | 'blocked'
  error?: string
  snapshot: DesktopDiagnosticsSnapshot
}

export type DesktopDiagnosticsInput = {
  workspace: string
  grokHome: string
  userDataPath: string
  modelProfile: string
  runtimeState: string
  runtimeConnected: boolean
  runtimeError?: string
  modelAvailability: readonly ModelAvailability[]
  permissionAccess: DesktopDiagnosticPermissionAccess
  inspectProcess?: ProcessInspector
}

export type DesktopDiagnosticPermissionAccess = {
  platform: NodeJS.Platform
  microphoneState: () => DesktopDiagnosticPermissionState
  screenRecordingState: () => DesktopDiagnosticPermissionState
  accessibilityTrusted: (prompt: boolean) => boolean
  fullDiskAccessState: () => FullDiskAccessState
  requestMicrophone: () => Promise<boolean>
}

type LeaseRuntimeState = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'

type RootLease = {
  leaseId: string
  pid: number
  identity: ProcessIdentity
  port: number
  runtimeState: LeaseRuntimeState
  startedAt: string
  heartbeatAt: string
}

const maxLogBytes = 16 * 1024
const maxLogLines = 80
const maxLeaseBytes = 64 * 1024
const maxReportedMcpStartupFailures = 8
const runtimeStates = new Set<LeaseRuntimeState>(['starting', 'running', 'stopping', 'stopped', 'failed'])
const diagnosticLogSources = new Set<DesktopDiagnosticLogSource>(['desktop-agent'])
const diagnosticPermissionIds = new Set<DesktopDiagnosticPermissionId>([
  'microphone',
  'screen-recording',
  'accessibility',
  'full-disk-access',
])

const providerLabels: Record<string, string> = {
  'grok-4.5': 'Grok 4.5',
  mimo: 'MiMo',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isCanonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value
}
const isSafePositiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const isSafeLeaseId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{8,128}$/i.test(value)
const isSafeHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
const isSafeProcessStartedAt = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('\0')

export const isDesktopDiagnosticLogSource = (value: unknown): value is DesktopDiagnosticLogSource => (
  typeof value === 'string' && diagnosticLogSources.has(value as DesktopDiagnosticLogSource)
)

export const isDesktopDiagnosticPermissionId = (value: unknown): value is DesktopDiagnosticPermissionId => (
  typeof value === 'string' && diagnosticPermissionIds.has(value as DesktopDiagnosticPermissionId)
)

export function probeFullDiskAccess({
  platform,
  homeDirectory,
  openFile = openSync,
  closeFile = closeSync,
}: {
  platform: NodeJS.Platform
  homeDirectory: string
  openFile?: (candidate: string, flags: string) => number
  closeFile?: (descriptor: number) => void
}): FullDiskAccessState {
  if (platform !== 'darwin') return 'not-required'
  const protectedDatabase = path.join(homeDirectory, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db')
  try {
    const descriptor = openFile(protectedDatabase, 'r')
    closeFile(descriptor)
    return 'granted'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return code === 'EACCES' || code === 'EPERM' ? 'denied' : 'unknown'
  }
}

/**
 * Removes credential-like values before a diagnostic crosses the Electron IPC
 * boundary. The output is deliberately useful for debugging but never a place
 * to recover an API key, bridge secret, bearer token, or cookie.
 */
export function redactDiagnosticText(input: string) {
  let redactions = 0
  let text = input
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
  const redact = (pattern: RegExp, replacement: string | ((match: string, ...groups: string[]) => string)) => {
    text = text.replace(pattern, (...args: string[]) => {
      redactions += 1
      return typeof replacement === 'function' ? replacement(args[0], ...args.slice(1, -2)) : replacement
    })
  }
  const credentialLabel = '(?:xai(?:[_-]?api)?[_-]?key|mimo[_-]?api[_-]?key|deepseek[_-]?api[_-]?key|grok(?:[_-]?(?:agent[_-]?secret|auth))?|authorization|api[_-]?key|token|password|cookie|server[_-]?key)'
  const credentialValue = '(?:Bearer\\s+)?(?:"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|[^\\s,;]+)'
  redact(new RegExp(`((?:["']?${credentialLabel}["']?)\\s*[:=]\\s*)${credentialValue}`, 'gi'), (_match, prefix) => `${prefix}[REDACTED]`)
  redact(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [REDACTED]')
  redact(/\b(?:sk-|xai-|gsk_)?[A-Za-z0-9][A-Za-z0-9._~+/=-]{31,}\b/g, '[REDACTED]')
  return { text, redactions }
}

export function sanitizeDiagnosticMessage(input: string | undefined, limit = 500) {
  if (!input) return undefined
  return redactDiagnosticText(input).text.replace(/\s+/g, ' ').trim().slice(0, limit) || undefined
}

function expectedStorageEntry(id: DiagnosticStorageLocation['id'], label: string, entryPath: string, kind: DiagnosticStorageKind): DiagnosticStorageLocation {
  const normalizedPath = path.resolve(entryPath)
  try {
    const metadata = lstatSync(normalizedPath)
    if (metadata.isSymbolicLink() || (kind === 'directory' ? !metadata.isDirectory() : !metadata.isFile())) {
      return { id, label, path: normalizedPath, kind, status: 'unavailable' }
    }
    return {
      id,
      label,
      path: normalizedPath,
      kind,
      status: 'ready',
      ...(kind === 'file' ? { sizeBytes: metadata.size } : {}),
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { id, label, path: normalizedPath, kind, status: code === 'ENOENT' ? 'missing' : 'unavailable' }
  }
}

export function collectStorageHealth(input: Pick<DesktopDiagnosticsInput, 'workspace' | 'grokHome' | 'userDataPath'>): DiagnosticStorageLocation[] {
  const runtime = path.resolve(input.grokHome)
  return [
    expectedStorageEntry('workspace', '默认工作区', input.workspace, 'directory'),
    expectedStorageEntry('runtime', 'RunBuild 运行时目录', runtime, 'directory'),
    expectedStorageEntry('desktop-user-data', '桌面应用数据目录', input.userDataPath, 'directory'),
    expectedStorageEntry('projects', '项目注册目录', path.join(runtime, 'projects'), 'directory'),
    expectedStorageEntry('leases', 'Agent / Runner 租约目录', path.join(runtime, 'leases'), 'directory'),
    expectedStorageEntry('runner-logs', '项目 Runner 日志目录', path.join(runtime, 'runners'), 'directory'),
    expectedStorageEntry('task-events', '任务事件账本目录', path.join(runtime, 'task-events'), 'directory'),
    expectedStorageEntry('task-workspaces', '任务草稿与附件目录', path.join(runtime, 'task-workspaces'), 'directory'),
    expectedStorageEntry('project-registry', '项目注册表', path.join(runtime, 'webui', 'projects.json'), 'file'),
    expectedStorageEntry('desktop-agent-log', '桌面 Agent 日志', path.join(runtime, 'desktop-agent.log'), 'file'),
  ]
}

export function collectProviderHealth(modelAvailability: readonly ModelAvailability[]): DiagnosticProvider[] {
  return modelAvailability.map((model) => ({
    id: model.id,
    label: providerLabels[model.id] ?? model.id,
    status: model.available ? 'ready' : 'unavailable',
    ...(model.available || !model.reason ? {} : { reason: model.reason }),
  }))
}

function storageStatus(storage: readonly DiagnosticStorageLocation[], id: DiagnosticStorageLocation['id']) {
  return storage.find((entry) => entry.id === id)?.status ?? 'unavailable'
}

function connectorStatus(storage: readonly DiagnosticStorageLocation[], ids: DiagnosticStorageLocation['id'][]) {
  const states = ids.map((id) => storageStatus(storage, id))
  if (states.includes('unavailable')) return 'unavailable' as const
  return states.every((state) => state === 'ready') ? 'ready' as const : 'degraded' as const
}

export function collectConnectorHealth(input: {
  runtimeConnected: boolean
  runtimeState: string
  storage: readonly DiagnosticStorageLocation[]
  mcpStartupFailures?: readonly string[]
}): DiagnosticConnector[] {
  const runtimeStatus = input.runtimeConnected ? 'ready' : input.runtimeState === 'failed' ? 'unavailable' : 'degraded'
  const runnerStatus = connectorStatus(input.storage, ['leases', 'runner-logs'])
  const ledgerStatus = connectorStatus(input.storage, ['task-events'])
  const connectors: DiagnosticConnector[] = [
    {
      id: 'desktop-agent',
      label: '本地桌面 Agent',
      status: runtimeStatus,
      detail: input.runtimeConnected ? '本地 ACP 连接已建立' : '本地 ACP 连接尚未建立',
    },
    {
      id: 'project-runners',
      label: '本地项目 Runner',
      status: runnerStatus,
      detail: runnerStatus === 'ready' ? '本地租约与日志存储可用' : '本地 Runner 存储尚未就绪或不可用',
    },
    {
      id: 'task-event-ledger',
      label: '本地任务事件账本',
      status: ledgerStatus,
      detail: ledgerStatus === 'ready' ? '本地事件账本存储可用' : '本地事件账本存储尚未就绪或不可用',
    },
  ]
  for (const serverName of input.mcpStartupFailures ?? []) {
    connectors.push({
      id: `mcp-${serverName}`,
      label: `MCP：${serverName}`,
      status: 'degraded',
      detail: '最近的桌面 Agent 日志记录到启动失败；请查看脱敏日志确认本机环境或连接器配置。',
    })
  }
  return connectors
}

function readRootLease(leasePath: string): { status: 'missing' | 'invalid' | 'unavailable'; lease?: never } | { status: 'ready'; lease: RootLease } {
  let metadata: ReturnType<typeof lstatSync>
  try {
    metadata = lstatSync(leasePath)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'missing' } : { status: 'unavailable' }
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maxLeaseBytes) return { status: 'invalid' }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(leasePath, 'utf8'))
  } catch {
    return { status: 'invalid' }
  }
  if (!isRecord(parsed) || parsed.version !== 1 || parsed.kind !== 'desktop-agent' || parsed.subjectId !== 'root-agent' || !isSafeLeaseId(parsed.leaseId)) {
    return { status: 'invalid' }
  }
  const runtime = parsed.runtime
  const process = parsed.process
  if (!isRecord(runtime) || !isRecord(process) || !isSafePositiveInteger(process.pid) || !isRecord(process.identity)) return { status: 'invalid' }
  const identity = process.identity
  if (
    identity.pid !== process.pid
    || !isSafeProcessStartedAt(identity.startedAt)
    || !isSafeHash(identity.commandHash)
    || !isSafePositiveInteger(runtime.port)
    || runtime.port > 65_535
    || typeof runtime.state !== 'string'
    || !runtimeStates.has(runtime.state as LeaseRuntimeState)
    || !isCanonicalTimestamp(runtime.startedAt)
    || !isCanonicalTimestamp(runtime.heartbeatAt)
  ) return { status: 'invalid' }
  return {
    status: 'ready',
    lease: {
      leaseId: parsed.leaseId,
      pid: process.pid,
      identity: {
        pid: process.pid,
        startedAt: identity.startedAt,
        commandHash: identity.commandHash,
      },
      port: runtime.port,
      runtimeState: runtime.state as LeaseRuntimeState,
      startedAt: runtime.startedAt,
      heartbeatAt: runtime.heartbeatAt,
    },
  }
}

const identityMatches = (left: ProcessIdentity, right: ProcessIdentity) => (
  left.pid === right.pid && left.startedAt === right.startedAt && left.commandHash === right.commandHash
)

export async function collectRootRuntimeSummary(input: Pick<DesktopDiagnosticsInput, 'grokHome' | 'modelProfile' | 'runtimeState' | 'runtimeConnected' | 'runtimeError' | 'inspectProcess'>): Promise<RootRuntimeSummary> {
  const base = {
    state: input.runtimeState,
    connected: input.runtimeConnected,
    modelProfile: input.modelProfile,
    ...(sanitizeDiagnosticMessage(input.runtimeError) ? { error: sanitizeDiagnosticMessage(input.runtimeError) } : {}),
  }
  const leasePath = path.join(path.resolve(input.grokHome), 'leases', 'desktop-agent--root-agent.lease.json')
  const result = readRootLease(leasePath)
  if (result.status !== 'ready') {
    return {
      ...base,
      lease: { status: result.status },
      process: { status: 'not-recorded' },
    }
  }
  const lease = result.lease
  let inspection: ProcessInspection
  try {
    inspection = await (input.inspectProcess ?? inspectLocalProcess)(lease.pid)
  } catch {
    inspection = { state: 'unavailable', reason: '进程身份检查失败' }
  }
  const leaseSummary = {
    status: inspection.state === 'unavailable' ? 'unavailable' as const : 'active' as const,
    id: lease.leaseId,
    pid: lease.pid,
    port: lease.port,
    runtimeState: lease.runtimeState,
    startedAt: lease.startedAt,
    heartbeatAt: lease.heartbeatAt,
  }
  if (inspection.state === 'missing') return { ...base, lease: leaseSummary, process: { status: 'missing', pid: lease.pid } }
  if (inspection.state === 'unavailable') return { ...base, lease: leaseSummary, process: { status: 'unavailable', pid: lease.pid } }
  return {
    ...base,
    lease: leaseSummary,
    process: {
      status: identityMatches(inspection.identity, lease.identity) ? 'present' : 'identity-mismatch',
      pid: lease.pid,
    },
  }
}

export function collectDesktopDiagnosticPermissions(access: DesktopDiagnosticPermissionAccess): DesktopDiagnosticPermissions {
  if (access.platform !== 'darwin') {
    return {
      platform: access.platform,
      permissions: [
        { id: 'microphone', label: '麦克风', state: 'not-required', canRequest: false, canOpenSettings: false, detail: '当前平台不需要 macOS 麦克风授权' },
        { id: 'screen-recording', label: '屏幕录制', state: 'not-required', canRequest: false, canOpenSettings: false, detail: '当前平台不需要 macOS 屏幕录制授权' },
        { id: 'accessibility', label: '辅助功能', state: 'not-required', canRequest: false, canOpenSettings: false, detail: '当前平台不需要 macOS 辅助功能授权' },
        { id: 'full-disk-access', label: '完全磁盘访问', state: 'not-required', canRequest: false, canOpenSettings: false, detail: '当前平台不需要 macOS 完全磁盘访问授权' },
      ],
    }
  }
  const microphone = access.microphoneState()
  const screenRecording = access.screenRecordingState()
  const accessibilityTrusted = access.accessibilityTrusted(false)
  const fullDiskAccess = access.fullDiskAccessState()
  return {
    platform: access.platform,
    permissions: [
      {
        id: 'microphone',
        label: '麦克风',
        state: microphone,
        canRequest: microphone === 'not-determined',
        canOpenSettings: microphone === 'denied' || microphone === 'restricted',
        detail: microphone === 'granted' ? '已授权' : '仅在你明确点击请求时触发系统授权',
      },
      {
        id: 'screen-recording',
        label: '屏幕录制',
        state: screenRecording,
        canRequest: false,
        canOpenSettings: screenRecording !== 'granted',
        detail: screenRecording === 'granted' ? '已授权' : '需要在系统设置中授权；诊断不会自动打开设置',
      },
      {
        id: 'accessibility',
        label: '辅助功能',
        state: accessibilityTrusted ? 'granted' : 'not-determined',
        canRequest: !accessibilityTrusted,
        canOpenSettings: !accessibilityTrusted,
        detail: accessibilityTrusted ? '已授权' : '仅在你明确点击请求时触发系统提示',
      },
      {
        id: 'full-disk-access',
        label: '完全磁盘访问',
        state: fullDiskAccess,
        canRequest: false,
        canOpenSettings: fullDiskAccess !== 'granted',
        detail: fullDiskAccess === 'granted'
          ? '已通过受保护路径访问验证'
          : fullDiskAccess === 'denied'
            ? '当前构建未获得完全磁盘访问；请在系统设置中重新授权'
            : '无法验证当前构建的完全磁盘访问状态',
      },
    ],
  }
}

export async function requestDesktopDiagnosticPermission(
  access: DesktopDiagnosticPermissionAccess,
  permission: DesktopDiagnosticPermissionId,
): Promise<DesktopDiagnosticPermissionRequestResult> {
  const before = collectDesktopDiagnosticPermissions(access)
  const status = before.permissions.find((entry) => entry.id === permission)
  if (!status || access.platform !== 'darwin') return { permission, outcome: 'not-required', permissions: before }
  if (status.state === 'granted') return { permission, outcome: 'already-granted', permissions: before }
  if (permission === 'microphone' && status.state === 'not-determined') {
    await access.requestMicrophone()
    return { permission, outcome: 'requested', permissions: collectDesktopDiagnosticPermissions(access) }
  }
  if (permission === 'accessibility') {
    access.accessibilityTrusted(true)
    const permissions = collectDesktopDiagnosticPermissions(access)
    const after = permissions.permissions.find((entry) => entry.id === permission)
    return { permission, outcome: after?.state === 'granted' ? 'requested' : 'system-settings-required', permissions }
  }
  return { permission, outcome: 'system-settings-required', permissions: before }
}

function safeDesktopAgentLogPath(grokHome: string) {
  const configuredRoot = path.resolve(grokHome)
  let root: string
  try {
    const rootMetadata = lstatSync(configuredRoot)
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) return null
    root = realpathSync(configuredRoot)
  } catch {
    return null
  }
  const candidate = path.resolve(root, 'desktop-agent.log')
  if (path.dirname(candidate) !== root) return null
  return candidate
}

export function readDesktopDiagnosticLogTail(
  grokHome: string,
  source: DesktopDiagnosticLogSource = 'desktop-agent',
  limits: { maxBytes?: number; maxLines?: number } = {},
): DesktopDiagnosticLogTail {
  const byteLimit = Math.min(maxLogBytes, Math.max(1, limits.maxBytes ?? maxLogBytes))
  const lineLimit = Math.min(maxLogLines, Math.max(1, limits.maxLines ?? maxLogLines))
  if (!isDesktopDiagnosticLogSource(source)) return { source: 'desktop-agent', status: 'unavailable', lines: [], truncated: false, redactions: 0 }
  const logPath = safeDesktopAgentLogPath(grokHome)
  if (!logPath) return { source, status: 'unavailable', lines: [], truncated: false, redactions: 0 }
  let metadata: ReturnType<typeof lstatSync>
  try {
    metadata = lstatSync(logPath)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { source, status: 'missing', lines: [], truncated: false, redactions: 0 }
      : { source, status: 'unavailable', lines: [], truncated: false, redactions: 0 }
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) return { source, status: 'unavailable', lines: [], truncated: false, redactions: 0 }
  let fd: number | null = null
  try {
    fd = openSync(logPath, 'r')
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      return { source, status: 'unavailable', lines: [], truncated: false, redactions: 0 }
    }
    const readLength = Math.min(opened.size, byteLimit)
    const buffer = Buffer.alloc(readLength)
    if (readLength > 0) readSync(fd, buffer, 0, readLength, Math.max(0, opened.size - readLength))
    const raw = buffer.toString('utf8')
    const redacted = redactDiagnosticText(raw)
    const rawLines = redacted.text.split('\n')
    if (opened.size > readLength && rawLines.length > 0) rawLines.shift()
    const nonEmptyTail = rawLines.at(-1) === '' ? rawLines.slice(0, -1) : rawLines
    const lines = nonEmptyTail.slice(-lineLimit)
    return {
      source,
      status: 'available',
      lines,
      truncated: opened.size > readLength || nonEmptyTail.length > lineLimit,
      redactions: redacted.redactions,
    }
  } catch {
    return { source, status: 'unavailable', lines: [], truncated: false, redactions: 0 }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * Surfaces only a bounded, safe server name when the local Agent reports an
 * MCP spawn failure. The original error detail remains in the redacted log
 * tail so diagnostic cards cannot accidentally leak commands or credentials.
 */
export function collectRecentMcpStartupFailures(tail: Pick<DesktopDiagnosticLogTail, 'lines'>) {
  const failures = new Set<string>()
  const pattern = /Failed to spawn MCP server ['"]([^'"\r\n]+)['"]:/gi
  for (const line of tail.lines) {
    for (const match of line.matchAll(pattern)) {
      const serverName = match[1]?.trim()
      if (!serverName || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(serverName)) continue
      failures.add(serverName)
      if (failures.size >= maxReportedMcpStartupFailures) return [...failures]
    }
  }
  return [...failures]
}

export async function collectDesktopDiagnostics(input: DesktopDiagnosticsInput): Promise<DesktopDiagnosticsSnapshot> {
  const storage = collectStorageHealth(input)
  const runtime = await collectRootRuntimeSummary(input)
  const agentLog = storage.find((entry) => entry.id === 'desktop-agent-log')
  const agentLogTail = readDesktopDiagnosticLogTail(input.grokHome)
  return {
    generatedAt: new Date().toISOString(),
    scope: 'local-only',
    providers: collectProviderHealth(input.modelAvailability),
    connectors: collectConnectorHealth({
      runtimeConnected: input.runtimeConnected,
      runtimeState: input.runtimeState,
      storage,
      mcpStartupFailures: collectRecentMcpStartupFailures(agentLogTail),
    }),
    runtime,
    storage,
    permissions: collectDesktopDiagnosticPermissions(input.permissionAccess),
    logs: [{
      source: 'desktop-agent',
      status: agentLog?.status === 'ready' ? 'available' : agentLog?.status === 'missing' ? 'missing' : 'unavailable',
    }],
  }
}

/** Coalesces repeated recovery clicks into one stop/start transaction. */
export function createSingleFlight<T>(operation: () => Promise<T>) {
  let active: Promise<T> | null = null
  return () => {
    if (active) return active
    const current = operation()
    active = current
    void current.then(
      () => { if (active === current) active = null },
      () => { if (active === current) active = null },
    )
    return current
  }
}
