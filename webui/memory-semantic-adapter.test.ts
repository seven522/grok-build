import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createDeterministicSemanticMemoryAdapter,
  deterministicMemoryTokens,
  retrieveSemanticMemories,
  type SemanticMemoryAdapter,
} from './memory-semantic-adapter.ts'
import { createMemoryStore, type MemoryScope } from './memory-store.ts'

const alphaScope: MemoryScope = { userId: 'user-alice', projectId: 'project-alpha', agentId: 'agent-runbuild', runId: 'run-alpha' }
const betaScope: MemoryScope = { ...alphaScope, projectId: 'project-beta', runId: 'run-beta' }

test('deterministic semantic adapter ranks local facts without an external model and cannot cross projects', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-memory-semantic-'))
  try {
    const store = createMemoryStore({ storageDir: path.join(temporaryRoot, 'memories') })
    const runner = await store.recordVerifiedFaultCause({
      scope: alphaScope,
      provenance: { sourceEventIds: ['evt_alpha_runner'], sourceTaskId: 'task-alpha', sourceRunId: 'run-alpha' },
      title: 'Runner 恢复故障',
      fact: 'Runner lease 超时后需要等待旧 owner 释放，再恢复 ACP 会话。',
      confidence: 0.98,
      pinned: true,
      idempotencyKey: 'runner-fault-alpha',
    })
    const layout = await store.remember({
      scope: alphaScope,
      provenance: { sourceEventIds: ['evt_alpha_layout'], sourceTaskId: 'task-alpha', sourceRunId: 'run-alpha' },
      title: '界面偏好',
      fact: '侧栏应显示项目和任务的清晰层级。',
      confidence: 0.7,
      idempotencyKey: 'layout-alpha',
    })
    const beta = await store.remember({
      scope: betaScope,
      provenance: { sourceEventIds: ['evt_beta_secret'], sourceTaskId: 'task-beta', sourceRunId: 'run-beta' },
      title: 'Beta 私有运行规则',
      fact: 'Beta 的恢复方案绝不能被其他项目检索。',
      confidence: 1,
      idempotencyKey: 'beta-secret',
    })
    const candidates = [runner.record, layout.record, beta.record]
    const adapter = createDeterministicSemanticMemoryAdapter()

    const first = await retrieveSemanticMemories(adapter, {
      scope: alphaScope,
      query: 'Runner 恢复 lease',
      candidates,
      limit: 5,
    })
    const second = await retrieveSemanticMemories(adapter, {
      scope: alphaScope,
      query: 'Runner 恢复 lease',
      candidates: [...candidates].reverse(),
      limit: 5,
    })

    assert.deepEqual(first.map((hit) => hit.record.id), [runner.record.id])
    assert.deepEqual(second.map((hit) => ({ id: hit.record.id, score: hit.score, terms: hit.matchingTerms })), first.map((hit) => ({ id: hit.record.id, score: hit.score, terms: hit.matchingTerms })))
    assert.equal(first[0]?.record.fact.includes('Beta'), false)
    assert.ok(first[0]?.matchingTerms.includes('runner'))
    assert.ok(deterministicMemoryTokens('Runner 恢复').includes('runner'))

    const betaSearch = await retrieveSemanticMemories(adapter, {
      scope: betaScope,
      query: 'Runner 恢复',
      candidates,
    })
    assert.deepEqual(betaSearch.map((hit) => hit.record.id), [beta.record.id])
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('future adapters receive isolated candidates and cannot replace inspectable content for an existing ID', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-memory-adapter-boundary-'))
  try {
    const store = createMemoryStore({ storageDir: path.join(temporaryRoot, 'memories') })
    const alpha = await store.remember({
      scope: alphaScope,
      provenance: { sourceEventIds: ['evt_alpha_1'], sourceTaskId: 'task-alpha', sourceRunId: 'run-alpha' },
      title: 'Alpha 事实',
      fact: 'Alpha 上下文只能使用 Alpha 项目事实。',
      idempotencyKey: 'alpha-boundary',
    })
    const beta = await store.remember({
      scope: betaScope,
      provenance: { sourceEventIds: ['evt_beta_1'], sourceTaskId: 'task-beta', sourceRunId: 'run-beta' },
      title: 'Beta 事实',
      fact: 'Beta 不可泄漏。',
      idempotencyKey: 'beta-boundary',
    })
    let observedCandidates: string[] = []
    const futureAdapter: SemanticMemoryAdapter = {
      name: 'future-mem0-boundary-test',
      async search(input) {
        observedCandidates = input.candidates.map((record) => record.id)
        const only = input.candidates[0]
        if (!only) return []
        return [{
          // This deliberately attempts to swap the visible fact.  The safe
          // boundary must restore the canonical candidate by ID.
          record: { ...only, fact: 'forged external content' },
          score: 8,
          matchingTerms: ['alpha'],
        }]
      },
    }
    const result = await retrieveSemanticMemories(futureAdapter, {
      scope: alphaScope,
      query: 'alpha',
      candidates: [alpha.record, beta.record],
    })
    assert.deepEqual(observedCandidates, [alpha.record.id])
    assert.equal(result[0]?.record.id, alpha.record.id)
    assert.equal(result[0]?.record.fact, alpha.record.fact)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
