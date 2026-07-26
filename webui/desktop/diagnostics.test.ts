import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  collectDesktopDiagnosticPermissions,
  collectDesktopDiagnostics,
  collectRootRuntimeSummary,
  createSingleFlight,
  probeFullDiskAccess,
  readDesktopDiagnosticLogTail,
  requestDesktopDiagnosticPermission,
  type DesktopDiagnosticPermissionAccess,
} from './diagnostics.ts'

test('probes full disk access without reading protected database contents', () => {
  let openedPath = ''
  let closedDescriptor: number | null = null
  assert.equal(probeFullDiskAccess({
    platform: 'darwin',
    homeDirectory: '/Users/example',
    openFile: (candidate) => {
      openedPath = candidate
      return 42
    },
    closeFile: (descriptor) => { closedDescriptor = descriptor },
  }), 'granted')
  assert.equal(openedPath, '/Users/example/Library/Application Support/com.apple.TCC/TCC.db')
  assert.equal(closedDescriptor, 42)

  assert.equal(probeFullDiskAccess({
    platform: 'darwin',
    homeDirectory: '/Users/example',
    openFile: () => { throw Object.assign(new Error('blocked'), { code: 'EPERM' }) },
  }), 'denied')

  assert.equal(probeFullDiskAccess({
    platform: 'darwin',
    homeDirectory: '/Users/example',
    openFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
  }), 'unknown')

  assert.equal(probeFullDiskAccess({
    platform: 'linux',
    homeDirectory: '/home/example',
    openFile: () => { throw new Error('must not probe outside macOS') },
  }), 'not-required')
})

const iso = '2026-07-25T08:30:00.000Z'
const identity = {
  pid: 4242,
  startedAt: 'Fri Jul 25 08:30:00 2026',
  commandHash: 'a'.repeat(64),
}

const macPermissions = (overrides: Partial<{
  microphone: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'
  screen: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'
  accessibility: boolean
  fullDisk: 'granted' | 'denied' | 'unknown'
}> = {}) => {
  let microphone = overrides.microphone ?? 'not-determined'
  const screen = overrides.screen ?? 'denied'
  let accessibility = overrides.accessibility ?? false
  let microphoneRequests = 0
  let accessibilityPrompts = 0
  const access: DesktopDiagnosticPermissionAccess = {
    platform: 'darwin',
    microphoneState: () => microphone,
    screenRecordingState: () => screen,
    accessibilityTrusted: (prompt) => {
      if (prompt) {
        accessibilityPrompts += 1
        accessibility = true
      }
      return accessibility
    },
    fullDiskAccessState: () => overrides.fullDisk ?? 'denied',
    requestMicrophone: async () => {
      microphoneRequests += 1
      microphone = 'granted'
      return true
    },
  }
  return {
    access,
    calls: () => ({ microphoneRequests, accessibilityPrompts }),
  }
}

async function createDiagnosticFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runbuild-diagnostics-'))
  const grokHome = path.join(root, 'runtime')
  const workspace = path.join(root, 'workspace')
  const userDataPath = path.join(root, 'user-data')
  for (const directory of [
    grokHome,
    workspace,
    userDataPath,
    path.join(grokHome, 'projects'),
    path.join(grokHome, 'leases'),
    path.join(grokHome, 'runners'),
    path.join(grokHome, 'task-events'),
    path.join(grokHome, 'task-workspaces'),
    path.join(grokHome, 'webui'),
  ]) await mkdir(directory, { recursive: true })
  await writeFile(path.join(grokHome, 'webui', 'projects.json'), '[]\n')
  await writeFile(path.join(grokHome, 'desktop-agent.log'), 'Agent booted\n')
  await writeFile(path.join(grokHome, 'leases', 'desktop-agent--root-agent.lease.json'), JSON.stringify({
    version: 1,
    leaseId: '12345678-1234-1234-1234-123456789abc',
    kind: 'desktop-agent',
    subjectId: 'root-agent',
    runtime: {
      port: 43123,
      state: 'running',
      startedAt: iso,
      heartbeatAt: iso,
    },
    process: { pid: identity.pid, identity },
  }))
  return { root, grokHome, workspace, userDataPath }
}

