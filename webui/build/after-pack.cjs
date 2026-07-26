const fs = require('node:fs/promises')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const plist = require('plist')

const ALLOWED_PRIVACY_USAGE_KEYS = new Set(['NSMicrophoneUsageDescription'])

const shaPattern = /^[0-9a-f]{40}$/i

function createSourceProvenance({ packageVersion, sourceRevision, gitCommit, sourceDirty }) {
  if (typeof packageVersion !== 'string' || !packageVersion.trim()) throw new Error('RunBuild package version is required for provenance')
  if (!shaPattern.test(sourceRevision ?? '')) throw new Error('SOURCE_REV must contain a 40-character commit SHA')
  if (!shaPattern.test(gitCommit ?? '')) throw new Error('Current Git commit must contain a 40-character SHA')
  return {
    schemaVersion: 1,
    packageVersion: packageVersion.trim(),
    sourceRevision: sourceRevision.trim(),
    gitCommit: gitCommit.trim(),
    sourceDirty: Boolean(sourceDirty),
  }
}

function gitValue(sourceRoot, args) {
  try {
    return execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

async function loadSourceProvenance(context) {
  const projectDir = context.packager?.projectDir
  if (!projectDir) throw new Error('Electron package context is missing projectDir for provenance')
  const sourceRoot = path.resolve(projectDir, '..')
  const sourceRevisionPath = path.join(sourceRoot, 'SOURCE_REV')
  let sourceRevision = ''
  try { sourceRevision = (await fs.readFile(sourceRevisionPath, 'utf8')).trim() } catch {
    throw new Error(`RunBuild source provenance is missing ${sourceRevisionPath}`)
  }
  return createSourceProvenance({
    packageVersion: context.packager.appInfo.version,
    sourceRevision,
    gitCommit: gitValue(sourceRoot, ['rev-parse', 'HEAD']),
    sourceDirty: Boolean(gitValue(sourceRoot, ['status', '--porcelain'])),
  })
}

function applySourceProvenance(info, provenance) {
  info.RunBuildProvenanceSchemaVersion = String(provenance.schemaVersion)
  info.RunBuildPackageVersion = provenance.packageVersion
  info.RunBuildSourceRevision = provenance.sourceRevision
  info.RunBuildGitCommit = provenance.gitCommit
  info.RunBuildSourceDirty = provenance.sourceDirty
  return info
}

function stripUnusedPrivacyUsageDescriptions(info) {
  for (const key of Object.keys(info)) {
    if (/^NS.*UsageDescription$/.test(key) && !ALLOWED_PRIVACY_USAGE_KEYS.has(key)) delete info[key]
  }
  return info
}

function unexpectedPrivacyUsageKeys(info) {
  return Object.keys(info).filter((key) => /^NS.*UsageDescription$/.test(key) && !ALLOWED_PRIVACY_USAGE_KEYS.has(key))
}

function restrictTransportSecurity(info) {
  info.NSAppTransportSecurity = {
    NSAllowsArbitraryLoads: false,
    NSAllowsLocalNetworking: true,
    NSExceptionDomains: {
      localhost: {
        NSExceptionAllowsInsecureHTTPLoads: true,
        NSIncludesSubdomains: false,
      },
      '127.0.0.1': {
        NSExceptionAllowsInsecureHTTPLoads: true,
        NSIncludesSubdomains: false,
      },
    },
  }
  return info
}

function unsafeTransportSecurityEntries(info) {
  const transport = info.NSAppTransportSecurity
  if (!transport || typeof transport !== 'object') return []
  const unsafe = []
  for (const key of [
    'NSAllowsArbitraryLoads',
    'NSAllowsArbitraryLoadsForMedia',
    'NSAllowsArbitraryLoadsInWebContent',
    'NSAllowsArbitraryLoadsForLocalNetworking',
  ]) {
    if (transport[key] === true) unsafe.push(key)
  }
  const exceptionDomains = transport.NSExceptionDomains
  if (exceptionDomains && typeof exceptionDomains === 'object') {
    for (const domain of Object.keys(exceptionDomains)) {
      if (domain !== 'localhost' && domain !== '127.0.0.1') unsafe.push(`NSExceptionDomains.${domain}`)
    }
  }
  return unsafe
}

async function findBundleInfoPlists(root) {
  const found = []
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(entryPath)
      else if (entry.isFile() && entry.name === 'Info.plist' && path.basename(path.dirname(entryPath)) === 'Contents') found.push(entryPath)
    }
  }
  await visit(root)
  return found
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  const mainInfoPath = path.join(appPath, 'Contents', 'Info.plist')
  const provenance = await loadSourceProvenance(context)
  for (const infoPath of await findBundleInfoPlists(appPath)) {
    const info = plist.parse(await fs.readFile(infoPath, 'utf8'))
    if (infoPath !== mainInfoPath) {
      const unexpectedKeys = unexpectedPrivacyUsageKeys(info)
      if (unexpectedKeys.length) throw new Error(`Unexpected privacy usage descriptions in ${infoPath}: ${unexpectedKeys.join(', ')}`)
      const unsafeTransport = unsafeTransportSecurityEntries(info)
      if (unsafeTransport.length) throw new Error(`Unexpected transport security exceptions in ${infoPath}: ${unsafeTransport.join(', ')}`)
      continue
    }
    stripUnusedPrivacyUsageDescriptions(info)
    restrictTransportSecurity(info)
    applySourceProvenance(info, provenance)
    await fs.writeFile(infoPath, plist.build(info))
  }
}

module.exports = afterPack
module.exports.stripUnusedPrivacyUsageDescriptions = stripUnusedPrivacyUsageDescriptions
module.exports.restrictTransportSecurity = restrictTransportSecurity
module.exports.unexpectedPrivacyUsageKeys = unexpectedPrivacyUsageKeys
module.exports.unsafeTransportSecurityEntries = unsafeTransportSecurityEntries
module.exports.createSourceProvenance = createSourceProvenance
module.exports.loadSourceProvenance = loadSourceProvenance
module.exports.applySourceProvenance = applySourceProvenance
