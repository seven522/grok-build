import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { StoredProject } from './project-registry.ts'
import { listSessionCatalog, resolveSessionImage } from './session-catalog.ts'

const projectRecord = (id: string, name: string, rootPath: string): StoredProject => ({
  id,
  name,
  rootPath,
  location: 'external',
  instructions: '',
  sources: [],
  defaultSandbox: 'workspace',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
})

const writeSession = async (options: {
  home: string
  cwd: string
  id: string
  updatedAt: string
  summary?: string
  prompt?: string
}) => {
  const sessionDirectory = path.join(options.home, 'sessions', encodeURIComponent(options.cwd), options.id)
  await mkdir(sessionDirectory, { recursive: true })
  await writeFile(path.join(sessionDirectory, 'summary.json'), JSON.stringify({
    info: { id: options.id, cwd: options.cwd },
    session_summary: options.summary ?? '',
    created_at: options.updatedAt,
    updated_at: options.updatedAt,
    num_chat_messages: 2,
  }))
  await writeFile(path.join(sessionDirectory, 'chat_history.jsonl'), [
    JSON.stringify({ type: 'system', content: 'system' }),
    JSON.stringify({
      type: 'user',
      synthetic_reason: 'system-reminder',
      content: [{ type: 'text', text: '<system-reminder>Internal context must not become a title.</system-reminder>' }],
    }),
    JSON.stringify({
      type: 'user',
      content: [{ type: 'text', text: '<system-reminder>Unmarked internal context must also stay hidden.</system-reminder>' }],
    }),
    JSON.stringify({ type: 'user', content: [{ type: 'text', text: options.prompt ?? '' }] }),
  ].join('\n'))
}

test('aggregates root and isolated project session summaries into one scoped catalog', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-session-catalog-'))
  try {
    const workspace = path.join(temporaryRoot, 'workspace')
    const unrelatedWorkspace = path.join(temporaryRoot, 'unrelated')
    const grokHome = path.join(temporaryRoot, 'root-home')
    const projectRoot = path.join(temporaryRoot, 'project-alpha')
    await Promise.all([mkdir(workspace), mkdir(unrelatedWorkspace), mkdir(path.join(projectRoot, '.grok'), { recursive: true })])
    await writeSession({
      home: grokHome,
      cwd: workspace,
      id: 'root-session',
      updatedAt: '2026-07-23T10:00:00.000Z',
      summary: 'Root session title',
    })
    await writeSession({
      home: grokHome,
      cwd: unrelatedWorkspace,
      id: 'unrelated-session',
      updatedAt: '2026-07-24T12:00:00.000Z',
      summary: 'Must stay hidden',
    })
    await writeSession({
      home: path.join(projectRoot, '.grok'),
      cwd: projectRoot,
      id: 'project-session',
      updatedAt: '2026-07-24T10:00:00.000Z',
      summary: '<system-reminder>Internal context must not become a summary title.</system-reminder>',
      prompt: '  Project   prompt becomes the title  ',
    })

    const sessions = await listSessionCatalog({
      grokHome,
      workspace,
      projects: [projectRecord('alpha', 'Alpha', projectRoot)],
    })

    assert.deepEqual(sessions.map((session) => session.id), ['project-session', 'root-session'])
    assert.equal(sessions[0].projectId, 'alpha')
    assert.equal(sessions[0].cwd, projectRoot)
    assert.equal(sessions[0].title, 'Project prompt becomes the title')
    assert.equal(sessions[1].projectId, null)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('removes leaked Markdown code fences from sidebar titles', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-session-catalog-'))
  try {
    const workspace = path.join(temporaryRoot, 'workspace')
    const grokHome = path.join(temporaryRoot, 'root-home')
    await mkdir(workspace)
    await writeSession({
      home: grokHome,
      cwd: workspace,
      id: 'fenced-title',
      updatedAt: '2026-07-25T10:00:00.000Z',
      summary: '你好问候会话启动```',
    })

    const sessions = await listSessionCatalog({ grokHome, workspace, projects: [] })
    assert.equal(sessions[0]?.title, '你好问候会话启动')
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('resolves generated images only inside known session image folders', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-session-media-'))
  try {
    const workspace = path.join(temporaryRoot, 'workspace')
    const grokHome = path.join(temporaryRoot, 'root-home')
    const sessionId = '019f928a-000b-71b3-82f0-740e9124633a'
    const imageDirectory = path.join(grokHome, 'sessions', encodeURIComponent(workspace), sessionId, 'images')
    await mkdir(imageDirectory, { recursive: true })
    await writeFile(path.join(imageDirectory, '1.jpg'), 'generated-image')

    const media = await resolveSessionImage({ grokHome, workspace, projects: [], sessionId, filename: '1.jpg' })
    assert.equal(media?.contentType, 'image/jpeg')
    assert.equal(media?.size, 15)
    assert.equal(await resolveSessionImage({ grokHome, workspace, projects: [], sessionId, filename: '../summary.json' }), null)
    assert.equal(await resolveSessionImage({ grokHome, workspace, projects: [], sessionId: '../outside', filename: '1.jpg' }), null)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
