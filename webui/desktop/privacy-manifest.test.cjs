const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const plist = require('plist')
const afterPack = require('../build/after-pack.cjs')

const packagingContext = (appOutDir) => ({
  electronPlatformName: 'darwin',
  appOutDir,
  packager: {
    projectDir: path.join(__dirname, '..'),
    appInfo: { productFilename: 'RunBuild', version: '0.1.0' },
  },
})

test('desktop packaging records source provenance in the signed bundle metadata', () => {
  const provenance = afterPack.createSourceProvenance({
    packageVersion: '0.1.0',
    sourceRevision: 'c5c4ce03436b4bb2cec43d3feaa27dee0109bf37',
    gitCommit: 'a881e67f6d7f4d46e770843d9b80a877529ed43f',
    sourceDirty: true,
  })
  const info = afterPack.applySourceProvenance({ CFBundleName: 'RunBuild' }, provenance)

  assert.deepEqual(provenance, {
    schemaVersion: 1,
    packageVersion: '0.1.0',
    sourceRevision: 'c5c4ce03436b4bb2cec43d3feaa27dee0109bf37',
    gitCommit: 'a881e67f6d7f4d46e770843d9b80a877529ed43f',
    sourceDirty: true,
  })
  assert.equal(info.RunBuildProvenanceSchemaVersion, '1')
  assert.equal(info.RunBuildPackageVersion, '0.1.0')
  assert.equal(info.RunBuildSourceRevision, provenance.sourceRevision)
  assert.equal(info.RunBuildGitCommit, provenance.gitCommit)
  assert.equal(info.RunBuildSourceDirty, true)
})

