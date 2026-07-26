import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULT_GROK_ACP_PROVIDER,
  GROK_ACP_PROVIDER_ID,
  ProviderRegistryConflictError,
  ProviderRegistryValidationError,
  createProviderRegistry,
  selectProvider,
  type ProviderRegistrationInput,
  type ProviderRegistrySnapshot,
} from './provider-registry.ts'

const futureProvider = (overrides: Partial<ProviderRegistrationInput> = {}): ProviderRegistrationInput => ({
  id: 'future-acp',
  label: 'Future ACP',
  enabled: true,
  modelIds: ['future-code-1'],
  capabilities: {
    sessions: { create: true, load: true, cancel: false, events: true },
    models: true,
    permissions: false,
    tools: true,
    context: true,
  },
  ...overrides,
})

test('materializes a durable, credential-free registry with Grok ACP as the immutable default path', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-provider-registry-'))
  try {
    const statePath = path.join(temporaryRoot, 'runtime', 'providers.json')
    const registry = createProviderRegistry({ statePath })
    const snapshot = await registry.snapshot()

    assert.equal(snapshot.defaultProviderId, GROK_ACP_PROVIDER_ID)
    assert.deepEqual(snapshot.providers, [DEFAULT_GROK_ACP_PROVIDER])
    assert.equal(snapshot.providers[0]?.route, '/acp')
    assert.equal(snapshot.providers[0]?.runtimeBinding, 'grok-acp')
    assert.equal((await lstat(statePath)).mode & 0o777, 0o600)
    const rawState = await readFile(statePath, 'utf8')
    assert.doesNotMatch(rawState, /XAI_API_KEY|api[_-]?key|bearer|secret/i)

    await assert.rejects(registry.remove(GROK_ACP_PROVIDER_ID), ProviderRegistryConflictError)
    await assert.rejects(registry.setEnabled(GROK_ACP_PROVIDER_ID, false), ProviderRegistryConflictError)
    assert.deepEqual((await registry.snapshot()).providers, [DEFAULT_GROK_ACP_PROVIDER])
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('persists validated future provider contracts without claiming an unbound provider is executable', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-provider-registry-custom-'))
  try {
    const statePath = path.join(temporaryRoot, 'providers.json')
    const registry = createProviderRegistry({ statePath })
    const created = await registry.register(futureProvider())

    assert.deepEqual(created, {
      id: 'future-acp',
      label: 'Future ACP',
      protocol: 'acp',
      runtimeBinding: 'unbound',
      route: null,
      enabled: true,
      modelIds: ['future-code-1'],
      capabilities: {
        sessions: { create: true, load: true, cancel: false, events: true },
        models: true,
        permissions: false,
        tools: true,
        context: true,
      },
    })
    assert.deepEqual((await createProviderRegistry({ statePath }).list()).map((provider) => provider.id), ['grok-acp', 'future-acp'])
    assert.equal((await registry.health([{ id: 'grok-4.5', available: true }])).providers.find((provider) => provider.providerId === 'future-acp')?.reasons[0], 'provider-runtime-unbound')
    assert.deepEqual(await registry.select([{ id: 'future-code-1', available: true }], { providerId: 'future-acp' }), {
      ok: false,
      reason: 'provider-runtime-unbound',
      providerId: 'future-acp',
      health: {
        providerId: 'future-acp',
        status: 'unavailable',
        models: [{ id: 'future-code-1', available: false, reason: 'unavailable' }],
        reasons: ['provider-runtime-unbound'],
      },
    })

    await registry.setEnabled('future-acp', false)
    const disabledSelection = await registry.select([], { providerId: 'future-acp' })
    assert.equal(disabledSelection.ok, false)
    if (!disabledSelection.ok) assert.equal(disabledSelection.reason, 'provider-disabled')
    assert.equal(await registry.remove('future-acp'), true)
    assert.equal(await registry.remove('future-acp'), false)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('rejects credential-shaped or unsupported configuration before it reaches durable state', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-provider-registry-validation-'))
  try {
    const statePath = path.join(temporaryRoot, 'providers.json')
    const registry = createProviderRegistry({ statePath })
    await assert.rejects(registry.register({ ...futureProvider(), apiKey: 'sk-should-never-persist' }), ProviderRegistryValidationError)
    await assert.rejects(registry.register(futureProvider({ label: 'Bearer xai-secret-value' })), ProviderRegistryValidationError)
    await assert.rejects(registry.register(futureProvider({ modelIds: ['sk-should-never-persist-123456'] })), ProviderRegistryValidationError)
    await assert.rejects(registry.register(futureProvider({ id: 'grok-acp' })), ProviderRegistryValidationError)
    await assert.rejects(registry.register(futureProvider({ modelIds: [], capabilities: { ...futureProvider().capabilities as Record<string, unknown>, models: true } })), ProviderRegistryValidationError)
    assert.deepEqual((await registry.list()).map((provider) => provider.id), ['grok-acp'])

    await writeFile(statePath, JSON.stringify({
      schema: 'runbuild.provider-registry.v1',
      providers: [{ ...futureProvider(), apiKey: 'not-allowed' }],
    }))
    await chmod(statePath, 0o600)
    await assert.rejects(createProviderRegistry({ statePath }).snapshot(), ProviderRegistryValidationError)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('derives redacted health and explicit selection reasons from runtime model availability', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-provider-registry-health-'))
  try {
    const registry = createProviderRegistry({ statePath: path.join(temporaryRoot, 'providers.json') })
    const runtime = [
      { id: 'grok-4.5', available: true, error: 'Authorization: Bearer must-not-leak' },
      { id: 'mimo', available: false, reason: 'credential-missing' as const, detail: 'MIMO_API_KEY=must-not-leak' },
      { id: 'deepseek-v4-pro', available: false, reason: 'login-required' as const, message: 'sk-must-not-leak' },
    ]
    const health = await registry.health(runtime)
    const grok = health.providers[0]
    assert.deepEqual(grok, {
      providerId: 'grok-acp',
      status: 'degraded',
      models: [
        { id: 'grok-4.5', available: true },
        { id: 'mimo', available: false, reason: 'credential-missing' },
        { id: 'deepseek-v4-pro', available: false, reason: 'login-required' },
      ],
      reasons: [],
    })
    assert.doesNotMatch(JSON.stringify(health), /must-not-leak|Authorization|MIMO_API_KEY|sk-/)

    const defaultSelection = await registry.select(runtime, { requiredCapabilities: ['session-create', 'events', 'tools', 'context'] })
    assert.equal(defaultSelection.ok, true)
    if (defaultSelection.ok) {
      assert.equal(defaultSelection.provider.id, 'grok-acp')
      assert.equal(defaultSelection.modelId, 'grok-4.5')
    }
    const unavailableModel = await registry.select(runtime, { modelId: 'mimo' })
    const unknownAvailability = await registry.select(undefined, { modelId: 'grok-4.5' })
    const unsupportedModel = await registry.select(runtime, { modelId: 'missing-model' })
    const unsafeRequestedModel = await registry.select(runtime, { modelId: 'sk-must-not-echo-123456' })
    assert.equal(unavailableModel.ok, false)
    assert.equal(unknownAvailability.ok, false)
    assert.equal(unsupportedModel.ok, false)
    assert.equal(unsafeRequestedModel.ok, false)
    if (!unavailableModel.ok) assert.equal(unavailableModel.reason, 'model-unavailable')
    if (!unknownAvailability.ok) assert.equal(unknownAvailability.reason, 'model-availability-unknown')
    if (!unsupportedModel.ok) assert.equal(unsupportedModel.reason, 'model-unsupported')
    if (!unsafeRequestedModel.ok) {
      assert.equal(unsafeRequestedModel.reason, 'model-id-invalid')
      assert.equal(JSON.stringify(unsafeRequestedModel).includes('must-not-echo'), false)
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('selection reports an unsupported capability without silently changing provider or model', () => {
  const snapshot: ProviderRegistrySnapshot = {
    schema: 'runbuild.provider-registry.v1',
    defaultProviderId: 'grok-acp',
    providers: [{
      ...DEFAULT_GROK_ACP_PROVIDER,
      capabilities: {
        ...DEFAULT_GROK_ACP_PROVIDER.capabilities,
        tools: false,
      },
    }],
  }
  assert.deepEqual(selectProvider(snapshot, [{ id: 'grok-4.5', available: true }], {
    requiredCapabilities: ['tools'],
  }), {
    ok: false,
    reason: 'capability-unsupported',
    providerId: 'grok-acp',
    unsupportedCapability: 'tools',
    health: {
      providerId: 'grok-acp',
      status: 'degraded',
      models: [
        { id: 'grok-4.5', available: true },
        { id: 'mimo', available: false, reason: 'not-reported' },
        { id: 'deepseek-v4-pro', available: false, reason: 'not-reported' },
      ],
      reasons: [],
    },
  })
})
