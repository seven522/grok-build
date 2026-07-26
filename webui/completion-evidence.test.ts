import assert from 'node:assert/strict'
import test from 'node:test'

import { createToolReceiptVerifier, deriveCompletionEvidence } from './src/features/conversation/completion-evidence.ts'

const verifier = (evidenceIds: readonly string[] = ['tool:read-config']): Parameters<typeof deriveCompletionEvidence>[0]['verifier'] => ({
  id: 'verification-1',
  status: 'passed',
  summary: 'The changed file was read back and the test command exited successfully.',
  checkedAt: '2026-07-24T12:00:00.000Z',
  evidenceIds,
})

const cleanup = (): Parameters<typeof deriveCompletionEvidence>[0]['cleanup'] => ({
  status: 'not_required',
  summary: 'No temporary process or artifact was created by this task.',
})

test('derives a completion report from ACP command, patch, and readback receipts', () => {
  const report = deriveCompletionEvidence({
    toolUpdates: [
      {
        toolCallId: 'run-tests',
        status: 'completed',
        rawOutput: {
          type: 'Bash',
          command: 'npm test -- --runInBand',
          exit_code: 0,
          output: [79, 75],
          timed_out: false,
        },
      },
      {
        toolCallId: 'patch-config',
        eventId: 'evt-tool-patch-config',
        status: 'completed',
        rawOutput: {
          type: 'ApplyPatch',
          Success: {
            files: [{ path: 'src/config.ts', action: 'modified' }],
          },
        },
      },
      {
        toolCallId: 'read-config',
        title: 'Read src/config.ts',
        status: 'completed',
        rawOutput: {
          type: 'ReadFile',
          FileContent: { path: 'src/config.ts', content: 'export const safe = true' },
        },
      },
    ],
    verifier: verifier(['run-tests', 'patch-config', 'tool:read-config']),
    cleanup: cleanup(),
  })

  assert.equal(report.status, 'verified')
  assert.equal(report.acceptsCompletion, true)
  assert.deepEqual(report.changedFiles, {
    status: 'changed',
    files: [{ path: 'src/config.ts', action: 'modified', sourceToolCallId: 'patch-config' }],
  })
  assert.deepEqual(report.commands, [{
    toolCallId: 'run-tests',
    command: 'npm test -- --runInBand',
    exitCode: 0,
    outputObserved: true,
    timedOut: false,
    signal: undefined,
    status: 'passed',
  }])
  assert.deepEqual(report.readbacks, [{
    id: 'tool:read-config',
    status: 'passed',
    kind: 'file',
    subject: 'src/config.ts',
    sourceToolCallId: 'read-config',
  }])
  assert.equal(report.verifier.status, 'passed')
  assert.equal(report.cleanup.status, 'not_required')
  assert.deepEqual(report.uncertainty, [])
})

