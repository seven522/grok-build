import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { GoalExecutionScope } from './goal-execution-orchestrator.ts'
import {
  SubagentParentBoundaryError,
  createSubagentSupervisor,
  projectSubagentRun,
} from './subagent-supervisor.ts'

const parentScope: GoalExecutionScope = {
  taskId: 'task-parent',
  projectId: 'project-parent',
  auth: {
    principalId: 'operator-parent',
    grantIds: ['workspace.read', 'workspace.write', 'terminal.run'],
  },
}

const parentBoundary = {
  parentRunId: 'goal-run-parent',
  parentScope,
} as const

test('subagents inherit the parent task/project/auth boundary, start synchronous by default, and cannot widen grants', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runbuild-subagent-boundary-'))
  try {
    const supervisor = createSubagentSupervisor({ storageDir: root })
    const started = await supervisor.start({ operationId: 'sub-start-1', ...parentBoundary })
    assert.equal(started.executionMode, 'synchronous')
    assert.equal(started.state, 'running')
    assert.equal(started.scope.taskId, parentScope.taskId)
    assert.equal(started.scope.projectId, parentScope.projectId)
    assert.equal(started.scope.auth.principalId, parentScope.auth.principalId)
    assert.deepEqual(started.scope.auth.grantIds, [...parentScope.auth.grantIds].sort())

    const narrowed = await supervisor.start({
      operationId: 'sub-start-narrow-1',
      ...parentBoundary,
      requestedGrantIds: ['workspace.read'],
    })
    assert.deepEqual(narrowed.scope.auth.grantIds, ['workspace.read'])
    assert.equal(narrowed.scope.taskId, parentScope.taskId)
    assert.equal(narrowed.scope.projectId, parentScope.projectId)

    assert.throws(
      () => supervisor.start({
        operationId: 'sub-start-widen-1',
        ...parentBoundary,
        requestedGrantIds: ['workspace.read', 'network.admin'],
      }),
      SubagentParentBoundaryError,
    )

    const duplicate = await supervisor.start({ operationId: 'sub-start-1', ...parentBoundary })
    assert.equal(duplicate.id, started.id)
    assert.equal((await supervisor.listForParent(parentBoundary)).length, 2, 'idempotent retry must not start a duplicate child run')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('subagent reports remain pending parent verification, persist through reconnect, and stay isolated from another parent boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runbuild-subagent-recovery-'))
  try {
    const first = createSubagentSupervisor({ storageDir: root })
    const started = await first.start({ operationId: 'sub-recovery-start-1', ...parentBoundary })
    const secretProse = 'I completed everything. PRIVATE_TOOL_OUTPUT=do-not-leak'
    const reported = await first.recordAgentReport({
      operationId: 'sub-report-1',
      ...parentBoundary,
      subagentRunId: started.id,
      claimId: 'subagent-claim-1',
      prose: secretProse,
    })
    assert.equal(reported.state, 'awaiting_parent_verification')
    assert.equal(JSON.stringify(projectSubagentRun(reported)).includes(secretProse), false)
    assert.equal((await readFile(first.statePath, 'utf8')).includes(secretProse), false, 'child Agent prose must not become durable supervisor state')

    const disconnected = await first.markDisconnected({ operationId: 'sub-disconnect-1', ...parentBoundary, subagentRunId: started.id })
    assert.equal(disconnected.state, 'reconnecting')
    assert.equal(disconnected.recovery.resumeState, 'awaiting_parent_verification')

    const restarted = createSubagentSupervisor({ storageDir: root })
    const recoverable = await restarted.listRecoverableForParent(parentBoundary)
    assert.deepEqual(recoverable.map((run) => run.id), [started.id])
    const recovery = await restarted.recover({ operationId: 'sub-recover-1', ...parentBoundary, subagentRunId: started.id })
    assert.equal(recovery.action.kind, 'resume_subagent')
    assert.equal(recovery.run.state, 'awaiting_parent_verification', 'transport recovery must retain the parent verifier gate')

    const foreignBoundary = {
      parentRunId: parentBoundary.parentRunId,
      parentScope: {
        ...parentScope,
        projectId: 'project-foreign',
      },
    }
    await assert.rejects(
      () => restarted.getForParent({ ...foreignBoundary, subagentRunId: started.id }),
      SubagentParentBoundaryError,
    )
    assert.deepEqual(await restarted.listForParent(foreignBoundary), [], 'other projects cannot enumerate a parent-owned child run')

    const cancelling = await restarted.requestCancellation({ operationId: 'sub-cancel-1', ...parentBoundary, subagentRunId: started.id })
    assert.equal(cancelling.state, 'cancelling')
    const cancelled = await restarted.acknowledgeCancellation({ operationId: 'sub-cancel-ack-1', ...parentBoundary, subagentRunId: started.id })
    assert.equal(cancelled.state, 'cancelled')
    assert.equal(projectSubagentRun(cancelled).activity[0]?.text, '子代理已确认停止。')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
