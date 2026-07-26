import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ChildProcess } from 'node:child_process'
import {
  createXaiOAuthLoginEnvironment,
  runCliOAuthLogin,
  type LoginProcessSpawner,
} from './auth-runtime.ts'

class FakeLoginProcess extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killedWith: NodeJS.Signals | null = null

  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.killedWith = signal
    this.signalCode = signal
    queueMicrotask(() => this.emit('exit', null, signal))
    return true
  }
}

test('OAuth login receives only the staged app auth path and no provider credentials', () => {
  const environment = createXaiOAuthLoginEnvironment('/tmp/runbuild-auth-home', '/tmp/runbuild-auth-attempt/auth.json', {
    PATH: '/usr/bin',
    GROK_HOME: '/tmp/old-home',
    GROK_AUTH: '{"key":"secret"}',
    GROK_AUTH_PATH: '/tmp/foreign-auth.json',
    XAI_API_KEY: 'xai-secret',
    MIMO_API_KEY: 'mimo-secret',
    DEEPSEEK_API_KEY: 'deepseek-secret',
    UNI_ENV_FILE: '/tmp/providers.env',
    PERSONAL_AGENT_BRIDGE_SECRET: 'bridge-secret',
  })

  assert.equal(environment.GROK_HOME, '/tmp/runbuild-auth-home')
  assert.equal(environment.GROK_AUTH_PATH, '/tmp/runbuild-auth-attempt/auth.json')
  assert.equal(environment.PATH, '/usr/bin')
  for (const key of [
    'GROK_AUTH',
    'XAI_API_KEY',
    'MIMO_API_KEY',
    'DEEPSEEK_API_KEY',
    'UNI_ENV_FILE',
    'PERSONAL_AGENT_BRIDGE_SECRET',
  ]) assert.equal(environment[key], undefined)
})

