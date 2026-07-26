import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

/**
 * A provider registry intentionally stores capability declarations and local
 * selection policy only. Credentials, bearer tokens, endpoint URLs, and raw
 * provider errors remain in their owning runtime/connector rather than being
 * copied into this durable configuration file.
 */
export const PROVIDER_REGISTRY_SCHEMA = 'runbuild.provider-registry.v1' as const
export const GROK_ACP_PROVIDER_ID = 'grok-acp' as const

export const providerCapabilities = [
  'session-create',
  'session-load',
  'session-cancel',
  'events',
  'models',
  'permissions',
  'tools',
  'context',
] as const

export type ProviderCapability = (typeof providerCapabilities)[number]
export type ProviderProtocol = 'acp'
export type ProviderRuntimeBinding = 'grok-acp' | 'unbound'

export type ProviderSessionCapabilities = {
  create: boolean
  load: boolean
  cancel: boolean
  events: boolean
}

export type ProviderCapabilities = {
  sessions: ProviderSessionCapabilities
  models: boolean
  permissions: boolean
  tools: boolean
  context: boolean
}

export type ProviderDefinition = {
  id: string
  label: string
  protocol: ProviderProtocol
  /**
   * `grok-acp` preserves the existing local `/acp` bridge. `unbound` records
   * a future provider's contract without claiming that an executor exists.
   */
  runtimeBinding: ProviderRuntimeBinding
  /** The only routable bridge path in this core is the existing Grok ACP path. */
  route: '/acp' | null
  enabled: boolean
  modelIds: string[]
  capabilities: ProviderCapabilities
}

export type ProviderRegistrySnapshot = {
  schema: typeof PROVIDER_REGISTRY_SCHEMA
  defaultProviderId: typeof GROK_ACP_PROVIDER_ID
  providers: ProviderDefinition[]
}

/**
 * A deliberately narrow view of runtime state. The registry ignores every
 * other runtime field (including raw error text), so a diagnostic or provider
 * implementation cannot accidentally persist or display a secret here.
 */
export type ProviderRuntimeModelAvailability = {
  id: string
  available: boolean
  reason?: 'login-required' | 'credential-missing' | string
}

export type ProviderModelHealthReason = 'login-required' | 'credential-missing' | 'unavailable' | 'not-reported'
export type ProviderModelHealth = {
  id: string
  available: boolean
  reason?: ProviderModelHealthReason
}

export type ProviderHealthReason =
  | 'provider-disabled'
  | 'provider-runtime-unbound'
  | 'runtime-model-availability-unavailable'
  | 'no-model-available'

export type ProviderHealthSnapshot = {
  providerId: string
  status: 'ready' | 'degraded' | 'unavailable'
  models: ProviderModelHealth[]
  reasons: ProviderHealthReason[]
}

export type ProviderRegistryHealthSnapshot = {
  defaultProviderId: typeof GROK_ACP_PROVIDER_ID
  providers: ProviderHealthSnapshot[]
}

export type ProviderSelectionRequest = {
  providerId?: string
  modelId?: string
  requiredCapabilities?: readonly ProviderCapability[]
}

export type ProviderSelectionFailureReason =
  | 'provider-id-invalid'
  | 'provider-not-found'
  | 'provider-disabled'
  | 'provider-runtime-unbound'
  | 'capability-invalid'
  | 'capability-unsupported'
  | 'model-id-invalid'
  | 'models-unsupported'
  | 'model-unsupported'
  | 'model-availability-unknown'
  | 'model-unavailable'

export type ProviderSelection =
  | {
    ok: true
    provider: ProviderDefinition
    modelId: string | null
    health: ProviderHealthSnapshot
  }
  | {
    ok: false
    reason: ProviderSelectionFailureReason
    providerId?: string
    modelId?: string
    unsupportedCapability?: ProviderCapability
    health?: ProviderHealthSnapshot
  }

export type ProviderRegistrationInput = {
  id: unknown
  label: unknown
  enabled?: unknown
  modelIds: unknown
  capabilities: unknown
}

export class ProviderRegistryValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderRegistryValidationError'
  }
}

export class ProviderRegistryConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderRegistryConflictError'
  }
}