test('collects a local-only, redacted health snapshot with lease/process proof', async () => {
  const fixture = await createDiagnosticFixture()
  const permissions = macPermissions()
  try {
    const snapshot = await collectDesktopDiagnostics({
      workspace: fixture.workspace,
      grokHome: fixture.grokHome,
      userDataPath: fixture.userDataPath,
      modelProfile: 'grok-4.5',
      runtimeState: 'listening',
      runtimeConnected: true,
      runtimeError: 'XAI_API_KEY=diagnostic-secret',
      modelAvailability: [
        { id: 'grok-4.5', available: true },
        { id: 'mimo', available: false, reason: 'credential-missing' },
      ],
      permissionAccess: permissions.access,
      inspectProcess: async () => ({ state: 'present', identity }),
    })

    assert.equal(snapshot.scope, 'local-only')
    assert.deepEqual(snapshot.providers, [
      { id: 'grok-4.5', label: 'Grok 4.5', status: 'ready' },
      { id: 'mimo', label: 'MiMo', status: 'unavailable', reason: 'credential-missing' },
    ])
    assert.equal(snapshot.runtime.lease.status, 'active')
    assert.equal(snapshot.runtime.process.status, 'present')
    assert.equal(snapshot.runtime.lease.port, 43123)
    assert.equal(snapshot.runtime.error, 'XAI_API_KEY=[REDACTED]')
    assert.equal(snapshot.storage.every((entry) => entry.status === 'ready'), true)
    assert.equal(snapshot.connectors.every((entry) => entry.status === 'ready'), true)
    assert.equal(JSON.stringify(snapshot).includes('diagnostic-secret'), false)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('rejects malformed root leases and reports identity mismatch without acting on a process', async () => {
  const fixture = await createDiagnosticFixture()
  try {
    const leasePath = path.join(fixture.grokHome, 'leases', 'desktop-agent--root-agent.lease.json')
    await writeFile(leasePath, '{not json')
    const malformed = await collectRootRuntimeSummary({
      grokHome: fixture.grokHome,
      modelProfile: 'grok-4.5',
      runtimeState: 'failed',
      runtimeConnected: false,
      inspectProcess: async () => { throw new Error('must not inspect malformed lease') },
    })
    assert.equal(malformed.lease.status, 'invalid')
    assert.equal(malformed.process.status, 'not-recorded')

    await writeFile(leasePath, JSON.stringify({
      version: 1,
      leaseId: '12345678-1234-1234-1234-123456789abc',
      kind: 'desktop-agent',
      subjectId: 'root-agent',
      runtime: { port: 43123, state: 'running', startedAt: iso, heartbeatAt: iso },
      process: { pid: identity.pid, identity },
    }))
    const mismatch = await collectRootRuntimeSummary({
      grokHome: fixture.grokHome,
      modelProfile: 'grok-4.5',
      runtimeState: 'listening',
      runtimeConnected: true,
      inspectProcess: async () => ({
        state: 'present',
        identity: { ...identity, commandHash: 'b'.repeat(64) },
      }),
    })
    assert.equal(mismatch.lease.status, 'active')
    assert.equal(mismatch.process.status, 'identity-mismatch')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('returns only a bounded, redacted tail from the fixed desktop Agent log', async () => {
  const fixture = await createDiagnosticFixture()
  try {
    const logPath = path.join(fixture.grokHome, 'desktop-agent.log')
    await writeFile(logPath, [
      'first line that should be dropped',
      'XAI_API_KEY=super-secret-value',
      'Authorization: Bearer bearer-secret-value-1234567890',
      'ordinary tail line',
      `GROK_AGENT_SECRET=${'f'.repeat(48)}`,
    ].join('\n'))
    const tail = readDesktopDiagnosticLogTail(fixture.grokHome, 'desktop-agent', { maxBytes: 16 * 1024, maxLines: 3 })
    assert.equal(tail.status, 'available')
    assert.equal(tail.lines.length, 3)
    assert.equal(tail.truncated, true)
    assert.equal(tail.redactions >= 2, true)
    assert.equal(JSON.stringify(tail).includes('super-secret-value'), false)
    assert.equal(JSON.stringify(tail).includes('bearer-secret-value'), false)
    assert.equal(JSON.stringify(tail).includes('f'.repeat(48)), false)

    await rm(logPath)
    const foreign = path.join(fixture.root, 'foreign.log')
    await writeFile(foreign, 'do not follow this link')
    await symlink(foreign, logPath)
    assert.equal(readDesktopDiagnosticLogTail(fixture.grokHome).status, 'unavailable')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('surfaces recent MCP startup failures as degraded connectors without exposing command detail', async () => {
  const fixture = await createDiagnosticFixture()
  const permissions = macPermissions()
  try {
    await writeFile(path.join(fixture.grokHome, 'desktop-agent.log'), [
      "ERROR Failed to spawn MCP server 'postgres': /private/path/with-secret-command",
      "ERROR Failed to spawn MCP server 'summer-engine': No such file or directory",
      "ERROR Failed to spawn MCP server 'postgres': repeated",
      "ERROR Failed to spawn MCP server 'unsafe name; rm -rf': ignored",
    ].join('\n'))
    const snapshot = await collectDesktopDiagnostics({
      workspace: fixture.workspace,
      grokHome: fixture.grokHome,
      userDataPath: fixture.userDataPath,
      modelProfile: 'grok-4.5',
      runtimeState: 'listening',
      runtimeConnected: true,
      modelAvailability: [],
      permissionAccess: permissions.access,
      inspectProcess: async () => ({ state: 'present', identity }),
    })
    const mcpConnectors = snapshot.connectors.filter((connector) => connector.id.startsWith('mcp-'))
    assert.deepEqual(mcpConnectors.map((connector) => ({ label: connector.label, status: connector.status })), [
      { label: 'MCP：postgres', status: 'degraded' },
      { label: 'MCP：summer-engine', status: 'degraded' },
    ])
    assert.equal(JSON.stringify(snapshot).includes('/private/path/with-secret-command'), false)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('only requests macOS permissions after an explicit action and never opens settings itself', async () => {
  const permissions = macPermissions()
  const initial = collectDesktopDiagnosticPermissions(permissions.access)
  assert.equal(initial.permissions.find((entry) => entry.id === 'microphone')?.canRequest, true)
  assert.deepEqual(permissions.calls(), { microphoneRequests: 0, accessibilityPrompts: 0 })

  const microphone = await requestDesktopDiagnosticPermission(permissions.access, 'microphone')
  assert.equal(microphone.outcome, 'requested')
  assert.equal(microphone.permissions.permissions.find((entry) => entry.id === 'microphone')?.state, 'granted')
  assert.deepEqual(permissions.calls(), { microphoneRequests: 1, accessibilityPrompts: 0 })

  const screen = await requestDesktopDiagnosticPermission(permissions.access, 'screen-recording')
  const fullDisk = await requestDesktopDiagnosticPermission(permissions.access, 'full-disk-access')
  assert.equal(screen.outcome, 'system-settings-required')
  assert.equal(fullDisk.outcome, 'system-settings-required')
  assert.equal(fullDisk.permissions.permissions.find((entry) => entry.id === 'full-disk-access')?.state, 'denied')
  assert.deepEqual(permissions.calls(), { microphoneRequests: 1, accessibilityPrompts: 0 })

  const accessibility = await requestDesktopDiagnosticPermission(permissions.access, 'accessibility')
  assert.equal(accessibility.outcome, 'requested')
  assert.deepEqual(permissions.calls(), { microphoneRequests: 1, accessibilityPrompts: 1 })

  const nonMac = collectDesktopDiagnosticPermissions({
    ...permissions.access,
    platform: 'linux',
    microphoneState: () => { throw new Error('must not query macOS access on Linux') },
    screenRecordingState: () => { throw new Error('must not query macOS access on Linux') },
    accessibilityTrusted: () => { throw new Error('must not query macOS access on Linux') },
    fullDiskAccessState: () => { throw new Error('must not query macOS access on Linux') },
  })
  assert.equal(nonMac.permissions.every((entry) => entry.state === 'not-required'), true)
})

test('coalesces repeated restart clicks into one serialized operation', async () => {
  let calls = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const restart = createSingleFlight(async () => {
    calls += 1
    await gate
    return calls
  })
  const first = restart()
  const second = restart()
  assert.equal(first, second)
  assert.equal(calls, 1)
  release?.()
  assert.equal(await first, 1)
  assert.equal(await restart(), 2)
  assert.equal(calls, 2)
})
