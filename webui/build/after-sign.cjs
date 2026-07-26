const { execFile } = require('node:child_process')
const { stat } = require('node:fs/promises')
const path = require('node:path')
const { promisify } = require('node:util')
const { setTimeout: delay } = require('node:timers/promises')

const execFileAsync = promisify(execFile)
const localBundleIdentifier = 'local.personal-agent.desktop'
const localDesignatedRequirement = `=designated => identifier "${localBundleIdentifier}"`

function localSigningArguments(appPath) {
  return [
    '--force',
    '--deep',
    '--sign',
    '-',
    '--identifier',
    localBundleIdentifier,
    '--requirements',
    localDesignatedRequirement,
    appPath,
  ]
}

async function verifyBundle(appPath) {
  await execFileAsync('codesign', ['--verify', '--deep', '--strict', appPath])
}

async function waitForBundleReady(appPath, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  const executableName = path.basename(appPath, '.app')
  const requiredPaths = [
    path.join(appPath, 'Contents', 'MacOS', executableName),
    path.join(appPath, 'Contents', 'Resources', 'app.asar'),
  ]
  const deadline = Date.now() + timeoutMs
  let previousSnapshot = null
  while (Date.now() < deadline) {
    try {
      const stats = await Promise.all(requiredPaths.map((requiredPath) => stat(requiredPath)))
      const snapshot = stats.map(({ size, mtimeMs }) => `${size}:${mtimeMs}`).join('|')
      if (stats.every(({ size }) => size > 0) && snapshot === previousSnapshot) return
      previousSnapshot = snapshot
    } catch {
      previousSnapshot = null
    }
    await delay(intervalMs)
  }
  throw new Error(`Packaged app did not become ready for signing: ${appPath}`)
}

async function finalizeBundleSignature(appPath) {
  await waitForBundleReady(appPath)
  if (!process.env.CSC_LINK && !process.env.CSC_NAME) {
    await execFileAsync('codesign', localSigningArguments(appPath))
  }
  await verifyBundle(appPath)
}

async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  await finalizeBundleSignature(appPath)
}

module.exports = afterSign
module.exports.verifyBundle = verifyBundle
module.exports.finalizeBundleSignature = finalizeBundleSignature
module.exports.waitForBundleReady = waitForBundleReady
module.exports.localDesignatedRequirement = localDesignatedRequirement
module.exports.localSigningArguments = localSigningArguments

if (require.main === module) {
  const appPath = process.argv[2]
  if (!appPath) {
    process.stderr.write('Usage: node build/after-sign.cjs <RunBuild.app>\n')
    process.exitCode = 2
  } else {
    finalizeBundleSignature(path.resolve(appPath)).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
  }
}
