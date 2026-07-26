import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  MemoryConflictError,
  MemoryNotFoundError,
  createMemoryStore,
  type MemoryScope,
  type MemoryWriteInput,
} from './memory-store.ts'

const alphaScope: MemoryScope = {
  userId: 'user-alice',
  projectId: 'project-alpha',
  agentId: 'agent-runbuild',
  runId: 'run-alpha',
}

const betaScope: MemoryScope = {
  ...alphaScope,
  projectId: 'project-beta',
  runId: 'run-beta',
}

const writeInput = (overrides: Partial<MemoryWriteInput> = {}): MemoryWriteInput => ({
  scope: alphaScope,
  provenance: {
    sourceEventIds: ['evt_alpha_decision_1'],
    sourceTaskId: 'task-alpha',
    sourceRunId: 'run-alpha',
  },
  title: '项目交付规则',
  fact: '发布前必须通过本地验收与可读回检查。',
  confidence: 0.95,
  sensitivity: 'normal',
  pinned: true,
  idempotencyKey: 'decision:alpha:1',
  ...overrides,
})

test('persists only explicit write paths with source traceability and redacts credential values', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-memory-store-'))
  try {
    const storageDir = path.join(temporaryRoot, 'memories')
    const store = createMemoryStore({ storageDir })
    const decision = await store.recordAcceptedDecision(writeInput())
    const replay = await store.recordAcceptedDecision(writeInput())
    const fault = await store.recordVerifiedFaultCause(writeInput({
      provenance: {
        sourceEventIds: ['evt_alpha_fault_1'],
        sourceTaskId: 'task-alpha',
        sourceRunId: 'run-alpha',
      },
      title: '认证故障原因',
      fact: 'OPENAI_API_KEY=sk-very-secret-value-12345678 被错误写入诊断文本。',
      idempotencyKey: 'fault:alpha:1',
      pinned: false,
    }))
    const checkpoint = await store.recordSuccessfulCheckpoint(writeInput({
      provenance: {
        sourceEventIds: ['evt_alpha_checkpoint_1'],
        sourceTaskId: 'task-alpha',
        sourceRunId: 'run-alpha',
      },
      title: '恢复检查点',
      fact: 'Runner 重启后会话恢复并完成状态读回。',
      idempotencyKey: 'checkpoint:alpha:1',
      pinned: false,
    }))
    const remembered = await store.remember(writeInput({
      provenance: {
        sourceEventIds: ['evt_alpha_preference_1'],
        sourceTaskId: 'task-alpha',
        sourceRunId: 'run-alpha',
      },
      title: '答复偏好',
      fact: '优先给出简洁中文结论和可执行下一步。',
      idempotencyKey: 'remember:alpha:1',
      pinned: false,
    }))

    assert.equal(decision.appended, true)
    assert.equal(replay.appended, false)
    assert.equal(replay.record.id, decision.record.id)
    assert.equal(decision.record.writePath, 'accepted-decision')
    assert.deepEqual(decision.record.provenance.sourceEventIds, ['evt_alpha_decision_1'])
    assert.equal(fault.record.writePath, 'verified-fault-cause')
    assert.equal(checkpoint.record.writePath, 'successful-checkpoint')
    assert.equal(remembered.record.writePath, 'remember')
    assert.equal(fault.record.fact.includes('sk-very-secret-value-12345678'), false)
    assert.match(fault.record.fact, /OPENAI_API_KEY=\[REDACTED\]/)
    assert.equal(fault.record.redacted, true)

    const rawState = await readFile(store.statePath, 'utf8')
    assert.equal(rawState.includes('sk-very-secret-value-12345678'), false)
    assert.match(rawState, /\[REDACTED\]/)
    assert.equal((await lstat(store.statePath)).mode & 0o777, 0o600)

    const restarted = createMemoryStore({ storageDir })
    const restored = await restarted.get({ scope: alphaScope, id: decision.record.id })
    assert.equal(restored.title, '项目交付规则')
    assert.equal(restored.audit[0]?.action, 'created')
    assert.equal((await restarted.list({ scope: alphaScope })).length, 4)

    await assert.rejects(
      () => store.recordAcceptedDecision(writeInput({ fact: '同一幂等键不能代表另一条事实。' })),
      MemoryConflictError,
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('keeps project scopes isolated while retaining editable, disputable, superseded, and deleted records for inspection', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'runbuild-memory-scope-'))
  try {
    const store = createMemoryStore({ storageDir: path.join(temporaryRoot, 'memories') })
    const alpha = await store.remember(writeInput({
      title: 'Alpha 专属事实',
      fact: 'Alpha 项目的 Runner 工作目录必须保持独立。',
      idempotencyKey: 'remember:alpha:scope',
    }))
    const beta = await store.remember(writeInput({
      scope: betaScope,
      provenance: { sourceEventIds: ['evt_beta_1'], sourceTaskId: 'task-beta', sourceRunId: 'run-beta' },
      title: 'Beta 专属事实',
      fact: 'Beta 项目的秘密不应出现在 Alpha 上下文。',
      idempotencyKey: 'remember:beta:scope',
    }))

    assert.deepEqual((await store.list({ scope: betaScope })).map((record) => record.id), [beta.record.id])
    await assert.rejects(() => store.get({ scope: betaScope, id: alpha.record.id }), MemoryNotFoundError)
    await assert.rejects(
      () => store.edit({ scope: betaScope, id: alpha.record.id, fact: '试图跨项目编辑', reason: 'should fail' }),
      MemoryNotFoundError,
    )

    const edited = await store.edit({
      scope: alphaScope,
      id: alpha.record.id,
      fact: 'Alpha 项目的 Runner 工作目录必须保持独立，并在恢复后读回。',
      confidence: 0.99,
      reason: '已通过恢复验收确认。',
    })
    assert.equal(edited.revision, 2)
    assert.equal(edited.audit.at(-1)?.action, 'edited')
    assert.match(String(edited.audit.at(-1)?.previousFactSha256), /^[a-f0-9]{64}$/)

    const disputed = await store.setStatus({
      scope: alphaScope,
      id: alpha.record.id,
      status: 'disputed',
      reason: '需要下一轮运行证据确认。',
    })
    assert.equal(disputed.status, 'disputed')
    assert.equal((await store.list({ scope: alphaScope })).length, 0)
    assert.deepEqual((await store.list({ scope: alphaScope, includeStatuses: ['disputed'] })).map((record) => record.id), [alpha.record.id])

    const replacement = await store.recordVerifiedFaultCause(writeInput({
      title: '已验证的替代事实',
      fact: '恢复失败的原因是旧 Runner 租约未释放，而非项目目录损坏。',
      provenance: { sourceEventIds: ['evt_alpha_replacement_1'], sourceTaskId: 'task-alpha', sourceRunId: 'run-alpha' },
      idempotencyKey: 'fault:alpha:replacement',
      pinned: false,
    }))
    const superseded = await store.setStatus({
      scope: alphaScope,
      id: alpha.record.id,
      status: 'superseded',
      supersededById: replacement.record.id,
      reason: '新事实已有验证来源。',
    })
    assert.equal(superseded.supersededById, replacement.record.id)

    const deleted = await store.delete({
      scope: alphaScope,
      id: replacement.record.id,
      reason: '用户要求删除已验证故障记录。',
    })
    assert.equal(deleted.status, 'deleted')
    assert.ok(deleted.deletedAt)
    await assert.rejects(() => store.get({ scope: alphaScope, id: replacement.record.id }), MemoryNotFoundError)
    const inspectDeleted = await store.get({ scope: alphaScope, id: replacement.record.id, includeDeleted: true })
    assert.equal(inspectDeleted.status, 'deleted')
    assert.equal(inspectDeleted.provenance.sourceEventIds[0], 'evt_alpha_replacement_1')
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
