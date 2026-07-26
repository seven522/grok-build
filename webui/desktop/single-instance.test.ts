import assert from 'node:assert/strict'
import test from 'node:test'

import { installSingleInstanceGuard } from './single-instance.ts'

test('secondary desktop instance quits before starting runtime services', () => {
  let quitCalls = 0
  let secondInstanceListener: (() => void) | undefined
  const result = installSingleInstanceGuard({
    requestSingleInstanceLock: () => false,
    quit: () => { quitCalls += 1 },
    on: (_event, listener) => { secondInstanceListener = listener },
  }, () => undefined)

  assert.equal(result, false)
  assert.equal(quitCalls, 1)
  assert.equal(secondInstanceListener, undefined)
})

test('primary desktop instance focuses the existing window on a second launch', () => {
  let secondInstanceListener: (() => void) | undefined
  let focusCalls = 0
  const result = installSingleInstanceGuard({
    requestSingleInstanceLock: () => true,
    quit: () => undefined,
    on: (event, listener) => {
      assert.equal(event, 'second-instance')
      secondInstanceListener = listener
    },
  }, () => { focusCalls += 1 })

  assert.equal(result, true)
  assert.ok(secondInstanceListener)
  secondInstanceListener()
  assert.equal(focusCalls, 1)
})
