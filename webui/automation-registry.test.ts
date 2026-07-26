import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAutomationRegistry } from './automation-registry.ts'

test('persists and removes automation conversation templates', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-automations-'))
  try {
    const statePath = path.join(temporary, 'automations.json')
    const registry = createAutomationRegistry(statePath)
    const created = await registry.create({ name: '日报', trigger: '每天 9 点', instruction: '总结项目进展' })
    assert.equal(created.trigger, '每天 9 点')
    assert.deepEqual((await createAutomationRegistry(statePath).list()).map((item) => item.id), [created.id])
    assert.equal(await registry.remove(created.id), true)
    assert.deepEqual(await registry.list(), [])
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
