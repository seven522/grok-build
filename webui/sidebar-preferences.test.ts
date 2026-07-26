import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createSidebarPreferencesStore } from './sidebar-preferences.ts'

const preferences = {
  version: 1 as const,
  projectsExpanded: false,
  historyExpanded: true,
  projectSort: 'updated' as const,
  historySort: 'priority' as const,
  manualProjectOrder: ['project-a', 'project-a', 'project-b'],
  pinnedProjectIds: ['project-b'],
  pinnedConversationIds: ['session-a'],
  archivedConversationIds: ['session-b'],
  sidebarWidth: 999,
}

test('persists validated sidebar preferences across store instances', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runbuild-sidebar-preferences-'))
  const preferencesPath = path.join(root, 'sidebar-preferences.json')
  try {
    const first = createSidebarPreferencesStore(preferencesPath)
    assert.equal(await first.read(), null)
    const written = await first.write(preferences)
    assert.deepEqual(written.manualProjectOrder, ['project-a', 'project-b'])
    assert.equal(written.sidebarWidth, 420)

    const second = createSidebarPreferencesStore(preferencesPath)
    assert.deepEqual(await second.read(), written)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects malformed updates without replacing the last valid file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runbuild-sidebar-preferences-invalid-'))
  const preferencesPath = path.join(root, 'sidebar-preferences.json')
  try {
    const store = createSidebarPreferencesStore(preferencesPath)
    await store.write(preferences)
    const before = await readFile(preferencesPath, 'utf8')
    await assert.rejects(store.write({ ...preferences, projectSort: 'unknown' }), /无效的侧边栏偏好设置/)
    assert.equal(await readFile(preferencesPath, 'utf8'), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
