import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildDeterministicMemoryContext } from './memory-context-builder.ts'
import { createMemoryStore, type MemoryScope } from './memory-store.ts'

const alphaScope: MemoryScope = { userId: 'user-alice', projectId: 'project-alpha', agentId: 'agent-runbuild', runId: 'run-alpha' }
const betaScope: MemoryScope = { ...alphaScope, projectId: 'project-beta', runId: 'run-beta' }

test('builds a deterministic redacted context in rules-facts-session-retrieval order without cross-project leakage', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-memory-context-'))
  try {
    const store = createMemoryStore({ storageDir: path.join(temporaryRoot, 'memories') })
    const fact = await store.recordAcceptedDecision({
      scope: alphaScope,
      provenance: { sourceEventIds: ['evt_alpha_rule'], sourceTaskId: 'task-alpha', sourceRunId: 'run-alpha' },
      title: '项目工作区边界',
      fact: '项目是独立 cwd 与 Runner，不能将其他项目上下文注入当前任务。',
      confidence: 0.99,
      pinned: true,
      idempotencyKey: 'alpha-workspace-rule',
    })
    const recall = await store.recordSuccessfulCheckpoint({
      scope: alphaScope,
      provenance: { sourceEventIds: ['evt_alpha_recovery'], sourceTaskId: 'task-alpha', sourceRunId: 'run-alpha' },
      title: '恢复检查点',
      fact: '断连后保留 run ID，只有 ACP 终态才记录完成结果。',
      confidence: 0.96,
      idempotencyKey: 'alpha-recovery-checkpoint',
    })
    const beta = await store.remember({
      scope: betaScope,
      provenance: { sourceEventIds: ['evt_beta_secret'], sourceTaskId: 'task-beta', sourceRunId: 'run-beta' },
      title: 'Beta 私有事实',
      fact: '不能出现在 Alpha 的模型上下文。',
      idempotencyKey: 'beta-private-fact',
    })
    const restricted = await store.remember({
      scope: alphaScope,
      provenance: { sourceEventIds: ['evt_alpha_restricted'], sourceTaskId: 'task-alpha', sourceRunId: 'run-alpha' },
      title: '受限运维说明',
      fact: '仅在明确授权的恢复会话里使用。',
      sensitivity: 'restricted',
      idempotencyKey: 'alpha-restricted',
    })

    const context = buildDeterministicMemoryContext({
      scope: alphaScope,
      projectRules: ['新建任务不得偷偷继承其他项目 cwd。', 'OPENAI_API_KEY=sk-context-secret-12345678 不得进入上下文。'],
      facts: [beta.record, restricted.record, fact.record],
      currentSessionSummary: '当前会话正在恢复；Bearer very-secret-token-12345678 不得进入上下文。',
      retrievedMemories: [{ record: recall.record, score: 9.5, matchingTerms: ['恢复'] }, beta.record],
      maxChars: 4_000,
    })

    assert.ok(context.text.length <= 4_000)
    assert.equal(context.usedChars, context.text.length)
    assert.equal(context.text.includes('sk-context-secret-12345678'), false)
    assert.equal(context.text.includes('very-secret-token-12345678'), false)
    assert.match(context.text, /OPENAI_API_KEY=\[REDACTED\]/)
    assert.match(context.text, /Bearer \[REDACTED\]/)
    assert.equal(context.text.includes(beta.record.id), false)
    assert.equal(context.text.includes(restricted.record.id), false)
    assert.ok(context.includedMemoryIds.includes(fact.record.id))
    assert.ok(context.includedMemoryIds.includes(recall.record.id))
    assert.equal(context.includedMemoryIds.includes(beta.record.id), false)
    assert.equal(context.includedMemoryIds.includes(restricted.record.id), false)
    assert.equal(context.redacted, true)
    assert.ok(context.text.indexOf('## Project rules') < context.text.indexOf('## Inspectable scoped facts'))
    assert.ok(context.text.indexOf('## Inspectable scoped facts') < context.text.indexOf('## Current session summary'))
    assert.ok(context.text.indexOf('## Current session summary') < context.text.indexOf('## Retrieved memories'))

    const repeat = buildDeterministicMemoryContext({
      scope: alphaScope,
      projectRules: ['新建任务不得偷偷继承其他项目 cwd。', 'OPENAI_API_KEY=sk-context-secret-12345678 不得进入上下文。'],
      facts: [fact.record, restricted.record, beta.record],
      currentSessionSummary: '当前会话正在恢复；Bearer very-secret-token-12345678 不得进入上下文。',
      retrievedMemories: [beta.record, { record: recall.record, score: 9.5, matchingTerms: ['恢复'] }],
      maxChars: 4_000,
    })
    assert.deepEqual(repeat, context)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('honors the exact budget without reordering later sections ahead of omitted facts', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-memory-context-budget-'))
  try {
    const store = createMemoryStore({ storageDir: path.join(temporaryRoot, 'memories') })
    const fact = await store.remember({
      scope: alphaScope,
      provenance: { sourceEventIds: ['evt_budget_fact'], sourceTaskId: 'task-alpha', sourceRunId: 'run-alpha' },
      title: '长事实',
      fact: '这是一个用于预算测试的事实，'.repeat(30),
      pinned: true,
      idempotencyKey: 'budget-fact',
    })
    const retrieved = await store.remember({
      scope: alphaScope,
      provenance: { sourceEventIds: ['evt_budget_recall'], sourceTaskId: 'task-alpha', sourceRunId: 'run-alpha' },
      title: '后续检索',
      fact: '这个记录不应因为前面的预算不足而跳到前面。',
      idempotencyKey: 'budget-retrieved',
    })
    const context = buildDeterministicMemoryContext({
      scope: alphaScope,
      projectRules: ['规则优先。'.repeat(12)],
      facts: [fact.record],
      currentSessionSummary: '当前会话摘要。'.repeat(20),
      retrievedMemories: [{ record: retrieved.record, score: 1, matchingTerms: ['预算'] }],
      maxChars: 220,
    })

    assert.ok(context.text.length <= 220)
    assert.equal(context.usedChars, context.text.length)
    const factIndex = context.text.indexOf('## Inspectable scoped facts')
    const sessionIndex = context.text.indexOf('## Current session summary')
    const retrievedIndex = context.text.indexOf('## Retrieved memories')
    if (factIndex !== -1 && sessionIndex !== -1) assert.ok(factIndex < sessionIndex)
    if (sessionIndex !== -1 && retrievedIndex !== -1) assert.ok(sessionIndex < retrievedIndex)
    assert.equal(context.text.includes(retrieved.record.id) && !context.text.includes(fact.record.id), false)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
