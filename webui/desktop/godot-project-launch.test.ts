import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { launchRegisteredGodotProject, resolveRegisteredGodotProject } from './godot-project-launch.ts'

const fixture = async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-godot-launch-'))
  const projectRoot = path.join(temporaryRoot, 'project')
  const applicationPath = path.join(temporaryRoot, 'Godot.app')
  const executablePath = path.join(applicationPath, 'Contents', 'MacOS', 'Godot')
  const registryPath = path.join(temporaryRoot, 'projects.json')
  await mkdir(projectRoot)
  await mkdir(path.dirname(executablePath), { recursive: true })
  await writeFile(path.join(projectRoot, 'project.godot'), '[application]\n')
  await writeFile(executablePath, '#!/bin/sh\n')
  await writeFile(registryPath, JSON.stringify([{ id: 'project-alpha', rootPath: projectRoot }]))
  return { temporaryRoot, projectRoot, applicationPath, registryPath }
}

test('launches only a registered Godot project through the fixed macOS open command', async () => {
  const current = await fixture()
  try {
    const calls: Array<{ executable: string; args: readonly string[] }> = []
    const receipt = await launchRegisteredGodotProject({
      projectId: 'project-alpha',
      registryPath: current.registryPath,
      platform: 'darwin',
      homeDirectory: current.temporaryRoot,
      configuredApplication: current.applicationPath,
      launchCommand: async (executable, args) => { calls.push({ executable, args }) },
      now: () => new Date('2026-07-25T12:00:00.000Z'),
    })

    assert.deepEqual(calls, [{
      executable: '/usr/bin/open',
      args: ['-na', await realpath(current.applicationPath), '--args', '--path', await realpath(current.projectRoot)],
    }])
    assert.equal(receipt.status, 'awaiting_visual_confirmation')
    assert.equal(receipt.projectId, 'project-alpha')
    assert.equal(receipt.launchedAt, '2026-07-25T12:00:00.000Z')
  } finally {
    await rm(current.temporaryRoot, { recursive: true, force: true })
  }
})

test('rejects unregistered projects and symlinked project descriptors', async () => {
  const current = await fixture()
  try {
    await assert.rejects(
      resolveRegisteredGodotProject({ projectId: 'project-other', registryPath: current.registryPath }),
      /项目未登记/,
    )
    const descriptor = path.join(current.projectRoot, 'project.godot')
    const outside = path.join(current.temporaryRoot, 'outside.godot')
    await rm(descriptor)
    await writeFile(outside, '[application]\n')
    await symlink(outside, descriptor)
    await assert.rejects(
      resolveRegisteredGodotProject({ projectId: 'project-alpha', registryPath: current.registryPath }),
      /不是普通文件/,
    )
  } finally {
    await rm(current.temporaryRoot, { recursive: true, force: true })
  }
})