const MAX_STATE_BYTES = 128 * 1024
const MAX_PROVIDER_COUNT = 32
const MAX_MODEL_COUNT = 32
const MAX_LABEL_LENGTH = 100
const providerIdPattern = /^[a-z][a-z0-9-]{1,63}$/
const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const controlCharacters = /[\u0000-\u001f\u007f]/
const credentialLikeText = /(?:\b(?:api[_-]?key|access[_-]?key|secret|password|authorization)\b\s*[:=]|\bbearer\s+[A-Za-z0-9._~+\/-]{8,}|\b(?:sk|xai|gsk)[_-][A-Za-z0-9._~-]{12,})/i

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const defaultProvider = (): ProviderDefinition => ({
  id: GROK_ACP_PROVIDER_ID,
  label: 'Grok ACP',
  protocol: 'acp',
  runtimeBinding: 'grok-acp',
  route: '/acp',
  enabled: true,
  modelIds: ['grok-4.5', 'mimo', 'deepseek-v4-pro'],
  capabilities: {
    sessions: { create: true, load: true, cancel: true, events: true },
    models: true,
    permissions: true,
    tools: true,
    context: true,
  },
})

/** A clone is returned by registry APIs; do not use this object as mutable state. */
export const DEFAULT_GROK_ACP_PROVIDER: ProviderDefinition = defaultProvider()

type ProviderRegistryFile = {
  schema: typeof PROVIDER_REGISTRY_SCHEMA
  providers: ProviderDefinition[]
}

export type ProviderRegistry = {
  statePath: string
  snapshot: () => Promise<ProviderRegistrySnapshot>
  list: () => Promise<ProviderDefinition[]>
  register: (input: ProviderRegistrationInput | unknown) => Promise<ProviderDefinition>
  setEnabled: (providerId: unknown, enabled: unknown) => Promise<ProviderDefinition>
  remove: (providerId: unknown) => Promise<boolean>
  health: (runtimeModelAvailability?: readonly ProviderRuntimeModelAvailability[]) => Promise<ProviderRegistryHealthSnapshot>
  select: (
    runtimeModelAvailability: readonly ProviderRuntimeModelAvailability[] | undefined,
    request?: ProviderSelectionRequest,
  ) => Promise<ProviderSelection>
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : ''

const assertExactKeys = (value: unknown, label: string, keys: readonly string[]) => {
  if (!isPlainRecord(value)) throw new ProviderRegistryValidationError(`${label} 必须是对象`)
  const allowed = new Set(keys)
  const unsupported = Object.keys(value).find((key) => !allowed.has(key))
  if (unsupported) throw new ProviderRegistryValidationError(`${label} 包含不受支持的字段：${unsupported}`)
  return value
}

const providerId = (value: unknown, label = 'Provider 标识'): string => {
  if (typeof value !== 'string' || !providerIdPattern.test(value) || credentialLikeText.test(value)) throw new ProviderRegistryValidationError(`${label} 无效`)
  return value
}

const modelId = (value: unknown, label = '模型标识'): string => {
  if (typeof value !== 'string' || !modelIdPattern.test(value) || credentialLikeText.test(value)) throw new ProviderRegistryValidationError(`${label} 无效`)
  return value
}

const label = (value: unknown): string => {
  if (typeof value !== 'string') throw new ProviderRegistryValidationError('Provider 名称无效')
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > MAX_LABEL_LENGTH || controlCharacters.test(normalized) || credentialLikeText.test(normalized)) {
    throw new ProviderRegistryValidationError('Provider 名称无效')
  }
  return normalized
}

const capabilitySet = (value: unknown): ProviderCapabilities => {
  const record = assertExactKeys(value, 'Provider 能力', ['sessions', 'models', 'permissions', 'tools', 'context'])
  const sessions = assertExactKeys(record.sessions, 'Provider 会话能力', ['create', 'load', 'cancel', 'events'])
  const bool = (entry: unknown, name: string) => {
    if (typeof entry !== 'boolean') throw new ProviderRegistryValidationError(`${name} 必须是布尔值`)
    return entry
  }
  return {
    sessions: {
      create: bool(sessions.create, 'sessions.create'),
      load: bool(sessions.load, 'sessions.load'),
      cancel: bool(sessions.cancel, 'sessions.cancel'),
      events: bool(sessions.events, 'sessions.events'),
    },
    models: bool(record.models, 'models'),
    permissions: bool(record.permissions, 'permissions'),
    tools: bool(record.tools, 'tools'),
    context: bool(record.context, 'context'),
  }
}

