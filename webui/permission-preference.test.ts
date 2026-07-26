import assert from 'node:assert/strict'
import test from 'node:test'

import {
  automaticPermissionOption,
  DEFAULT_PERMISSION_PREFERENCE,
  permissionPreferenceNotification,
} from './src/features/permissions/permission-preference.ts'

test('defaults every new or restored session to explicit approval', () => {
  assert.equal(DEFAULT_PERMISSION_PREFERENCE, 'manual-current')
  assert.deepEqual(permissionPreferenceNotification(DEFAULT_PERMISSION_PREFERENCE), {
    method: 'x.ai/yolo_mode_changed',
    params: {
      yolo_mode: false,
      auto_mode: false,
      permission_mode: 'ask',
      clientIdentifier: 'personal-agent-webui',
    },
  })
})

test('keeps full execution available only as an explicit preference', () => {
  assert.deepEqual(permissionPreferenceNotification('approve-running').params, {
    yolo_mode: true,
    auto_mode: false,
    permission_mode: 'always-approve',
    clientIdentifier: 'personal-agent-webui',
  })
})

test('prefers the broadest available approval when switching during a pending request', () => {
  const options = [
    { optionId: 'once', kind: 'allow_once' },
    { optionId: 'always', kind: 'allow_always' },
    { optionId: 'reject', kind: 'reject_once' },
  ]

  assert.equal(automaticPermissionOption(options)?.optionId, 'always')
  assert.equal(automaticPermissionOption(options.filter((option) => option.kind !== 'allow_always'))?.optionId, 'once')
  assert.equal(automaticPermissionOption(options.filter((option) => option.kind.startsWith('reject'))), null)
})
