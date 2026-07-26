import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createProjectRegistry, projectRegistryMiddleware } from './project-registry.ts'

const withServer = async (
  handler: ReturnType<typeof projectRegistryMiddleware>,
  operation: (url: string) => Promise<void>,
) => {
  const server = createServer((request, response) => {
    void handler(request, response, (error) => {
      response.statusCode = error ? 500 : 404
      response.end(error instanceof Error ? error.message : 'Not found')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  try {
    await operation(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('creates a persistent project workspace with instructions and sources', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-projects-'))
  const projectsRoot = path.join(temporary, 'projects')
  const registryPath = path.join(temporary, 'state', 'projects.json')
  const registry = createProjectRegistry({ projectsRoot, registryPath })
  const project = await registry.create({
    name: '我的 Agent 项目',
    instructions: '只修改当前项目。',
    sources: [{ name: '../notes.md', mimeType: 'text/markdown', kind: 'text', size: 8, data: 'reference' }],
  })

  assert.equal(path.relative(projectsRoot, project.rootPath).startsWith('..'), false)
  const agents = await readFile(path.join(project.rootPath, 'AGENTS.md'), 'utf8')
  assert.match(agents, /只修改当前项目/)
  assert.match(agents, /smallest cohesive change/i)
  assert.match(agents, /search project memory/i)
  assert.match(agents, /process ID or zero exit code does not prove/i)
  assert.match(agents, /do not add executable launcher files/i)
  assert.equal(project.sources.length, 1)
  assert.equal(await readFile(path.join(project.rootPath, project.sources[0].relativePath), 'utf8'), 'reference')
  assert.equal((await stat(path.join(project.rootPath, '.grok'))).isDirectory(), true)

  const reloaded = createProjectRegistry({ projectsRoot, registryPath })
  assert.deepEqual((await reloaded.list()).map(({ id }) => id), [project.id])
})

test('updates AGENTS.md without changing the project cwd', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-projects-'))
  const registry = createProjectRegistry({
    projectsRoot: path.join(temporary, 'projects'),
    registryPath: path.join(temporary, 'projects.json'),
  })
  const project = await registry.create({ name: 'Stable cwd' })
  const updated = await registry.update(project.id, { instructions: '新的项目规则。' })
  assert.equal(updated.rootPath, project.rootPath)
  const agents = await readFile(path.join(project.rootPath, 'AGENTS.md'), 'utf8')
  assert.match(agents, /新的项目规则。/)
  assert.equal(agents.match(/personal-agent:managed-coding-rules:start/g)?.length, 1)
})

test('registers an existing folder as the real project cwd', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-projects-'))
  const existingRoot = path.join(temporary, 'existing-repository')
  await mkdir(existingRoot, { recursive: true })
  await writeFile(path.join(existingRoot, 'README.md'), '# Existing project\n')
  await writeFile(path.join(existingRoot, 'AGENTS.md'), '# Existing rules\n\nKeep the public API stable.\n')
  const registry = createProjectRegistry({
    projectsRoot: path.join(temporary, 'projects'),
    registryPath: path.join(temporary, 'projects.json'),
  })

  const project = await registry.importExisting({ rootPath: existingRoot, instructions: '只修改这个目录。' })

  assert.equal(project.rootPath, await realpath(existingRoot))
  assert.equal(project.location, 'external')
  const agents = await readFile(path.join(existingRoot, 'AGENTS.md'), 'utf8')
  assert.match(agents, /Keep the public API stable/)
  assert.match(agents, /只修改这个目录。/)
  await registry.update(project.id, { instructions: '只修改确认过的责任模块。' })
  const updatedAgents = await readFile(path.join(existingRoot, 'AGENTS.md'), 'utf8')
  assert.match(updatedAgents, /Keep the public API stable/)
  assert.doesNotMatch(updatedAgents, /只修改这个目录。/)
  assert.match(updatedAgents, /只修改确认过的责任模块。/)
  assert.equal(updatedAgents.match(/personal-agent:managed-coding-rules:start/g)?.length, 1)
  assert.equal((await registry.listFiles(project.id)).some((entry) => entry.path === 'README.md'), true)
})

test('refuses to overwrite a symlinked AGENTS.md when importing a project', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-projects-'))
  const existingRoot = path.join(temporary, 'existing-repository')
  const outsideRules = path.join(temporary, 'outside-agents.md')
  await mkdir(existingRoot, { recursive: true })
  await writeFile(outsideRules, '# Outside rules\n')
  await symlink(outsideRules, path.join(existingRoot, 'AGENTS.md'))
  const registry = createProjectRegistry({
    projectsRoot: path.join(temporary, 'projects'),
    registryPath: path.join(temporary, 'projects.json'),
  })

  await assert.rejects(
    () => registry.importExisting({ rootPath: existingRoot, instructions: 'Do not escape.' }),
    /AGENTS.md 是符号链接/,
  )
  assert.equal(await readFile(outsideRules, 'utf8'), '# Outside rules\n')
})

test('refuses symlinked project metadata and reference directories', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-projects-'))
  const outside = path.join(temporary, 'outside')
  const grokLinkedRoot = path.join(temporary, 'grok-linked-repository')
  const referencesLinkedRoot = path.join(temporary, 'references-linked-repository')
  await mkdir(outside, { recursive: true })
  await mkdir(grokLinkedRoot, { recursive: true })
  await mkdir(referencesLinkedRoot, { recursive: true })
  await symlink(outside, path.join(grokLinkedRoot, '.grok'))
  await symlink(outside, path.join(referencesLinkedRoot, 'references'))
  const registry = createProjectRegistry({
    projectsRoot: path.join(temporary, 'projects'),
    registryPath: path.join(temporary, 'projects.json'),
  })

  await assert.rejects(() => registry.importExisting({ rootPath: grokLinkedRoot }), /.grok 不能是符号链接/)
  await assert.rejects(() => registry.importExisting({ rootPath: referencesLinkedRoot }), /references 不能是符号链接/)
})

test('serializes concurrent project creation without losing registry entries', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-projects-'))
  const registry = createProjectRegistry({
    projectsRoot: path.join(temporary, 'projects'),
    registryPath: path.join(temporary, 'projects.json'),
  })

  await Promise.all([
    registry.create({ name: 'Concurrent A' }),
    registry.create({ name: 'Concurrent B' }),
  ])

  assert.deepEqual((await registry.list()).map(({ name }) => name).sort(), ['Concurrent A', 'Concurrent B'])
})

test('lists and previews files only inside the registered project root', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-projects-'))
  const registry = createProjectRegistry({
    projectsRoot: path.join(temporary, 'projects'),
    registryPath: path.join(temporary, 'projects.json'),
  })
  const project = await registry.create({ name: 'Preview workspace' })
  await mkdir(path.join(project.rootPath, 'src'), { recursive: true })
  await writeFile(path.join(project.rootPath, 'src', 'app.ts'), 'export const ready = true\n')
  await writeFile(path.join(project.rootPath, '.grok', 'hidden.txt'), 'hidden')

  const files = await registry.listFiles(project.id)
  assert.equal(files.some((entry) => entry.path === 'src/app.ts' && entry.kind === 'text'), true)
  assert.equal(files.some((entry) => entry.path.includes('.grok')), false)
  assert.equal((await registry.readProjectFile(project.id, 'src/app.ts')).data.toString('utf8'), 'export const ready = true\n')
  await assert.rejects(() => registry.readProjectFile(project.id, '../outside.txt'), /不在项目目录内/)
  const outsideFile = path.join(temporary, 'outside.txt')
  await writeFile(outsideFile, 'outside')
  await symlink(outsideFile, path.join(project.rootPath, 'linked.txt'))
  await assert.rejects(() => registry.readProjectFile(project.id, 'linked.txt'), /符号链接文件不支持预览/)
})

test('returns a safe structured 404 when a planned project file does not exist yet', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-projects-'))
  const registry = createProjectRegistry({
    projectsRoot: path.join(temporary, 'projects'),
    registryPath: path.join(temporary, 'projects.json'),
  })
  const project = await registry.create({ name: 'Planned artifact' })

  await withServer(projectRegistryMiddleware(registry), async (url) => {
    const response = await fetch(`${url}/api/projects/${project.id}/file?path=${encodeURIComponent('docs/planned.md')}`)
    const body = await response.json() as { code?: string; error?: string }

    assert.equal(response.status, 404)
    assert.deepEqual(body, { code: 'file_not_found', error: '文件尚未创建' })
    assert.doesNotMatch(JSON.stringify(body), new RegExp(project.rootPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
})