const modelIds = (value: unknown, capabilities: ProviderCapabilities): string[] => {
  if (!Array.isArray(value) || value.length > MAX_MODEL_COUNT) throw new ProviderRegistryValidationError('Provider 模型列表无效')
  const normalized = value.map((entry) => modelId(entry))
  if (new Set(normalized).size !== normalized.length) throw new ProviderRegistryValidationError('Provider 模型标识重复')
  if (capabilities.models && normalized.length === 0) throw new ProviderRegistryValidationError('支持模型选择的 Provider 必须声明模型')
  if (!capabilities.models && normalized.length > 0) throw new ProviderRegistryValidationError('不支持模型选择的 Provider 不能声明模型')
  return normalized
}

const normalizedCustomProvider = (input: unknown, source: 'registration' | 'storage'): ProviderDefinition => {
  const keys = source === 'registration'
    ? ['id', 'label', 'enabled', 'modelIds', 'capabilities']
    : ['id', 'label', 'protocol', 'runtimeBinding', 'route', 'enabled', 'modelIds', 'capabilities']
  const record = assertExactKeys(input, 'Provider 配置', keys)
  const id = providerId(record.id)
  if (id === GROK_ACP_PROVIDER_ID) throw new ProviderRegistryValidationError('Grok ACP 是保留的默认 Provider')
  const capabilities = capabilitySet(record.capabilities)
  if (source === 'storage') {
    if (record.protocol !== 'acp' || record.runtimeBinding !== 'unbound' || record.route !== null) {
      throw new ProviderRegistryValidationError('自定义 Provider 不能声明未实现的运行时连接')
    }
  }
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') throw new ProviderRegistryValidationError('Provider enabled 必须是布尔值')
  return {
    id,
    label: label(record.label),
    protocol: 'acp',
    runtimeBinding: 'unbound',
    route: null,
    enabled: record.enabled === undefined ? true : record.enabled,
    modelIds: modelIds(record.modelIds, capabilities),
    capabilities,
  }
}

const emptyFile = (): ProviderRegistryFile => ({ schema: PROVIDER_REGISTRY_SCHEMA, providers: [] })

const normalizedFile = (value: unknown): ProviderRegistryFile => {
  const record = assertExactKeys(value, 'Provider 注册表状态', ['schema', 'providers'])
  if (record.schema !== PROVIDER_REGISTRY_SCHEMA || !Array.isArray(record.providers) || record.providers.length > MAX_PROVIDER_COUNT) {
    throw new ProviderRegistryValidationError('Provider 注册表状态无效')
  }
  const providers = record.providers.map((provider) => normalizedCustomProvider(provider, 'storage'))
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length) throw new ProviderRegistryValidationError('Provider 标识重复')
  return { schema: PROVIDER_REGISTRY_SCHEMA, providers }
}

const safeDirectory = async (directory: string) => {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const metadata = await lstat(directory)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new ProviderRegistryValidationError('Provider 注册表目录不安全')
  try { await chmod(directory, 0o700) } catch { /* Filesystems without POSIX modes still retain the safe type check. */ }
  return path.resolve(directory)
}

const capabilitiesSupport = (capabilities: ProviderCapabilities, capability: ProviderCapability) => {
  switch (capability) {
    case 'session-create': return capabilities.sessions.create
    case 'session-load': return capabilities.sessions.load
    case 'session-cancel': return capabilities.sessions.cancel
    case 'events': return capabilities.sessions.events
    case 'models': return capabilities.models
    case 'permissions': return capabilities.permissions
    case 'tools': return capabilities.tools
    case 'context': return capabilities.context
  }
}

const safeRuntimeReason = (value: unknown): ProviderModelHealthReason => {
  if (value === 'login-required' || value === 'credential-missing') return value
  return 'unavailable'
}

const runtimeAvailabilityById = (value: readonly ProviderRuntimeModelAvailability[] | undefined) => {
  if (!value) return null
  const entries = new Map<string, ProviderRuntimeModelAvailability>()
  for (const entry of value) {
    if (!entry || typeof entry.id !== 'string' || !modelIdPattern.test(entry.id) || typeof entry.available !== 'boolean' || entries.has(entry.id)) continue
    entries.set(entry.id, entry)
  }
  return entries
}

