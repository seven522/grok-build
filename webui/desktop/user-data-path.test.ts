import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { resolveDesktopUserDataPath } from './user-data-path.ts'

const appDataPath = path.join(path.sep, 'Users', 'example', 'Library', 'Application Support')
const productPath = path.join(appDataPath, 'RunBuild')
const legacyPath = path.join(appDataPath, 'Grok Build')

test('a packaged release ignores an existing legacy profile by default', () => {
  assert.equal(resolveDesktopUserDataPath({
    appDataPath,
    isPackaged: true,
    importLegacy: false,
    pathExists: (candidate) => candidate === legacyPath,
  }), productPath)
})

test('legacy profile reuse requires an explicit packaged migration request', () => {
  assert.equal(resolveDesktopUserDataPath({
    appDataPath,
    isPackaged: true,
    importLegacy: true,
    pathExists: (candidate) => candidate === legacyPath,
  }), legacyPath)
})

test('development retains the legacy fallback and an explicit profile always wins', () => {
  assert.equal(resolveDesktopUserDataPath({
    appDataPath,
    isPackaged: false,
    importLegacy: false,
    pathExists: (candidate) => candidate === legacyPath,
  }), legacyPath)

  assert.equal(resolveDesktopUserDataPath({
    appDataPath,
    explicitPath: './isolated-runbuild-profile',
    isPackaged: true,
    importLegacy: false,
    pathExists: () => true,
  }), path.resolve('./isolated-runbuild-profile'))
})
