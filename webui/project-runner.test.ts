import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { DEFAULT_MODEL_PROFILE } from './model-profile.ts'
import { createProjectRegistry } from './project-registry.ts'
import { createProjectRunnerManager, defaultProjectRunnerCommand } from './project-runner.ts'
import { createProcessLeaseStore } from './runner-ownership.ts'

const processExists = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

const stopDetachedProcess = async (pid: number) => {
  try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { return } }
  if (await waitFor(() => !processExists(pid), 1_000)) return
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* Already gone. */ } }
  await waitFor(() => !processExists(pid), 1_000)
}

const fixtureRuntime = (workspace: string, port = 43_123) => ({
  port,
  binaryPath: process.execPath,
  workspace,
  command: { executable: process.execPath, args: ['fixture'] },
  state: 'running' as const,
})

test('uses off sandboxing and always-approve by default; workspace / ask opt-in via env', () => {
  assert.deepEqual(defaultProjectRunnerCommand('/agent', 'grok-4.5', 43123, {}), {
    command: '/agent',
    args: ['--sandbox', 'off', '--always-approve', '--permission-mode', 'default', '--model', 'grok-4.5', 'agent', 'serve', '--bind', '127.0.0.1:43123'],
  })
  assert.deepEqual(defaultProjectRunnerCommand('/agent', 'grok-4.5', 43123, { RUNBUILD_AGENT_SANDBOX: 'workspace' }), {
    command: '/agent',
    args: ['--sandbox', 'workspace', '--always-approve', '--permission-mode', 'default', '--model', 'grok-4.5', 'agent', 'serve', '--bind', '127.0.0.1:43123'],
  })
  assert.deepEqual(defaultProjectRunnerCommand('/agent', 'grok-4.5', 43123, { RUNBUILD_ALWAYS_APPROVE: '0' }), {
    command: '/agent',
    args: ['--sandbox', 'off', '--permission-mode', 'default', '--model', 'grok-4.5', 'agent', 'serve', '--bind', '127.0.0.1:43123'],
  })
})