test('desktop packaging never embeds a developer auth path', () => {
  const builderConfig = readFileSync(path.join(__dirname, '..', 'electron-builder.config.cjs'), 'utf8')
  const runScript = readFileSync(path.join(__dirname, '..', '..', 'run'), 'utf8')
  assert.doesNotMatch(builderConfig, /PERSONAL_AGENT_PACK_AUTH_PATH|runBuild\s*:\s*\{\s*authPath/)
  assert.doesNotMatch(runScript, /PERSONAL_AGENT_PACK_AUTH_PATH/)
})

test('macOS package declares only the system permission RunBuild uses', async (context) => {
  const appOutDir = mkdtempSync(path.join(os.tmpdir(), 'grok-build-privacy-manifest-'))
  const infoDir = path.join(appOutDir, 'RunBuild.app', 'Contents')
  const infoPath = path.join(infoDir, 'Info.plist')
  const helperInfoDir = path.join(infoDir, 'Frameworks', 'RunBuild Helper.app', 'Contents')
  const helperInfoPath = path.join(helperInfoDir, 'Info.plist')
  mkdirSync(infoDir, { recursive: true })
  mkdirSync(helperInfoDir, { recursive: true })
  writeFileSync(infoPath, plist.build({
    CFBundleName: 'RunBuild',
    NSMicrophoneUsageDescription: '仅在主动使用语音输入时访问麦克风。',
    NSAudioCaptureUsageDescription: 'Electron default',
    NSBluetoothAlwaysUsageDescription: 'Electron default',
    NSBluetoothPeripheralUsageDescription: 'Electron default',
    NSCameraUsageDescription: 'Electron default',
    NSLocationWhenInUseUsageDescription: 'Unexpected future permission',
    NSAppleEventsUsageDescription: 'Unexpected future permission',
    NSPhotoLibraryUsageDescription: 'Unexpected future permission',
    NSScreenCaptureUsageDescription: 'Unexpected future permission',
    NSAppTransportSecurity: {
      NSAllowsArbitraryLoads: true,
      NSAllowsArbitraryLoadsForMedia: true,
      NSAllowsArbitraryLoadsInWebContent: true,
      NSExceptionDomains: { 'example.com': { NSExceptionAllowsInsecureHTTPLoads: true } },
    },
  }))
  writeFileSync(helperInfoPath, plist.build({
    CFBundleName: 'RunBuild Helper',
  }))
  context.after(() => rmSync(appOutDir, { recursive: true, force: true }))

  await afterPack(packagingContext(appOutDir))

  const info = plist.parse(readFileSync(infoPath, 'utf8'))
  assert.equal(info.CFBundleName, 'RunBuild')
  assert.match(info.NSMicrophoneUsageDescription, /麦克风/)
  assert.equal(info.NSAudioCaptureUsageDescription, undefined)
  assert.equal(info.NSBluetoothAlwaysUsageDescription, undefined)
  assert.equal(info.NSBluetoothPeripheralUsageDescription, undefined)
  assert.equal(info.NSCameraUsageDescription, undefined)
  assert.equal(info.NSLocationWhenInUseUsageDescription, undefined)
  assert.equal(info.NSAppleEventsUsageDescription, undefined)
  assert.equal(info.NSPhotoLibraryUsageDescription, undefined)
  assert.equal(info.NSScreenCaptureUsageDescription, undefined)
  assert.equal(info.NSAppTransportSecurity.NSAllowsArbitraryLoads, false)
  assert.equal(info.NSAppTransportSecurity.NSAllowsArbitraryLoadsForMedia, undefined)
  assert.equal(info.NSAppTransportSecurity.NSAllowsArbitraryLoadsInWebContent, undefined)
  assert.equal(info.NSAppTransportSecurity.NSAllowsLocalNetworking, true)
  assert.equal(info.NSAppTransportSecurity.NSExceptionDomains['example.com'], undefined)
  assert.equal(info.NSAppTransportSecurity.NSExceptionDomains.localhost.NSExceptionAllowsInsecureHTTPLoads, true)
  assert.equal(info.NSAppTransportSecurity.NSExceptionDomains['127.0.0.1'].NSExceptionAllowsInsecureHTTPLoads, true)
  assert.match(info.RunBuildSourceRevision, /^[0-9a-f]{40}$/)
  assert.match(info.RunBuildGitCommit, /^[0-9a-f]{40}$/)
  assert.equal(info.RunBuildPackageVersion, '0.1.0')

  const helperInfo = plist.parse(readFileSync(helperInfoPath, 'utf8'))
  assert.equal(helperInfo.NSCameraUsageDescription, undefined)
  assert.equal(helperInfo.NSPhotoLibraryUsageDescription, undefined)
  assert.equal(helperInfo.NSAppTransportSecurity, undefined)
})

test('macOS package fails closed if a helper bundle adds another permission declaration', async (context) => {
  const appOutDir = mkdtempSync(path.join(os.tmpdir(), 'grok-build-helper-privacy-manifest-'))
  const infoDir = path.join(appOutDir, 'RunBuild.app', 'Contents')
  const helperInfoDir = path.join(infoDir, 'Frameworks', 'RunBuild Helper.app', 'Contents')
  mkdirSync(helperInfoDir, { recursive: true })
  writeFileSync(path.join(infoDir, 'Info.plist'), plist.build({
    CFBundleName: 'RunBuild',
    NSMicrophoneUsageDescription: '仅在主动使用语音输入时访问麦克风。',
  }))
  writeFileSync(path.join(helperInfoDir, 'Info.plist'), plist.build({
    CFBundleName: 'RunBuild Helper',
    NSCameraUsageDescription: 'Unexpected helper permission',
  }))
  context.after(() => rmSync(appOutDir, { recursive: true, force: true }))

  await assert.rejects(afterPack(packagingContext(appOutDir)), /NSCameraUsageDescription/)
})

test('macOS package fails closed if a helper bundle allows broad network transport', async (context) => {
  const appOutDir = mkdtempSync(path.join(os.tmpdir(), 'grok-build-helper-transport-security-'))
  const infoDir = path.join(appOutDir, 'RunBuild.app', 'Contents')
  const helperInfoDir = path.join(infoDir, 'Frameworks', 'RunBuild Helper.app', 'Contents')
  mkdirSync(helperInfoDir, { recursive: true })
  writeFileSync(path.join(infoDir, 'Info.plist'), plist.build({
    CFBundleName: 'RunBuild',
    NSMicrophoneUsageDescription: '仅在主动使用语音输入时访问麦克风。',
  }))
  writeFileSync(path.join(helperInfoDir, 'Info.plist'), plist.build({
    CFBundleName: 'RunBuild Helper',
    NSAppTransportSecurity: { NSAllowsArbitraryLoadsForMedia: true },
  }))
  context.after(() => rmSync(appOutDir, { recursive: true, force: true }))

  await assert.rejects(afterPack(packagingContext(appOutDir)), /NSAllowsArbitraryLoadsForMedia/)
})