export function providerHealthSnapshot(
  provider: ProviderDefinition,
  runtimeModelAvailability?: readonly ProviderRuntimeModelAvailability[],
): ProviderHealthSnapshot {
  const unavailable = (reason: ProviderHealthReason, modelReason: ProviderModelHealthReason = 'unavailable'): ProviderHealthSnapshot => ({
    providerId: provider.id,
    status: 'unavailable',
    models: provider.modelIds.map((id) => ({ id, available: false, reason: modelReason })),
    reasons: [reason],
  })
  if (!provider.enabled) return unavailable('provider-disabled')
  if (provider.runtimeBinding !== 'grok-acp' || provider.route !== '/acp') return unavailable('provider-runtime-unbound')
  if (!provider.capabilities.models) return { providerId: provider.id, status: 'ready', models: [], reasons: [] }

  const availability = runtimeAvailabilityById(runtimeModelAvailability)
  if (!availability) {
    return {
      providerId: provider.id,
      status: 'degraded',
      models: provider.modelIds.map((id) => ({ id, available: false, reason: 'not-reported' })),
      reasons: ['runtime-model-availability-unavailable'],
    }
  }
  const models = provider.modelIds.map((id): ProviderModelHealth => {
    const runtime = availability.get(id)
    if (!runtime) return { id, available: false, reason: 'not-reported' }
    if (runtime.available) return { id, available: true }
    return { id, available: false, reason: safeRuntimeReason(runtime.reason) }
  })
  const available = models.filter((entry) => entry.available).length
  if (available === 0) {
    const hasUnreportedModel = models.some((entry) => entry.reason === 'not-reported')
    return {
      providerId: provider.id,
      status: hasUnreportedModel ? 'degraded' : 'unavailable',
      models,
      reasons: [hasUnreportedModel ? 'runtime-model-availability-unavailable' : 'no-model-available'],
    }
  }
  return { providerId: provider.id, status: available === models.length ? 'ready' : 'degraded', models, reasons: [] }
}

export function providerRegistryHealthSnapshot(
  snapshot: ProviderRegistrySnapshot,
  runtimeModelAvailability?: readonly ProviderRuntimeModelAvailability[],
): ProviderRegistryHealthSnapshot {
  return {
    defaultProviderId: snapshot.defaultProviderId,
    providers: snapshot.providers.map((provider) => providerHealthSnapshot(provider, runtimeModelAvailability)),
  }
}

const safeRequestedProviderId = (value: unknown) => typeof value === 'string' && providerIdPattern.test(value) && !credentialLikeText.test(value) ? value : null
const safeRequestedModelId = (value: unknown) => typeof value === 'string' && modelIdPattern.test(value) && !credentialLikeText.test(value) ? value : null

export function selectProvider(
  snapshot: ProviderRegistrySnapshot,
  runtimeModelAvailability: readonly ProviderRuntimeModelAvailability[] | undefined,
  request: ProviderSelectionRequest = {},
): ProviderSelection {
  if (request.providerId !== undefined && !safeRequestedProviderId(request.providerId)) return { ok: false, reason: 'provider-id-invalid' }
  if (request.modelId !== undefined && !safeRequestedModelId(request.modelId)) return { ok: false, reason: 'model-id-invalid' }
  const providerId = request.providerId ?? snapshot.defaultProviderId
  const provider = snapshot.providers.find((entry) => entry.id === providerId)
  if (!provider) return { ok: false, reason: 'provider-not-found', providerId }
  const health = providerHealthSnapshot(provider, runtimeModelAvailability)
  if (!provider.enabled) return { ok: false, reason: 'provider-disabled', providerId, health }
  if (provider.runtimeBinding !== 'grok-acp' || provider.route !== '/acp') return { ok: false, reason: 'provider-runtime-unbound', providerId, health }

  const required = request.requiredCapabilities ?? ['session-create']
  for (const capability of required) {
    if (!(providerCapabilities as readonly string[]).includes(capability)) return { ok: false, reason: 'capability-invalid', providerId, health }
    if (!capabilitiesSupport(provider.capabilities, capability)) {
      return { ok: false, reason: 'capability-unsupported', providerId, unsupportedCapability: capability, health }
    }
  }

  if (request.modelId !== undefined) {
    if (!provider.capabilities.models) return { ok: false, reason: 'models-unsupported', providerId, modelId: request.modelId, health }
    if (!provider.modelIds.includes(request.modelId)) return { ok: false, reason: 'model-unsupported', providerId, modelId: request.modelId, health }
    const model = health.models.find((entry) => entry.id === request.modelId)
    if (!model || model.reason === 'not-reported') return { ok: false, reason: 'model-availability-unknown', providerId, modelId: request.modelId, health }
    if (!model.available) return { ok: false, reason: 'model-unavailable', providerId, modelId: request.modelId, health }
    return { ok: true, provider: clone(provider), modelId: request.modelId, health }
  }

  if (!provider.capabilities.models) return { ok: true, provider: clone(provider), modelId: null, health }
  const model = health.models.find((entry) => entry.available)
  if (model) return { ok: true, provider: clone(provider), modelId: model.id, health }
  if (health.reasons.includes('runtime-model-availability-unavailable') || health.models.some((entry) => entry.reason === 'not-reported')) {
    return { ok: false, reason: 'model-availability-unknown', providerId, health }
  }
  return { ok: false, reason: 'model-unavailable', providerId, health }
}