test('starts and stops one isolated runner for a registered project', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-runner-'))
  const registry = createProjectRegistry({
    projectsRoot: path.join(temporaryRoot, 'projects'),
    registryPath: path.join(temporaryRoot, 'projects.json'),
  })
  const project = await registry.create({ name: 'Runner Test', instructions: 'Stay concise.' })
  const sharedGrokHome = path.join(temporaryRoot, 'grok-home')
  await mkdir(sharedGrokHome, { recursive: true })
  await writeFile(path.join(sharedGrokHome, 'config.toml'), [
    '[models]',
    '# Keep model definitions while inserting the project default.',
    '',
    '[model."grok-4.5"]',
    'model = "grok-4.5"',
    '',
  ].join('\n'))
  const configPath = path.join(project.rootPath, '.grok', 'config.toml')
  await writeFile(configPath, '[project.custom]\nkeep = "yes"\n\n[ui]\npermission_mode = "always-approve"\nyolo = true\n')
  const fixturePath = path.join(temporaryRoot, 'runner-fixture.mjs')
  const environmentCapturePath = path.join(temporaryRoot, 'runner-environment.json')
  const sharedAuthPath = path.join(sharedGrokHome, 'auth.json')
  await writeFile(sharedAuthPath, '{}\n', { mode: 0o600 })
  let explicitAuthPath: string | undefined
  await writeFile(fixturePath, [
    "import net from 'node:net'",
    "import { writeFileSync } from 'node:fs'",
    "writeFileSync(process.env.RUNNER_ENV_CAPTURE, JSON.stringify({ authPath: process.env.GROK_AUTH_PATH, grokHome: process.env.GROK_HOME }))",
    "const server = net.createServer(() => {})",
    "server.listen(Number(process.env.PERSONAL_AGENT_PORT), '127.0.0.1')",
    "process.on('SIGTERM', () => server.close(() => process.exit(0)))",
  ].join('\n'))

  const manager = createProjectRunnerManager({
    registry,
    binaryPath: process.execPath,
    modelProfile: DEFAULT_MODEL_PROFILE,
    grokHome: sharedGrokHome,
    logsRoot: path.join(temporaryRoot, 'logs'),
    getEnvironment: () => ({
      ...process.env,
      ...(explicitAuthPath ? { GROK_AUTH_PATH: explicitAuthPath } : {}),
      RUNNER_ENV_CAPTURE: environmentCapturePath,
    }),
    commandFactory: () => ({ command: process.execPath, args: [fixturePath] }),
    startupTimeoutMs: 5_000,
  })

  try {
    const running = await manager.start(project.id)
    assert.equal(running.state, 'running')
    assert.equal(typeof running.port, 'number')
    assert.equal(manager.status(project.id).state, 'running')
    assert.equal(manager.connection(project.id)?.target, `ws://127.0.0.1:${running.port}`)
    assert.equal('secret' in running, false)
    const leasePath = path.join(temporaryRoot, 'logs', 'leases', `project-runner--${project.id}.lease.json`)
    assert.equal(existsSync(leasePath), true)
    const lease = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>
    assert.equal(lease.kind, 'project-runner')
    assert.equal(lease.subjectId, project.id)
    assert.equal((lease.process as { pid?: number }).pid, running.pid)
    const runtimeMetadata = lease.runtime as {
      port?: number
      binaryPath?: string
      commandHash?: string
      workspaceRealpath?: string
      startedAt?: string
      heartbeatAt?: string
      state?: string
    }
    assert.equal(runtimeMetadata.port, running.port)
    assert.equal(runtimeMetadata.binaryPath, await realpath(process.execPath))
    assert.equal(runtimeMetadata.workspaceRealpath, await realpath(project.rootPath))
    assert.match(runtimeMetadata.commandHash ?? '', /^[a-f0-9]{64}$/)
    assert.equal(runtimeMetadata.state, 'running')
    assert.equal(Number.isNaN(Date.parse(runtimeMetadata.startedAt ?? '')), false)
    assert.equal(Number.isNaN(Date.parse(runtimeMetadata.heartbeatAt ?? '')), false)
    assert.equal(Date.parse(runtimeMetadata.heartbeatAt ?? '') >= Date.parse(runtimeMetadata.startedAt ?? ''), true)
    assert.equal(JSON.stringify(lease).includes('GROK_AGENT_SECRET'), false)
    const initialConfig = await readFile(configPath, 'utf8')
    assert.match(initialConfig, /\[models\]\ndefault = "grok-4\.5"/)
    assert.equal(initialConfig.match(/\[models\]/g)?.length, 1)
    assert.match(initialConfig, /\[model\."grok-4\.5"\]\nmodel = "grok-4\.5"/)
    assert.match(initialConfig, /\[project\.custom\]\nkeep = "yes"/)
    assert.match(initialConfig, /\[memory\]\nenabled = true/)
    assert.match(initialConfig, /\[ui\]\npermission_mode = "always-approve"\nyolo = false/)
    const initialEnvironment = JSON.parse(await readFile(environmentCapturePath, 'utf8')) as Record<string, string>
    assert.equal(initialEnvironment.authPath, sharedAuthPath)
    assert.equal(initialEnvironment.grokHome, await realpath(path.join(project.rootPath, '.grok')))

    await manager.quiesce()
    assert.equal(manager.status(project.id).state, 'stopped')
    await assert.rejects(() => manager.start(project.id), /Runner 管理器正在停止/)
    manager.resume()

    await writeFile(configPath, initialConfig.replace('enabled = true', 'enabled = false'))
    explicitAuthPath = path.join(sharedGrokHome, 'switched-auth.json')
    await manager.start(project.id)
    const restartedConfig = await readFile(configPath, 'utf8')
    const restartedEnvironment = JSON.parse(await readFile(environmentCapturePath, 'utf8')) as Record<string, string>
    assert.equal(restartedEnvironment.authPath, explicitAuthPath)
    assert.match(restartedConfig, /\[project\.custom\]\nkeep = "yes"/)
    assert.match(restartedConfig, /\[memory\]\nenabled = false/)
    assert.equal(restartedConfig.match(/\[memory\]/g)?.length, 1)
    assert.equal(restartedConfig.match(/\[ui\]/g)?.length, 1)
    await manager.stopActive()
    assert.equal(manager.status(project.id).state, 'stopped')
    assert.equal(existsSync(leasePath), false)

    const outsideRunnerHome = path.join(temporaryRoot, 'outside-runner-home')
    await mkdir(outsideRunnerHome)
    await rm(path.join(project.rootPath, '.grok'), { recursive: true, force: true })
    await symlink(outsideRunnerHome, path.join(project.rootPath, '.grok'))
    await assert.rejects(() => manager.start(project.id), /.grok 不能是符号链接/)
  } finally {
    await manager.stopAll()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('persists validated runtime metadata and only advances an owned lease heartbeat', async (context) => {
  if (process.platform === 'win32') context.skip('requires POSIX process identity checks')
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-runner-lease-metadata-'))
  const fixturePath = path.join(temporaryRoot, 'runner-fixture.mjs')
  const leaseRoot = path.join(temporaryRoot, 'leases')
  let childPid: number | undefined
  try {
    await writeFile(fixturePath, [
      "process.on('SIGTERM', () => process.exit(0))",
      'setInterval(() => {}, 1_000)',
    ].join('\n'))
    const child = spawn(process.execPath, [fixturePath], { detached: true, stdio: 'ignore' })
    if (!child.pid) throw new Error('fixture did not expose a pid')
    childPid = child.pid
    const owner = createProcessLeaseStore({ leaseRoot, ownerLabel: 'metadata-owner', watchdog: false, heartbeatIntervalMs: 60_000 })
    await owner.ready
    const lease = await owner.claim({
      kind: 'project-runner',
      subjectId: 'metadata-runner',
      pid: childPid,
      processGroup: true,
      runtime: fixtureRuntime(temporaryRoot),
    })
    const leasePath = owner.getLeasePath('project-runner', 'metadata-runner')
    const initial = JSON.parse(await readFile(leasePath, 'utf8')) as { runtime: { heartbeatAt: string; state: string; binaryPath: string; workspaceRealpath: string } }
    assert.equal(initial.runtime.binaryPath, await realpath(process.execPath))
    assert.equal(initial.runtime.workspaceRealpath, await realpath(temporaryRoot))
    assert.equal(initial.runtime.state, 'running')

    await new Promise((resolve) => setTimeout(resolve, 15))
    const heartbeat = await owner.heartbeat(lease)
    assert.equal(heartbeat.status, 'updated')
    const updated = JSON.parse(await readFile(leasePath, 'utf8')) as { runtime: { heartbeatAt: string; state: string } }
    assert.equal(Date.parse(updated.runtime.heartbeatAt) > Date.parse(initial.runtime.heartbeatAt), true)
    assert.equal(updated.runtime.state, 'running')

    const invalidTransition = await owner.heartbeat(lease, { state: 'starting' })
    assert.equal(invalidTransition.status, 'failed')
    await assert.rejects(() => owner.claim({
      kind: 'project-runner',
      subjectId: 'invalid-metadata',
      pid: childPid!,
      processGroup: true,
      runtime: { ...fixtureRuntime(temporaryRoot), port: 0 },
    }), /端口不合法/)

    await owner.stop(lease)
    assert.equal(existsSync(leasePath), false)
  } finally {
    if (childPid) await stopDetachedProcess(childPid)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('reclaims only an exact stale owned Runner lease and leaves an identity mismatch untouched', async (context) => {
  if (process.platform === 'win32') context.skip('requires POSIX process identity checks')
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-runner-lease-recovery-'))
  const fixturePath = path.join(temporaryRoot, 'runner-fixture.mjs')
  await writeFile(fixturePath, [
    "process.on('SIGTERM', () => process.exit(0))",
    'setInterval(() => {}, 1_000)',
  ].join('\n'))
  const leaseRoot = path.join(temporaryRoot, 'leases')
  let stalePid: number | undefined
  let foreignPid: number | undefined
  try {
    const staleChild = spawn(process.execPath, [fixturePath], { detached: true, stdio: 'ignore' })
    if (!staleChild.pid) throw new Error('fixture did not expose a pid')
    stalePid = staleChild.pid
    const staleOwner = createProcessLeaseStore({ leaseRoot, ownerLabel: 'stale-owner', watchdog: false, gracefulShutdownMs: 500 })
    await staleOwner.ready
    const staleLease = await staleOwner.claim({ kind: 'project-runner', subjectId: 'stale-runner', pid: stalePid, processGroup: true, runtime: fixtureRuntime(temporaryRoot) })
    const staleLeasePath = staleOwner.getLeasePath('project-runner', 'stale-runner')
    const activeOwnerRecovery = createProcessLeaseStore({ leaseRoot, ownerLabel: 'second-instance', watchdog: false, gracefulShutdownMs: 500 })
    const activeOwnerResults = await activeOwnerRecovery.ready
    assert.equal(activeOwnerResults.some((entry) => entry.leaseId === staleLease.leaseId && entry.outcome === 'active-owner'), true)
    assert.equal(processExists(stalePid), true)
    const staleRecord = JSON.parse(await readFile(staleLeasePath, 'utf8')) as Record<string, unknown>
    staleRecord.owner = {
      instanceId: 'crashed-owner',
      label: 'crashed-owner',
      pid: 9_999_999,
      identity: { pid: 9_999_999, startedAt: 'Thu Jan 01 00:00:00 1970', commandHash: '0'.repeat(64) },
    }
    await writeFile(staleLeasePath, `${JSON.stringify(staleRecord)}\n`)

    const recovery = createProcessLeaseStore({ leaseRoot, ownerLabel: 'recovery-owner', watchdog: false, gracefulShutdownMs: 500 })
    const recovered = await recovery.ready
    assert.equal(recovered.some((entry) => entry.leaseId === staleLease.leaseId && entry.outcome === 'stopped' && entry.status === 'passed'), true, JSON.stringify(recovered))
    assert.equal(await waitFor(() => !processExists(stalePid!), 2_000), true)
    assert.equal(existsSync(staleLeasePath), false)

    const foreignChild = spawn(process.execPath, [fixturePath], { detached: true, stdio: 'ignore' })
    if (!foreignChild.pid) throw new Error('foreign fixture did not expose a pid')
    foreignPid = foreignChild.pid
    const foreignOwner = createProcessLeaseStore({ leaseRoot, ownerLabel: 'foreign-owner', watchdog: false, gracefulShutdownMs: 500 })
    await foreignOwner.ready
    const foreignLease = await foreignOwner.claim({ kind: 'project-runner', subjectId: 'foreign-runner', pid: foreignPid, processGroup: true, runtime: fixtureRuntime(temporaryRoot, 43_124) })
    const foreignLeasePath = foreignOwner.getLeasePath('project-runner', 'foreign-runner')
    const foreignRecord = JSON.parse(await readFile(foreignLeasePath, 'utf8')) as {
      owner: Record<string, unknown>
      process: { identity: { commandHash: string } }
    }
    const wrongPath = path.join(leaseRoot, 'unexpected.lease.json')
    foreignRecord.owner = {
      instanceId: 'crashed-owner',
      label: 'crashed-owner',
      pid: 9_999_999,
      identity: { pid: 9_999_999, startedAt: 'Thu Jan 01 00:00:00 1970', commandHash: '0'.repeat(64) },
    }
    await writeFile(wrongPath, `${JSON.stringify(foreignRecord)}\n`)
    const wrongPathRecovery = createProcessLeaseStore({ leaseRoot, ownerLabel: 'path-recovery', watchdog: false, gracefulShutdownMs: 500 })
    const wrongPathResults = await wrongPathRecovery.ready
    assert.equal(wrongPathResults.some((entry) => entry.leaseId === foreignLease.leaseId && entry.outcome === 'identity-mismatch'), true)
    assert.equal(processExists(foreignPid), true)
    assert.equal(existsSync(wrongPath), false)

    foreignRecord.owner = JSON.parse(await readFile(foreignLeasePath, 'utf8')).owner
    foreignRecord.process.identity.commandHash = 'f'.repeat(64)
    await writeFile(foreignLeasePath, `${JSON.stringify(foreignRecord)}\n`)

    const mismatchRecovery = createProcessLeaseStore({ leaseRoot, ownerLabel: 'mismatch-recovery', watchdog: false, gracefulShutdownMs: 500 })
    const mismatches = await mismatchRecovery.ready
    assert.equal(mismatches.some((entry) => entry.leaseId === foreignLease.leaseId && entry.outcome === 'identity-mismatch'), true)
    assert.equal(processExists(foreignPid), true)
    assert.equal(existsSync(foreignLeasePath), false)
  } finally {
    if (stalePid) await stopDetachedProcess(stalePid)
    if (foreignPid) await stopDetachedProcess(foreignPid)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('lease guardian stops its exact child after its owner identity disappears', async (context) => {
  if (process.platform === 'win32') context.skip('requires the POSIX lease guardian')
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-runner-guardian-'))
  const fixturePath = path.join(temporaryRoot, 'runner-fixture.mjs')
  await writeFile(fixturePath, [
    "process.on('SIGTERM', () => process.exit(0))",
    'setInterval(() => {}, 1_000)',
  ].join('\n'))
  const leaseRoot = path.join(temporaryRoot, 'leases')
  let childPid: number | undefined
  let leasePath: string | undefined
  try {
    const child = spawn(process.execPath, [fixturePath], { detached: true, stdio: 'ignore' })
    if (!child.pid) throw new Error('fixture did not expose a pid')
    childPid = child.pid
    const owner = createProcessLeaseStore({
      leaseRoot,
      ownerLabel: 'guardian-owner',
      watchdog: true,
      watchdogIntervalMs: 25,
      gracefulShutdownMs: 500,
    })
    await owner.ready
    const lease = await owner.claim({ kind: 'project-runner', subjectId: 'guardian-runner', pid: childPid, processGroup: true, runtime: fixtureRuntime(temporaryRoot) })
    leasePath = owner.getLeasePath('project-runner', 'guardian-runner')
    const record = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>
    record.owner = {
      instanceId: 'lost-owner',
      label: 'lost-owner',
      pid: 9_999_999,
      identity: { pid: 9_999_999, startedAt: 'Thu Jan 01 00:00:00 1970', commandHash: '0'.repeat(64) },
    }
    await writeFile(leasePath, `${JSON.stringify(record)}\n`)

    assert.equal(await waitFor(() => !processExists(childPid!), 3_000), true)
    await owner.release(lease)
    assert.equal(existsSync(leasePath), false)
  } finally {
    if (childPid) await stopDetachedProcess(childPid)
    if (leasePath && existsSync(leasePath)) await rm(leasePath, { force: true })
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('detached guardian reclaims its Runner after an actual owner-process crash', async (context) => {
  if (process.platform === 'win32') context.skip('requires the POSIX lease guardian')
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-runner-owner-crash-'))
  const fixturePath = path.join(temporaryRoot, 'runner-fixture.mjs')
  const ownerScriptPath = path.join(temporaryRoot, 'owner.mjs')
  const readyPath = path.join(temporaryRoot, 'ready.json')
  const leaseRoot = path.join(temporaryRoot, 'leases')
  let ownerPid: number | undefined
  let childPid: number | undefined
  try {
    await writeFile(fixturePath, [
      "process.on('SIGTERM', () => process.exit(0))",
      'setInterval(() => {}, 1_000)',
    ].join('\n'))
    await writeFile(ownerScriptPath, [
      "import { spawn } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      "const { createProcessLeaseStore } = await import(process.env.RUNBUILD_OWNERSHIP_MODULE_URL)",
      "const child = spawn(process.execPath, [process.env.RUNBUILD_FIXTURE_PATH], { detached: true, stdio: 'ignore' })",
      "if (!child.pid) throw new Error('runner fixture did not expose a pid')",
      "const store = createProcessLeaseStore({ leaseRoot: process.env.RUNBUILD_LEASE_ROOT, ownerLabel: 'crash-owner', watchdog: true, watchdogIntervalMs: 25, gracefulShutdownMs: 500 })",
      'await store.ready',
      "const lease = await store.claim({ kind: 'project-runner', subjectId: 'owner-crash-runner', pid: child.pid, processGroup: true, runtime: { port: 43123, binaryPath: process.execPath, workspace: process.env.RUNBUILD_LEASE_ROOT, command: { executable: process.execPath, args: ['fixture'] }, state: 'running' } })",
      "writeFileSync(process.env.RUNBUILD_READY_PATH, JSON.stringify({ ownerPid: process.pid, childPid: child.pid, leaseId: lease.leaseId }))",
      'setInterval(() => {}, 1_000)',
    ].join('\n'))
    const owner = spawn(process.execPath, ['--experimental-strip-types', ownerScriptPath], {
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH,
        RUNBUILD_OWNERSHIP_MODULE_URL: pathToFileURL(path.resolve('runner-ownership.ts')).href,
        RUNBUILD_FIXTURE_PATH: fixturePath,
        RUNBUILD_LEASE_ROOT: leaseRoot,
        RUNBUILD_READY_PATH: readyPath,
      },
    })
    if (!owner.pid) throw new Error('owner fixture did not expose a pid')
    ownerPid = owner.pid
    assert.equal(await waitFor(() => existsSync(readyPath), 3_000), true)
    const ready = JSON.parse(await readFile(readyPath, 'utf8')) as { ownerPid: number; childPid: number; leaseId: string }
    assert.equal(ready.ownerPid, ownerPid)
    childPid = ready.childPid
    assert.equal(processExists(childPid), true)

    process.kill(ownerPid, 'SIGKILL')
    assert.equal(await waitFor(() => !processExists(ownerPid!), 2_000), true)
    assert.equal(await waitFor(() => !processExists(childPid!), 3_000), true)
    assert.equal(ready.leaseId.length > 0, true)
  } finally {
    if (ownerPid && processExists(ownerPid)) {
      try { process.kill(ownerPid, 'SIGKILL') } catch { /* Already gone. */ }
    }
    if (childPid) await stopDetachedProcess(childPid)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('stopAll cancels a pending start before it can spawn a runner', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-runner-stop-'))
  const registry = createProjectRegistry({
    projectsRoot: path.join(temporaryRoot, 'projects'),
    registryPath: path.join(temporaryRoot, 'projects.json'),
  })
  const project = await registry.create({ name: 'Stop Pending Runner', instructions: 'Do not start after shutdown.' })
  const sharedGrokHome = path.join(temporaryRoot, 'grok-home')
  await mkdir(sharedGrokHome, { recursive: true })
  const fixturePath = path.join(temporaryRoot, 'runner-fixture.mjs')
  await writeFile(fixturePath, [
    "import net from 'node:net'",
    "const server = net.createServer(() => {})",
    "server.listen(Number(process.env.PERSONAL_AGENT_PORT), '127.0.0.1')",
    "process.on('SIGTERM', () => server.close(() => process.exit(0)))",
  ].join('\n'))

  const originalList = registry.list
  let releaseList!: () => void
  let markListStarted!: () => void
  const listGate = new Promise<void>((resolve) => { releaseList = resolve })
  const listStarted = new Promise<void>((resolve) => { markListStarted = resolve })
  registry.list = async () => {
    markListStarted()
    await listGate
    return originalList()
  }

  let commandFactoryCalls = 0
  const manager = createProjectRunnerManager({
    registry,
    binaryPath: process.execPath,
    modelProfile: DEFAULT_MODEL_PROFILE,
    grokHome: sharedGrokHome,
    logsRoot: path.join(temporaryRoot, 'logs'),
    commandFactory: () => {
      commandFactoryCalls += 1
      return { command: process.execPath, args: [fixturePath] }
    },
    startupTimeoutMs: 5_000,
  })

  try {
    const starting = manager.start(project.id)
    const startRejection = assert.rejects(starting, /Runner 管理器正在停止/)
    await listStarted
    const stopping = manager.stopAll()
    releaseList()

    await Promise.all([startRejection, stopping])
    assert.equal(commandFactoryCalls, 0)
    assert.equal(manager.status(project.id).state, 'stopped')
    assert.deepEqual(manager.list(), [])
  } finally {
    releaseList()
    await manager.stopAll()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
