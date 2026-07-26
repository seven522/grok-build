import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_MODEL_PROFILE } from '../model-profile.ts'
import {
  configWithSafeAccessDefaults,
  ensureRuntimeConfig,
  inspectRuntimeModelAvailability,
  startAgentRuntime,
} from './agent-runtime.ts'
import { inspectLocalProcess } from '../runner-ownership.ts'

const processExists = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('reports stable model availability from login state and explicitly configured credentials', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-model-availability-'))
  const grokHome = path.join(temporaryRoot, 'runtime')
  const cliAuthPath = path.join(temporaryRoot, 'cli-auth.json')
  const envPath = path.join(temporaryRoot, 'providers.env')
  await mkdir(grokHome, { recursive: true })
  await writeFile(envPath, [
    'XAI_API_KEY=xai-from-explicit-env-file',
    'MIMO_API_KEY=from-explicit-env-file',
    'DEEPSEEK_API_KEY="deepseek-from-explicit-env-file"',
    'IGNORED_SECRET=must-not-be-read',
  ].join('\n'))

  try {
    assert.deepEqual(inspectRuntimeModelAvailability(grokHome, {
      XAI_API_KEY: '   ',
      MIMO_API_KEY: 'direct-mimo-key',
      DEEPSEEK_API_KEY: '',
    }), [
      { id: 'grok-4.5', available: false, reason: 'login-required' },
      { id: 'mimo', available: true },
      { id: 'deepseek-v4-pro', available: false, reason: 'credential-missing' },
    ])

    const availability = inspectRuntimeModelAvailability(grokHome, { UNI_ENV_FILE: envPath })
    assert.deepEqual(availability, [
      { id: 'grok-4.5', available: true },
      { id: 'mimo', available: true },
      { id: 'deepseek-v4-pro', available: true },
    ])
    assert.doesNotMatch(JSON.stringify(availability), /from-explicit-env-file|direct-mimo-key|IGNORED_SECRET/)

    await writeFile(cliAuthPath, '{}\n')
    assert.equal(inspectRuntimeModelAvailability(grokHome, { GROK_AUTH_PATH: cliAuthPath })[0]?.available, false)
    await writeFile(cliAuthPath, '{"xai":{"key":"test-session"}}\n')
    assert.deepEqual(inspectRuntimeModelAvailability(grokHome, { GROK_AUTH_PATH: cliAuthPath }), [
      { id: 'grok-4.5', available: true },
      { id: 'mimo', available: false, reason: 'credential-missing' },
      { id: 'deepseek-v4-pro', available: false, reason: 'credential-missing' },
    ])

    await writeFile(path.join(grokHome, 'auth.json'), '{"xai":{"key":"test-session"}}\n')
    assert.deepEqual(inspectRuntimeModelAvailability(grokHome, {}), [
      { id: 'grok-4.5', available: true },
      { id: 'mimo', available: false, reason: 'credential-missing' },
      { id: 'deepseek-v4-pro', available: false, reason: 'credential-missing' },
    ])
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('returns availability when the requested startup profile credential is missing', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-agent-credential-'))
  const workspace = path.join(temporaryRoot, 'workspace')
  const grokHome = path.join(temporaryRoot, 'runtime')
  const fixturePath = path.join(temporaryRoot, 'unused-agent-fixture')
  await mkdir(workspace, { recursive: true })
  await mkdir(grokHome, { recursive: true })
  await writeFile(fixturePath, '')
  const previousEnvFile = process.env.UNI_ENV_FILE
  const previousXaiKey = process.env.XAI_API_KEY
  const previousMimoKey = process.env.MIMO_API_KEY
  const previousDeepseekKey = process.env.DEEPSEEK_API_KEY
  delete process.env.UNI_ENV_FILE
  delete process.env.XAI_API_KEY
  delete process.env.MIMO_API_KEY
  delete process.env.DEEPSEEK_API_KEY

  try {
    const runtime = await startAgentRuntime({
      binaryPath: fixturePath,
      workspace,
      grokHome,
      modelProfile: 'deepseek-v4-pro',
    })
    assert.match(runtime.error ?? '', /DEEPSEEK_API_KEY/)
    assert.deepEqual(runtime.modelAvailability, [
      { id: 'grok-4.5', available: false, reason: 'login-required' },
      { id: 'mimo', available: false, reason: 'credential-missing' },
      { id: 'deepseek-v4-pro', available: false, reason: 'credential-missing' },
    ])
  } finally {
    if (previousEnvFile === undefined) delete process.env.UNI_ENV_FILE
    else process.env.UNI_ENV_FILE = previousEnvFile
    if (previousXaiKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousXaiKey
    if (previousMimoKey === undefined) delete process.env.MIMO_API_KEY
    else process.env.MIMO_API_KEY = previousMimoKey
    if (previousDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previousDeepseekKey
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('starts the root Agent with Grok 4.5 and stops its process on shutdown', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-agent-runtime-'))
  const workspace = path.join(temporaryRoot, 'workspace')
  const grokHome = path.join(temporaryRoot, 'runtime')
  const cliAuthPath = path.join(temporaryRoot, 'cli-auth.json')
  const statePath = path.join(temporaryRoot, 'agent-state.json')
  const envPath = path.join(temporaryRoot, 'foreign.env')
  const fixturePath = path.join(temporaryRoot, 'agent-fixture.mjs')
  const previousStatePath = process.env.AGENT_RUNTIME_TEST_STATE
  const previousEnvFile = process.env.UNI_ENV_FILE
  const previousMimoKey = process.env.MIMO_API_KEY
  const previousDeepseekKey = process.env.DEEPSEEK_API_KEY
  await writeFile(envPath, [
    'MIMO_API_KEY=load-into-child-only',
    'DEEPSEEK_API_KEY=also-load-into-child-only',
  ].join('\n'))
  await writeFile(fixturePath, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs'",
    "import net from 'node:net'",
    'const args = process.argv.slice(2)',
    "const bindIndex = args.indexOf('--bind')",
    "const port = Number(args[bindIndex + 1].split(':').at(-1))",
    'const statePath = process.env.AGENT_RUNTIME_TEST_STATE',
    "if (!statePath || !port) throw new Error('fixture configuration missing')",
    'const writeState = (phase) => fs.writeFileSync(statePath, JSON.stringify({ args, cwd: process.cwd(), phase, pid: process.pid, hasMimoKey: Boolean(process.env.MIMO_API_KEY), hasDeepseekKey: Boolean(process.env.DEEPSEEK_API_KEY), authPath: process.env.GROK_AUTH_PATH ?? null }))',
    'const server = net.createServer(() => {})',
    "server.listen(port, '127.0.0.1', () => writeState('listening'))",
    "process.on('SIGTERM', () => server.close(() => { writeState('stopped'); process.exit(0) }))",
  ].join('\n'))
  await chmod(fixturePath, 0o700)
  await mkdir(workspace, { recursive: true })
  await mkdir(grokHome, { recursive: true })

  process.env.AGENT_RUNTIME_TEST_STATE = statePath
  process.env.UNI_ENV_FILE = envPath
  delete process.env.MIMO_API_KEY
  delete process.env.DEEPSEEK_API_KEY

  let runtime: Awaited<ReturnType<typeof startAgentRuntime>> | null = null
  try {
    await writeFile(cliAuthPath, '{"xai":{"key":"test-session"}}\n')
    await writeFile(path.join(grokHome, 'config.toml'), '[models]\ndefault = "mimo"\n\n[custom]\nkeep = true\n\n[ui]\npermission_mode = "always-approve"\nyolo = true\n')
    ensureRuntimeConfig(grokHome, DEFAULT_MODEL_PROFILE)
    const config = await readFile(path.join(grokHome, 'config.toml'), 'utf8')
    assert.match(config, /\[models\]\ndefault = "grok-4\.5"/)
    assert.match(config, /\[custom\]\nkeep = true/)
    assert.match(config, /\[ui\]\npermission_mode = "always-approve"\nyolo = false/)
    assert.equal(configWithSafeAccessDefaults(config), config)

    runtime = await startAgentRuntime({
      binaryPath: fixturePath,
      workspace,
      grokHome,
      modelProfile: DEFAULT_MODEL_PROFILE,
      authFallbackPaths: [cliAuthPath],
    })
    assert.equal(runtime.error, undefined)
    assert.ok(runtime.connection)
    assert.deepEqual(runtime.modelAvailability, [
      { id: 'grok-4.5', available: true },
      { id: 'mimo', available: true },
      { id: 'deepseek-v4-pro', available: true },
    ])
    assert.equal(process.env.MIMO_API_KEY, undefined)
    assert.equal(process.env.DEEPSEEK_API_KEY, undefined)

    const state = JSON.parse(await readFile(statePath, 'utf8')) as { args: string[]; cwd: string; phase: string; pid: number; hasMimoKey: boolean; hasDeepseekKey: boolean; authPath: string | null }
    assert.deepEqual(state.args.slice(0, 9), ['--sandbox', 'off', '--always-approve', '--permission-mode', 'default', '--model', 'grok-4.5', 'agent', 'serve'])
    assert.match(state.args[10] ?? '', /^127\.0\.0\.1:\d+$/)
    assert.equal(await realpath(state.cwd), await realpath(workspace))
    assert.equal(state.phase, 'listening')
    assert.equal(state.hasMimoKey, true)
    assert.equal(state.hasDeepseekKey, true)
    assert.equal(state.authPath, cliAuthPath)
    assert.equal(processExists(state.pid), true)
    const leasePath = path.join(grokHome, 'leases', 'desktop-agent--root-agent.lease.json')
    assert.equal(existsSync(leasePath), true)
    const lease = JSON.parse(await readFile(leasePath, 'utf8')) as {
      process?: { pid?: number; identity?: { commandHash?: string } }
      runtime?: {
        port?: number
        binaryPath?: string
        commandHash?: string
        workspaceRealpath?: string
        startedAt?: string
        heartbeatAt?: string
        state?: string
      }
    }
    assert.equal(lease.process?.pid, state.pid)
    assert.match(lease.runtime?.port ? `127.0.0.1:${lease.runtime.port}` : '', /^127\.0\.0\.1:\d+$/)
    assert.equal(lease.runtime?.binaryPath, await realpath(fixturePath))
    assert.equal(lease.runtime?.workspaceRealpath, await realpath(workspace))
    assert.match(lease.runtime?.commandHash ?? '', /^[a-f0-9]{64}$/)
    assert.equal(lease.runtime?.state, 'running')
    assert.equal(Number.isNaN(Date.parse(lease.runtime?.startedAt ?? '')), false)
    assert.equal(Number.isNaN(Date.parse(lease.runtime?.heartbeatAt ?? '')), false)
    assert.equal((await readFile(leasePath, 'utf8')).includes('GROK_AGENT_SECRET'), false)
    const liveProcess = await inspectLocalProcess(state.pid)
    assert.equal(liveProcess.state, 'present')
    if (liveProcess.state === 'present') assert.equal(liveProcess.identity.commandHash, lease.process?.identity?.commandHash)

    await runtime.stop()
    assert.equal(processExists(state.pid), false)
    assert.equal(existsSync(leasePath), false)
    const stopped = JSON.parse(await readFile(statePath, 'utf8')) as { phase: string }
    assert.equal(stopped.phase, 'stopped')
  } finally {
    await runtime?.stop()
    if (previousStatePath === undefined) delete process.env.AGENT_RUNTIME_TEST_STATE
    else process.env.AGENT_RUNTIME_TEST_STATE = previousStatePath
    if (previousEnvFile === undefined) delete process.env.UNI_ENV_FILE
    else process.env.UNI_ENV_FILE = previousEnvFile
    if (previousMimoKey === undefined) delete process.env.MIMO_API_KEY
    else process.env.MIMO_API_KEY = previousMimoKey
    if (previousDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previousDeepseekKey
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