export function createProviderRegistry(options: { statePath: string }): ProviderRegistry {
  const statePath = path.resolve(options.statePath)
  const stateDirectory = path.dirname(statePath)
  let mutationQueue: Promise<void> = Promise.resolve()

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation, operation)
    mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  const ensureStorage = async () => { await safeDirectory(stateDirectory) }

  const persist = async (value: ProviderRegistryFile) => {
    const normalized = normalizedFile(value)
    await ensureStorage()
    const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      try { await chmod(temporary, 0o600) } catch { /* Creation mode is restrictive where supported. */ }
      await rename(temporary, statePath)
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  const readState = async (): Promise<ProviderRegistryFile> => {
    await ensureStorage()
    try {
      const metadata = await lstat(statePath)
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_STATE_BYTES || (metadata.mode & 0o077) !== 0) {
        throw new ProviderRegistryValidationError('Provider 注册表状态文件不安全')
      }
      return normalizedFile(JSON.parse(await readFile(statePath, 'utf8')) as unknown)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      const initial = emptyFile()
      await persist(initial)
      return initial
    }
  }

  const snapshot = () => serialize(async (): Promise<ProviderRegistrySnapshot> => {
    const state = await readState()
    return {
      schema: PROVIDER_REGISTRY_SCHEMA,
      defaultProviderId: GROK_ACP_PROVIDER_ID,
      providers: [defaultProvider(), ...state.providers.map(clone)],
    }
  })

  const register = (input: ProviderRegistrationInput | unknown) => serialize(async () => {
    const provider = normalizedCustomProvider(input, 'registration')
    const state = await readState()
    if (state.providers.some((entry) => entry.id === provider.id)) throw new ProviderRegistryConflictError('Provider 已存在')
    state.providers.push(provider)
    await persist(state)
    return clone(provider)
  })

  const setEnabled = (inputProviderId: unknown, inputEnabled: unknown) => serialize(async () => {
    const id = providerId(inputProviderId)
    if (id === GROK_ACP_PROVIDER_ID) throw new ProviderRegistryConflictError('默认 Grok ACP Provider 不能被禁用')
    if (typeof inputEnabled !== 'boolean') throw new ProviderRegistryValidationError('Provider enabled 必须是布尔值')
    const state = await readState()
    const provider = state.providers.find((entry) => entry.id === id)
    if (!provider) throw new ProviderRegistryConflictError('Provider 不存在')
    provider.enabled = inputEnabled
    await persist(state)
    return clone(provider)
  })

  const remove = (inputProviderId: unknown) => serialize(async () => {
    const id = providerId(inputProviderId)
    if (id === GROK_ACP_PROVIDER_ID) throw new ProviderRegistryConflictError('默认 Grok ACP Provider 不能被删除')
    const state = await readState()
    const next = state.providers.filter((entry) => entry.id !== id)
    if (next.length === state.providers.length) return false
    state.providers = next
    await persist(state)
    return true
  })

  return {
    statePath,
    snapshot,
    list: async () => (await snapshot()).providers,
    register,
    setEnabled,
    remove,
    health: async (runtimeModelAvailability) => providerRegistryHealthSnapshot(await snapshot(), runtimeModelAvailability),
    select: async (runtimeModelAvailability, request = {}) => selectProvider(await snapshot(), runtimeModelAvailability, request),
  }
}
