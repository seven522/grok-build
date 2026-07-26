import assert from 'node:assert/strict'
import test from 'node:test'
import { isFirstDesktopRun, resolveInitialColorScheme, shouldAutoStartXaiLogin } from './startup-preferences.ts'

test('a new profile starts in the light theme while preserving an explicit dark preference', () => {
  assert.equal(resolveInitialColorScheme(null), 'light')
  assert.equal(resolveInitialColorScheme('unexpected'), 'light')
  assert.equal(resolveInitialColorScheme('light'), 'light')
  assert.equal(resolveInitialColorScheme('dark'), 'dark')
})

test('automatic xAI login is limited to the first desktop run', () => {
  assert.equal(isFirstDesktopRun(null), true)
  assert.equal(isFirstDesktopRun('1'), false)
  assert.equal(shouldAutoStartXaiLogin({ desktopRuntime: true, firstRun: true, loginRequired: true, alreadyAttempted: false }), true)
  assert.equal(shouldAutoStartXaiLogin({ desktopRuntime: false, firstRun: true, loginRequired: true, alreadyAttempted: false }), false)
  assert.equal(shouldAutoStartXaiLogin({ desktopRuntime: true, firstRun: false, loginRequired: true, alreadyAttempted: false }), false)
  assert.equal(shouldAutoStartXaiLogin({ desktopRuntime: true, firstRun: true, loginRequired: false, alreadyAttempted: false }), false)
  assert.equal(shouldAutoStartXaiLogin({ desktopRuntime: true, firstRun: true, loginRequired: true, alreadyAttempted: true }), false)
})