test('does not accept an Agent completion claim without an independent verifier receipt', () => {
  const report = deriveCompletionEvidence({
    changes: { kind: 'no_change', reason: 'The requested behavior already matched the requirement.' },
    cleanup: cleanup(),
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.acceptsCompletion, false)
  assert.equal(report.verifier.status, 'missing')
  assert.match(report.uncertainty.join('\n'), /Agent 的文字结论不能作为完成依据/)
})

test('does not treat an incomplete verifier-shaped payload as a verifier receipt', () => {
  const report = deriveCompletionEvidence({
    changes: { kind: 'no_change', reason: 'The requested behavior already matched the requirement.' },
    verifier: {
      id: 'assistant-message-only',
      status: 'passed',
      summary: 'Done.',
      checkedAt: '',
      evidenceIds: [],
    },
    cleanup: cleanup(),
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.acceptsCompletion, false)
  assert.equal(report.verifier.status, 'invalid')
})

test('treats a nonzero Bash exit code as failed even if a transport update says completed', () => {
  const report = deriveCompletionEvidence({
    toolUpdates: [{
      toolCallId: 'write-outside',
      status: 'completed',
      rawOutput: {
        type: 'Bash',
        command: 'touch /outside/project/file',
        exit_code: 1,
        output: [111, 112, 101, 114, 97, 116, 105, 111, 110],
        timed_out: false,
      },
    }],
    changes: { kind: 'no_change', reason: 'The sandbox denied the attempted write.' },
    verifier: verifier(['write-outside']),
    cleanup: cleanup(),
  })

  assert.equal(report.status, 'failed')
  assert.equal(report.acceptsCompletion, false)
  assert.equal(report.commands[0]?.status, 'failed')
  assert.equal(report.commands[0]?.exitCode, 1)
})

test('treats a masked parse error as failed even when the pipeline exit code is zero', () => {
  const report = deriveCompletionEvidence({
    toolUpdates: [{
      toolCallId: 'godot-smoke',
      status: 'completed',
      rawOutput: {
        type: 'Bash',
        command: 'godot --headless --path . 2>&1 | head',
        exit_code: 0,
        output: true,
        diagnostic_codes: ['script-error', 'parse-error'],
      },
    }],
    changes: { kind: 'no_change', reason: 'Verification-only run.' },
    verifier: verifier(['godot-smoke']),
    cleanup: cleanup(),
  })

  assert.equal(report.status, 'failed')
  assert.equal(report.acceptsCompletion, false)
  assert.equal(report.commands[0]?.status, 'failed')
})

test('requires a UI readback for a native Godot launch before accepting completion', () => {
  const toolUpdates = [
    {
      toolCallId: 'patch-scene',
      sequence: 10,
      status: 'completed',
      rawOutput: { type: 'ApplyPatch', Success: { files: [{ path: 'scene.gd', action: 'modified' }] } },
    },
    {
      toolCallId: 'read-scene',
      sequence: 11,
      status: 'completed',
      rawOutput: { type: 'ReadFile', FileContent: { path: 'scene.gd', content: 'extends Node' } },
    },
    {
      toolCallId: 'launch-godot',
      sequence: 12,
      status: 'completed',
      rawOutput: { type: 'Bash', command: 'open -na /Applications/Godot.app --args --path .', exit_code: 0, output: true },
    },
  ] as const

  const withoutUi = createToolReceiptVerifier({
    scopeId: 'task-alpha:run-ui:terminal-1',
    checkedAt: '2026-07-25T12:00:00.000Z',
    toolUpdates,
  })
  assert.equal(withoutUi, null)

  const withUi = createToolReceiptVerifier({
    scopeId: 'task-alpha:run-ui:terminal-1',
    checkedAt: '2026-07-25T12:00:00.000Z',
    toolUpdates,
    readbacks: [{
      id: 'ui:godot-window-1',
      status: 'passed',
      kind: 'ui',
      subject: 'Godot game window',
      source: 'runner',
      sourceSequence: 13,
    }],
  })
  assert.equal(withUi?.report.acceptsCompletion, true)
})

test('requires a successful readback when ACP receipts show changed files', () => {
  const report = deriveCompletionEvidence({
    toolUpdates: [{
      toolCallId: 'edit-readme',
      status: 'completed',
      rawOutput: {
        type: 'SearchReplace',
        EditsApplied: { absolute_path: 'README.md' },
      },
    }],
    verifier: verifier(['edit-readme']),
    cleanup: cleanup(),
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.changedFiles.status, 'changed')
  assert.equal(report.acceptsCompletion, false)
  assert.match(report.uncertainty.join('\n'), /没有成功的读回/)
})

test('keeps a no-change result eligible only when it is explicit, verified, and cleaned up', () => {
  const report = deriveCompletionEvidence({
    changes: { kind: 'no_change', reason: 'The targeted code already contains the requested guard.' },
    verifier: verifier(['inspection:existing-guard']),
    cleanup: cleanup(),
  })

  assert.equal(report.status, 'verified')
  assert.equal(report.acceptsCompletion, true)
  assert.deepEqual(report.changedFiles, {
    status: 'no_change',
    files: [],
    reason: 'The targeted code already contains the requested guard.',
  })
})

test('rejects a declared no-change result that conflicts with a patch receipt', () => {
  const report = deriveCompletionEvidence({
    toolUpdates: [{
      toolCallId: 'patch-source',
      status: 'completed',
      rawOutput: {
        type: 'ApplyPatch',
        Success: { files: [{ path: 'src/app.ts', action: 'modified' }] },
      },
    }],
    changes: { kind: 'no_change', reason: 'No change was made.' },
    verifier: verifier(['patch-source']),
    cleanup: cleanup(),
  })

  assert.equal(report.status, 'failed')
  assert.equal(report.acceptsCompletion, false)
  assert.deepEqual(report.changedFiles.files, [{ path: 'src/app.ts', action: 'modified', sourceToolCallId: 'patch-source' }])
  assert.match(report.uncertainty.join('\n'), /与 ACP 补丁\/编辑收据冲突/)
})

test('uses the final update for a repeated ACP tool call and keeps a missing exit code incomplete', () => {
  const report = deriveCompletionEvidence({
    toolUpdates: [
      {
        toolCallId: 'run-check',
        status: 'in_progress',
        rawOutput: { type: 'Bash', command: 'npm run check' },
      },
      {
        toolCallId: 'run-check',
        status: 'completed',
        rawOutput: { type: 'Bash', command: 'npm run check', output: [] },
      },
    ],
    changes: { kind: 'no_change', reason: 'This was a verification-only run.' },
    verifier: verifier(['run-check']),
    cleanup: cleanup(),
  })

  assert.equal(report.commands.length, 1)
  assert.equal(report.commands[0]?.status, 'unknown')
  assert.equal(report.status, 'incomplete')
  assert.equal(report.acceptsCompletion, false)
})

test('creates deterministic ledger-ready receipts only from complete ACP tool evidence', () => {
  const input = {
    scopeId: 'task-alpha:run-1:terminal-22',
    checkedAt: '2026-07-24T12:00:22.000Z',
    toolUpdates: [
      {
        toolCallId: 'patch-config',
        eventId: 'evt-tool-patch-config',
        sequence: 20,
        status: 'completed',
        rawOutput: { type: 'ApplyPatch', Success: { files: [{ path: 'src/config.ts', action: 'modified' }] } },
      },
      {
        toolCallId: 'read-config',
        sequence: 21,
        status: 'completed',
        rawOutput: { type: 'ReadFile', FileContent: { absolute_path: 'src/config.ts', content: 'safe = true' } },
      },
      {
        toolCallId: 'run-tests',
        sequence: 22,
        status: 'completed',
        rawOutput: { type: 'Bash', command: 'npm test', exit_code: 0, output: [79, 75], timed_out: false },
      },
    ],
  } as const

  const first = createToolReceiptVerifier(input)
  const second = createToolReceiptVerifier(input)

  assert.ok(first)
  assert.deepEqual(second, first)
  assert.equal(first.report.acceptsCompletion, true)
  assert.equal(first.verifier.status, 'passed')
  assert.equal(first.cleanup.status, 'not_required')
  assert.match(first.cleanup.summary, /no background task/i)
  assert.match(first.verifier.id, /^tool-receipt:task-alpha:run-1:terminal-22:/)
  assert.equal(first.verifier.evidenceIds.includes('evt-tool-patch-config'), true)
  assert.deepEqual(first.report.changedFiles.files, [{
    path: 'src/config.ts',
    action: 'modified',
    sourceToolCallId: 'patch-config',
    sourceSequence: 20,
  }])
})

test('requires a readback of every changed file after the change receipt', () => {
  const verification = createToolReceiptVerifier({
    scopeId: 'task-alpha:run-1:terminal-23',
    checkedAt: '2026-07-24T12:00:23.000Z',
    toolUpdates: [
      {
        toolCallId: 'read-before-edit',
        sequence: 10,
        status: 'completed',
        rawOutput: { type: 'ReadFile', FileContent: { absolute_path: '/workspace/src/config.ts', content: 'old' } },
      },
      {
        toolCallId: 'patch-config',
        sequence: 11,
        status: 'completed',
        rawOutput: { type: 'ApplyPatch', Success: { files: [{ path: 'src/config.ts', action: 'modified' }] } },
      },
    ],
  })

  assert.equal(verification, null)
})

test('uses the latest repeated change receipt when checking readback order', () => {
  const verification = createToolReceiptVerifier({
    scopeId: 'task-alpha:run-1:terminal-23b',
    checkedAt: '2026-07-24T12:00:23.500Z',
    toolUpdates: [
      {
        toolCallId: 'first-edit',
        sequence: 10,
        status: 'completed',
        rawOutput: { type: 'ApplyPatch', Success: { files: [{ path: 'src/config.ts', action: 'modified' }] } },
      },
      {
        toolCallId: 'read-after-first-edit',
        sequence: 11,
        status: 'completed',
        rawOutput: { type: 'ReadFile', FileContent: { absolute_path: 'src/config.ts', content: 'first' } },
      },
      {
        toolCallId: 'second-edit',
        sequence: 12,
        status: 'completed',
        rawOutput: { type: 'ApplyPatch', Success: { files: [{ path: 'src/config.ts', action: 'modified' }] } },
      },
    ],
  })

  assert.equal(verification, null)
})

test('refuses background, raw tool failures, and assistant text without a receipt', () => {
  const noAssistantProof = createToolReceiptVerifier({
    scopeId: 'task-alpha:run-1:terminal-24',
    checkedAt: '2026-07-24T12:00:24.000Z',
    toolUpdates: [],
    // Extra untyped fields are intentionally ignored; no assistant text is accepted by the API.
    assistantText: '任务已经完成。',
  } as Parameters<typeof createToolReceiptVerifier>[0])
  const backgrounded = createToolReceiptVerifier({
    scopeId: 'task-alpha:run-1:terminal-25',
    checkedAt: '2026-07-24T12:00:25.000Z',
    explicitChanges: { kind: 'no_change', reason: 'No file was changed.', evidenceIds: ['workspace-diff:25'] },
    toolUpdates: [{
      toolCallId: 'background-task',
      sequence: 25,
      status: 'completed',
      rawOutput: { type: 'BackgroundTaskStarted', task_id: 'task-25' },
    }],
  })
  const patchFailure = createToolReceiptVerifier({
    scopeId: 'task-alpha:run-1:terminal-26',
    checkedAt: '2026-07-24T12:00:26.000Z',
    explicitChanges: { kind: 'no_change', reason: 'The patch was rejected.', evidenceIds: ['workspace-diff:26'] },
    toolUpdates: [{
      toolCallId: 'bad-patch',
      sequence: 26,
      status: 'completed',
      rawOutput: { type: 'ApplyPatch', ApplicationError: 'hunk failed' },
    }],
  })
  const missingRawOutput = createToolReceiptVerifier({
    scopeId: 'task-alpha:run-1:terminal-26b',
    checkedAt: '2026-07-24T12:00:26.500Z',
    explicitChanges: { kind: 'no_change', reason: 'The workspace diff is empty.', evidenceIds: ['workspace-diff:26b'] },
    toolUpdates: [{ toolCallId: 'unobserved-tool', sequence: 26, status: 'completed' }],
  })

  assert.equal(noAssistantProof, null)
  assert.equal(backgrounded, null)
  assert.equal(patchFailure, null)
  assert.equal(missingRawOutput, null)
})

test('accepts an explicit no-change workspace receipt without consulting assistant prose', () => {
  const verification = createToolReceiptVerifier({
    scopeId: 'task-alpha:run-1:terminal-27',
    checkedAt: '2026-07-24T12:00:27.000Z',
    toolUpdates: [],
    explicitChanges: {
      kind: 'no_change',
      reason: 'The workspace diff is empty after the requested inspection.',
      evidenceIds: ['workspace-diff:27'],
    },
  })

  assert.ok(verification)
  assert.equal(verification.report.status, 'verified')
  assert.equal(verification.report.changedFiles.status, 'no_change')
  assert.deepEqual(verification.verifier.evidenceIds, ['workspace-diff:27'])
})
