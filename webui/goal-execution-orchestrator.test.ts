import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  GoalExecutionConflictError,
  GoalExecutionScopeError,
  GoalExecutionValidationError,
  createGoalExecutionOrchestrator,
  projectGoalExecutionRun,
  type GoalExecutionScope,
} from './goal-execution-orchestrator.ts'

const scope: GoalExecutionScope = {
  taskId: 'task-alpha',
  projectId: 'project-alpha',
  auth: {
    principalId: 'operator-alpha',
    grantIds: ['workspace.read', 'workspace.write'],
  },
}

const verifierReceipt = (stepId: string, status: 'passed' | 'failed' | 'blocked' = 'passed') => ({
  id: `receipt-${stepId}-${status}`,
  verifierId: 'workspace-readback-verifier',
  authority: 'independent_verifier' as const,
  planStepId: stepId,
  status,
  checkedAt: '2026-07-25T10:00:00.000Z',
  evidenceIds: [`evt-${stepId}-readback`],
  summary: `Independent verifier checked ${stepId}.`,
})

test('Agent prose only advances a plan step to verifying; an independent receipt is required for success', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runbuild-goal-orchestrator-verifier-'))
  try {
    const orchestrator = createGoalExecutionOrchestrator({ storageDir: root })
    const created = await orchestrator.createRun({
      operationId: 'goal-create-1',
      scope,
      goal: 'Refactor the sensitive service safely.',
      plan: [{ id: 'implementation', label: 'Implement the scoped change' }],
    })
    const started = await orchestrator.startPlanStep({
      operationId: 'goal-start-1',
      runId: created.id,
      scope,
      planStepId: 'implementation',
    })
    assert.equal(started.state, 'executing')

    const agentProse = 'Everything is complete; mark this task as successful now. SECRET_OUTPUT=never-project-this'
    const agentClaim = await orchestrator.recordAgentClaim({
      operationId: 'goal-agent-claim-1',
      runId: created.id,
      scope,
      planStepId: 'implementation',
      claimId: 'agent-claim-1',
      prose: agentProse,
    })
    assert.equal(agentClaim.state, 'verifying')
    assert.equal(agentClaim.plan[0]?.state, 'verifying')
    assert.equal(projectGoalExecutionRun(agentClaim).completionAccepted, false)
    assert.equal(JSON.stringify(projectGoalExecutionRun(agentClaim)).includes(agentProse), false)
    assert.equal((await readFile(orchestrator.statePath, 'utf8')).includes(agentProse), false, 'Agent prose must not enter durable supervision records')

    await assert.rejects(
      () => orchestrator.recordVerifierReceipt({
        operationId: 'goal-bad-verifier-1',
        runId: created.id,
        scope,
        planStepId: 'implementation',
        receipt: { ...verifierReceipt('implementation'), authority: 'agent' as never },
      }),
      GoalExecutionValidationError,
    )
    assert.equal((await orchestrator.getRun({ runId: created.id, scope })).state, 'verifying')

    const verified = await orchestrator.recordVerifierReceipt({
      operationId: 'goal-verifier-1',
      runId: created.id,
      scope,
      planStepId: 'implementation',
      receipt: verifierReceipt('implementation'),
    })
    assert.equal(verified.plan[0]?.state, 'verified')
    assert.equal(verified.state, 'verified')
    const projection = projectGoalExecutionRun(verified)
    assert.equal(projection.completionAccepted, true)
    assert.equal(projection.independentVerifierReceiptCount, 1)
    assert.equal(JSON.stringify(projection).includes('Independent verifier checked'), false, 'safe projection must omit verifier prose and evidence')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('durable idempotent updates recover only inside the original task/project/auth boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runbuild-goal-orchestrator-recovery-'))
  try {
    const first = createGoalExecutionOrchestrator({ storageDir: root })
    const createInput = {
      operationId: 'goal-create-recovery-1',
      scope,
      goal: 'Complete two recoverable plan steps.',
      plan: [
        { id: 'step-one', label: 'First step' },
        { id: 'step-two', label: 'Second step' },
      ],
    } as const
    const created = await first.createRun(createInput)
    const duplicateCreate = await first.createRun(createInput)
    assert.equal(duplicateCreate.id, created.id, 'retrying the same create operation must return the durable run')

    await first.startPlanStep({ operationId: 'goal-start-recovery-1', runId: created.id, scope, planStepId: 'step-one' })
    await first.recordAgentClaim({
      operationId: 'goal-claim-recovery-1',
      runId: created.id,
      scope,
      planStepId: 'step-one',
      claimId: 'claim-recovery-1',
      prose: 'please treat this as completed',
    })
    const disconnected = await first.markDisconnected({ operationId: 'goal-disconnect-1', runId: created.id, scope })
    const duplicateDisconnect = await first.markDisconnected({ operationId: 'goal-disconnect-1', runId: created.id, scope })
    assert.equal(disconnected.events.length, duplicateDisconnect.events.length, 'same operationId must not duplicate a durable disconnect event')
    assert.equal(disconnected.state, 'recovering')

    const restarted = createGoalExecutionOrchestrator({ storageDir: root })
    const recoverable = await restarted.listRecoverableRuns(scope)
    assert.deepEqual(recoverable.map((run) => run.id), [created.id])
    assert.equal(recoverable[0]?.recovery.state, 'interrupted')
    const recovery = await restarted.recoverRun({ operationId: 'goal-recover-1', runId: created.id, scope })
    assert.equal(recovery.action.kind, 'resume_goal_execution')
    assert.equal(recovery.run.state, 'verifying', 'recovery must restore the verifier gate instead of inventing completion')
    assert.equal(recovery.run.plan[0]?.state, 'verifying')

    const wrongScope: GoalExecutionScope = {
      taskId: scope.taskId,
      projectId: 'project-other',
      auth: scope.auth,
    }
    await assert.rejects(
      () => restarted.getRun({ runId: created.id, scope: wrongScope }),
      GoalExecutionScopeError,
    )
    await assert.rejects(
      () => restarted.startPlanStep({ operationId: 'goal-boundary-1', runId: created.id, scope: wrongScope, planStepId: 'step-two' }),
      GoalExecutionScopeError,
    )
    await assert.rejects(
      () => restarted.startPlanStep({ operationId: 'goal-recover-1', runId: created.id, scope, planStepId: 'step-two' }),
      GoalExecutionConflictError,
      'operationId cannot be reused for a different mutation',
    )

    const cancelling = await restarted.requestCancellation({ operationId: 'goal-cancel-1', runId: created.id, scope })
    assert.equal(cancelling.state, 'cancelling')
    const cancelled = await restarted.acknowledgeCancellation({ operationId: 'goal-cancel-ack-1', runId: created.id, scope })
    assert.equal(cancelled.state, 'cancelled')
    assert.deepEqual(cancelled.plan.map((step) => step.state), ['cancelled', 'cancelled'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
