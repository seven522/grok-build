import assert from 'node:assert/strict'
import test from 'node:test'

import {
  planConversationNavigation,
  planScopeTransitionFailure,
  planSessionSwitch,
  replayNeedsSnapshotReset,
  sessionLoadMeta,
  shouldRevealLatestTaskContent,
} from './session-switching.ts'

test('allows switching away from a running conversation', () => {
  assert.deepEqual(planConversationNavigation({
    activeConversationId: 'session-a',
    targetConversationId: 'session-a',
    restoringSession: false,
  }), { kind: 'current' })

  assert.deepEqual(planConversationNavigation({
    activeConversationId: 'session-a',
    targetConversationId: 'session-b',
    restoringSession: false,
  }), { kind: 'switch' })
})

test('returns to the active conversation while it restores without starting another switch', () => {
  assert.deepEqual(planConversationNavigation({
    activeConversationId: 'session-a',
    targetConversationId: 'session-a',
    restoringSession: true,
  }), { kind: 'current' })

  assert.deepEqual(planConversationNavigation({
    activeConversationId: 'session-a',
    targetConversationId: 'session-b',
    restoringSession: true,
  }), { kind: 'blocked', reason: 'restoring' })
})

test('switches an already resident session without loading it again', () => {
  assert.deepEqual(planSessionSwitch({
    currentSessionId: 'session-a',
    targetSessionId: 'session-b',
    residentSessionIds: new Set(['session-a', 'session-b']),
    hasCachedSnapshot: true,
  }), {
    kind: 'resident',
    showCachedSnapshot: true,
    shouldLoad: false,
  })
})

test('shows a cached snapshot while a non-resident session restores incrementally', () => {
  assert.deepEqual(planSessionSwitch({
    currentSessionId: 'session-a',
    targetSessionId: 'session-b',
    residentSessionIds: new Set(['session-a']),
    hasCachedSnapshot: true,
  }), {
    kind: 'restore',
    showCachedSnapshot: true,
    shouldLoad: true,
  })
  assert.deepEqual(sessionLoadMeta('session-b-42'), { cursor: 'session-b-42' })
})

test('uses the loading state for a session that has no cached snapshot', () => {
  assert.deepEqual(planSessionSwitch({
    currentSessionId: 'session-a',
    targetSessionId: 'session-new',
    residentSessionIds: new Set(['session-a']),
    hasCachedSnapshot: false,
  }), {
    kind: 'restore',
    showCachedSnapshot: false,
    shouldLoad: true,
  })
  assert.deepEqual(sessionLoadMeta(), {})
})

test('resets a cached snapshot once when the server falls back to a full replay', () => {
  assert.equal(replayNeedsSnapshotReset({ hasCachedSnapshot: true, isReplay: true, alreadyReset: false }), true)
  assert.equal(replayNeedsSnapshotReset({ hasCachedSnapshot: true, isReplay: false, alreadyReset: false }), false)
  assert.equal(replayNeedsSnapshotReset({ hasCachedSnapshot: true, isReplay: true, alreadyReset: true }), false)
})

test('reveals the latest content only after the requested task has finished restoring', () => {
  assert.equal(shouldRevealLatestTaskContent({
    requestedConversationId: 'session-b',
    activeConversationId: 'session-a',
    restoringConversationId: null,
  }), false)
  assert.equal(shouldRevealLatestTaskContent({
    requestedConversationId: 'session-b',
    activeConversationId: 'session-b',
    restoringConversationId: 'session-b',
  }), false)
  assert.equal(shouldRevealLatestTaskContent({
    requestedConversationId: 'session-b',
    activeConversationId: 'session-b',
    restoringConversationId: null,
  }), true)
  assert.equal(shouldRevealLatestTaskContent({
    requestedConversationId: null,
    activeConversationId: 'session-b',
    restoringConversationId: null,
  }), false)
})

test('keeps an explicitly selected task when startup recovery began from an empty landing', () => {
  assert.deepEqual(planScopeTransitionFailure({
    targetConversationId: 'project-session',
    previousConversationId: null,
    previousHasDraftOrContent: false,
  }), {
    kind: 'preserve-target',
    retryConversationId: 'project-session',
  })

  assert.deepEqual(planScopeTransitionFailure({
    targetConversationId: 'project-session',
    previousConversationId: 'root-session',
    previousHasDraftOrContent: false,
  }), { kind: 'rollback' })

  assert.deepEqual(planScopeTransitionFailure({
    targetConversationId: 'project-session',
    previousConversationId: null,
    previousHasDraftOrContent: true,
  }), { kind: 'rollback' })

  assert.deepEqual(planScopeTransitionFailure({
    targetConversationId: null,
    previousConversationId: null,
    previousHasDraftOrContent: false,
  }), { kind: 'rollback' })
})
