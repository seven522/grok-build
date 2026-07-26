const assert = require('node:assert/strict')
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  finalizeBundleSignature,
  localDesignatedRequirement,
  localSigningArguments,
  waitForBundleReady,
} = require('../build/after-sign.cjs')

test('local desktop builds keep a stable RunBuild designated requirement', () => {
  assert.equal(
    localDesignatedRequirement,
    '=designated => identifier "local.personal-agent.desktop"',
  )
  assert.equal(typeof finalizeBundleSignature, 'function')
  assert.deepEqual(localSigningArguments('/tmp/RunBuild.app'), [
    '--force',
    '--deep',
    '--sign',
    '-',
    '--identifier',
    'local.personal-agent.desktop',
    '--requirements',
    '=designated => identifier "local.personal-agent.desktop"',
    '/tmp/RunBuild.app',
  ])
})

test('final signing waits until the packaged app executable and asar are ready', async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-signing-ready-'))
  const appPath = path.join(temporaryRoot, 'RunBuild.app')
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }))

  const ready = waitForBundleReady(appPath, { timeoutMs: 1_000, intervalMs: 10 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await mkdir(path.join(appPath, 'Contents', 'MacOS'), { recursive: true })
  await mkdir(path.join(appPath, 'Contents', 'Resources'), { recursive: true })
  await writeFile(path.join(appPath, 'Contents', 'MacOS', 'RunBuild'), 'executable')
  await writeFile(path.join(appPath, 'Contents', 'Resources', 'app.asar'), 'archive')

  await ready
})
