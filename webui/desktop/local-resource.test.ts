import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveTrustedLocalResource } from './local-resource.ts'

test('opens only safe files inside the workspace or registered project roots', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-local-resource-'))
  try {
    const workspace = path.join(temporaryRoot, 'workspace')
    const project = path.join(temporaryRoot, 'project')
    const outside = path.join(temporaryRoot, 'outside')
    const registryPath = path.join(temporaryRoot, 'projects.json')
    await Promise.all([mkdir(workspace), mkdir(project), mkdir(outside)])
    const workspaceFile = path.join(workspace, 'README.md')
    const projectFile = path.join(project, 'src', 'main.tsx')
    const outsideFile = path.join(outside, 'secret.txt')
    await mkdir(path.dirname(projectFile), { recursive: true })
    await Promise.all([
      writeFile(workspaceFile, '# workspace'),
      writeFile(projectFile, 'export {}'),
      writeFile(outsideFile, 'private'),
      writeFile(registryPath, JSON.stringify([{ rootPath: project }])),
    ])

    assert.deepEqual(await resolveTrustedLocalResource({ target: workspaceFile, workspace, registryPath }), { kind: 'file', path: await realpath(workspaceFile) })
    assert.deepEqual(await resolveTrustedLocalResource({ target: projectFile, workspace, registryPath }), { kind: 'file', path: await realpath(projectFile) })
    await assert.rejects(resolveTrustedLocalResource({ target: outsideFile, workspace, registryPath }), /不在当前工作区/)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('rejects symlinks and executable-shaped files from chat links', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-local-resource-'))
  try {
    const workspace = path.join(temporaryRoot, 'workspace')
    const registryPath = path.join(temporaryRoot, 'projects.json')
    await mkdir(workspace)
    await writeFile(registryPath, '[]')
    const script = path.join(workspace, 'unsafe.command')
    const linked = path.join(workspace, 'linked.md')
    await writeFile(script, '#!/bin/sh')
    await symlink(script, linked)

    await assert.rejects(resolveTrustedLocalResource({ target: script, workspace, registryPath }), /文件类型/)
    await assert.rejects(resolveTrustedLocalResource({ target: linked, workspace, registryPath }), /符号链接/)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