test('runs the bundled CLI OAuth command and atomically promotes staged credentials after a zero exit', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-auth-runtime-'))
  const grokHome = path.join(temporaryRoot, 'runtime')
  const authPath = path.join(grokHome, 'auth.json')
  const child = new FakeLoginProcess()
  const invocations: Array<{ command: string; args: string[]; cwd: string; grokHome?: string; authPath?: string }> = []
  const spawnProcess: LoginProcessSpawner = (command, args, options) => {
    invocations.push({ command, args, cwd: options.cwd, grokHome: options.env.GROK_HOME, authPath: options.env.GROK_AUTH_PATH })
    void writeFile(options.env.GROK_AUTH_PATH!, '{"xai":{"key":"new-token"}}', { mode: 0o600 }).then(() => {
      child.exitCode = 0
      child.emit('exit', 0, null)
    })
    return child as unknown as ChildProcess
  }

  try {
    let previousAuthBeforeCommit = ''
    await mkdir(grokHome, { recursive: true })
    await writeFile(authPath, '{"xai":{"key":"old-token"},"xai::api_key":{"key":"keep-api-key"},"https://accounts.x.ai/sign-in":{"key":"legacy-token"}}', { mode: 0o600 })
    await runCliOAuthLogin({
      binaryPath: '/Applications/RunBuild.app/Contents/Resources/bin/xai-grok-pager',
      workspace: temporaryRoot,
      grokHome,
      spawnProcess,
      beforeCommit: async () => { previousAuthBeforeCommit = await readFile(authPath, 'utf8') },
    })
    assert.equal(invocations.length, 1)
    const invocation = invocations[0]!
    assert.equal(invocation.command, '/Applications/RunBuild.app/Contents/Resources/bin/xai-grok-pager')
    assert.deepEqual(invocation.args, ['login', '--oauth'])
    assert.equal(invocation.cwd, temporaryRoot)
    assert.equal(invocation.grokHome?.startsWith(path.join(grokHome, '.auth-login-')), true)
    assert.equal(invocation.authPath, path.join(invocation.grokHome ?? '', 'auth.json'))
    assert.match(previousAuthBeforeCommit, /old-token/)
    assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), {
      xai: { key: 'new-token' },
      'xai::api_key': { key: 'keep-api-key' },
    })
    assert.equal((await stat(authPath)).mode & 0o777, 0o600)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('cancelling OAuth login terminates the CLI and returns a stable public error', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-auth-cancel-'))
  const grokHome = path.join(temporaryRoot, 'runtime')
  const authPath = path.join(grokHome, 'auth.json')
  const child = new FakeLoginProcess()
  const controller = new AbortController()
  const spawnProcess: LoginProcessSpawner = () => child as unknown as ChildProcess

  try {
    await mkdir(grokHome, { recursive: true })
    await writeFile(authPath, '{"xai":{"key":"old-token"}}', { mode: 0o600 })
    const login = runCliOAuthLogin({
      binaryPath: '/tmp/grok',
      workspace: temporaryRoot,
      grokHome,
      signal: controller.signal,
      spawnProcess,
    })
    controller.abort()
    await assert.rejects(login, /^Error: xAI 登录已取消$/)
    assert.equal(child.killedWith, 'SIGTERM')
    assert.equal(await readFile(authPath, 'utf8'), '{"xai":{"key":"old-token"}}')
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('does not expose CLI stderr or auth URLs through a failed login result', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-auth-failure-'))
  const child = new FakeLoginProcess()
  const spawnProcess: LoginProcessSpawner = () => child as unknown as ChildProcess

  try {
    const login = runCliOAuthLogin({
      binaryPath: '/tmp/grok',
      workspace: temporaryRoot,
      grokHome: path.join(temporaryRoot, 'runtime'),
      spawnProcess,
    })
    child.exitCode = 1
    child.emit('exit', 1, null)
    await assert.rejects(login, (error: Error) => {
      assert.equal(error.message, 'xAI 登录未完成，请重试')
      assert.doesNotMatch(error.message, /https?:|token|code=/i)
      return true
    })
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('rejects a zero exit without a credential before stopping the active runtime', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-auth-empty-'))
  const child = new FakeLoginProcess()
  let beforeCommitCalls = 0
  const spawnProcess: LoginProcessSpawner = (_command, _args, options) => {
    void writeFile(options.env.GROK_AUTH_PATH!, '{}\n', { mode: 0o600 }).then(() => {
      child.exitCode = 0
      child.emit('exit', 0, null)
    })
    return child as unknown as ChildProcess
  }

  try {
    await assert.rejects(runCliOAuthLogin({
      binaryPath: '/tmp/grok',
      workspace: temporaryRoot,
      grokHome: path.join(temporaryRoot, 'runtime'),
      spawnProcess,
      beforeCommit: () => { beforeCommitCalls += 1 },
    }), /^Error: xAI 登录未完成，请重试$/)
    assert.equal(beforeCommitCalls, 0)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('an abort during commit keeps the previous credential unchanged', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-auth-commit-cancel-'))
  const grokHome = path.join(temporaryRoot, 'runtime')
  const authPath = path.join(grokHome, 'auth.json')
  const child = new FakeLoginProcess()
  const controller = new AbortController()
  const spawnProcess: LoginProcessSpawner = (_command, _args, options) => {
    void writeFile(options.env.GROK_AUTH_PATH!, '{"xai":{"key":"new-token"}}', { mode: 0o600 }).then(() => {
      child.exitCode = 0
      child.emit('exit', 0, null)
    })
    return child as unknown as ChildProcess
  }

  try {
    await mkdir(grokHome, { recursive: true })
    await writeFile(authPath, '{"xai":{"key":"old-token"}}', { mode: 0o600 })
    await assert.rejects(runCliOAuthLogin({
      binaryPath: '/tmp/grok',
      workspace: temporaryRoot,
      grokHome,
      signal: controller.signal,
      spawnProcess,
      beforeCommit: () => controller.abort(),
    }), /^Error: xAI 登录已取消$/)
    assert.equal(await readFile(authPath, 'utf8'), '{"xai":{"key":"old-token"}}')
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('credential save failures do not expose auth paths', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-auth-save-failure-'))
  const grokHome = path.join(temporaryRoot, 'runtime')
  const targetPath = path.join(temporaryRoot, 'foreign-auth.json')
  const child = new FakeLoginProcess()
  const spawnProcess: LoginProcessSpawner = (_command, _args, options) => {
    void writeFile(options.env.GROK_AUTH_PATH!, '{"xai":{"key":"new-token"}}', { mode: 0o600 }).then(() => {
      child.exitCode = 0
      child.emit('exit', 0, null)
    })
    return child as unknown as ChildProcess
  }

  try {
    await mkdir(grokHome, { recursive: true })
    await writeFile(targetPath, '{"xai":{"key":"old-token"}}', { mode: 0o600 })
    await symlink(targetPath, path.join(grokHome, 'auth.json'))
    await assert.rejects(runCliOAuthLogin({
      binaryPath: '/tmp/grok',
      workspace: temporaryRoot,
      grokHome,
      spawnProcess,
    }), (error: Error) => {
      assert.equal(error.message, 'xAI 登录凭据无法安全保存，请重试')
      assert.doesNotMatch(error.message, new RegExp(temporaryRoot))
      return true
    })
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
