import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appendVisibleUserMessageEcho,
  conversationResource,
  groupConversationTurns,
  isInternalConversationEcho,
  isInternalProtocolText,
  isPersistentMemoryContextEcho,
  PERSISTENT_MEMORY_CONTEXT_PREAMBLE,
  turnOwnsGeneratedImage,
} from './src/features/conversation/conversation-turn.ts'

const memoryContextEcho = `${PERSISTENT_MEMORY_CONTEXT_PREAMBLE}\n\n## Current session summary\n- 当前任务有 8 条会话消息。`

test('keeps generated media inside the question and answer turn that created it', () => {
  const turns = groupConversationTurns([
    { id: 'user-1', role: 'user', text: '帮我生成太空小猫', startedAt: 100 },
    { id: 'agent-1', role: 'agent', text: '已生成：`images/1.jpg`', startedAt: 100 },
    { id: 'user-2', role: 'user', text: '你可以生成视频吗', startedAt: 200 },
    { id: 'agent-2', role: 'agent', text: '可以。', startedAt: 200 },
  ])
  const imageTool = { turnStartedAt: 100, media: { filename: '1.jpg' } }

  assert.deepEqual(turns.map((turn) => turn.messages.map((message) => message.id)), [
    ['user-1', 'agent-1'],
    ['user-2', 'agent-2'],
  ])
  assert.equal(turnOwnsGeneratedImage(turns[0].messages, imageTool), true)
  assert.equal(turnOwnsGeneratedImage(turns[1].messages, imageTool), false)
})

test('uses the generated image path to restore ownership for older cached turns', () => {
  const firstTurn = [{ id: 'agent-1', role: 'agent', text: '已生成：`images/1.jpg`' }]
  const secondTurn = [{ id: 'agent-2', role: 'agent', text: '可以生成视频。' }]
  const legacyImageTool = { media: { filename: '1.jpg' } }

  assert.equal(turnOwnsGeneratedImage(firstTurn, legacyImageTool), true)
  assert.equal(turnOwnsGeneratedImage(secondTurn, legacyImageTool), false)
})

test('suppresses the marked P2 memory block before it can split a user prompt echo', () => {
  const optimistic = { id: 'user-local', role: 'user', text: '你好你好', startedAt: 100 }
  const memoryContent = {
    type: 'text',
    text: memoryContextEcho,
    _meta: { 'runbuild.memoryContext': true },
  }
  assert.equal(isPersistentMemoryContextEcho(memoryContent, memoryContextEcho), true)

  const afterMemory = isPersistentMemoryContextEcho(memoryContent, memoryContextEcho)
    ? [optimistic]
    : appendVisibleUserMessageEcho([optimistic], { id: 'memory-echo', role: 'user', text: memoryContextEcho })
  const afterPromptEcho = appendVisibleUserMessageEcho(afterMemory, {
    id: 'user-echo', role: 'user', text: '你好你好', startedAt: 101,
  })

  assert.deepEqual(afterPromptEcho, [{ id: 'user-local', role: 'user', text: '你好你好', startedAt: 101 }])
})

test('suppresses legacy unmarked P2 context during session replay but keeps the real prompt', () => {
  assert.equal(isPersistentMemoryContextEcho({ type: 'text', text: memoryContextEcho }, memoryContextEcho), true)
  assert.equal(isPersistentMemoryContextEcho({ type: 'text', text: PERSISTENT_MEMORY_CONTEXT_PREAMBLE }, PERSISTENT_MEMORY_CONTEXT_PREAMBLE), false)

  const afterMemory = isPersistentMemoryContextEcho({ type: 'text', text: memoryContextEcho }, memoryContextEcho)
    ? []
    : appendVisibleUserMessageEcho([], { id: 'legacy-memory', role: 'user', text: memoryContextEcho })
  const replayed = appendVisibleUserMessageEcho(afterMemory, { id: 'replayed-user', role: 'user', text: '你好你好' })

  assert.deepEqual(replayed, [{ id: 'replayed-user', role: 'user', text: '你好你好' }])
})

test('suppresses internal protocol echoes before they become chat messages', () => {
  const reminder = '<system-reminder>Background task completed. Command: find /Users/example -name SKILL.md</system-reminder>'

  assert.equal(isInternalConversationEcho({ synthetic_reason: 'system-reminder' }, 'ordinary-looking synthetic context'), true)
  assert.equal(isInternalConversationEcho({ content: reminder }, reminder), true)
  assert.equal(isInternalProtocolText('  <environment_context>private runtime context</environment_context>'), true)
  assert.equal(isInternalProtocolText('请解释 `<system-reminder>` 是什么。'), false)
  assert.equal(isInternalConversationEcho({ content: '开始实现' }, '开始实现'), false)
})

test('resolves web links and project file references without allowing path escape', () => {
  assert.deepEqual(conversationResource('https://example.com/docs', '/Users/example/project'), {
    kind: 'web',
    href: 'https://example.com/docs',
  })
  assert.deepEqual(conversationResource('/Users/example/project/src/main.tsx:6413', '/Users/example/project'), {
    kind: 'file',
    absolutePath: '/Users/example/project/src/main.tsx',
    relativePath: 'src/main.tsx',
    line: 6413,
  })
  assert.deepEqual(conversationResource('./README.md#L12', '/Users/example/project'), {
    kind: 'file',
    absolutePath: '/Users/example/project/README.md',
    relativePath: 'README.md',
    line: 12,
  })
  assert.equal(conversationResource('../outside.txt', '/Users/example/project'), null)
  assert.equal(conversationResource('~/.codex', '/Users/example/project'), null)
  assert.equal(conversationResource('not a file reference', '/Users/example/project'), null)
})
