import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isDesktopTaskSurfaceReady,
  mergeConversationCatalog,
  orderConversationHistory,
  projectRecentActivity,
  planScopedConversationOpen,
  reconcileArchivedConversationIds,
  selectRootHistory,
  selectScopedConversation,
  sidebarSelectedConversationId,
  shouldResumePendingTaskSubmission,
  shouldShowTaskInspector,
  shouldShowConversationLanding,
  syncExpandedProjectIds,
} from './project-navigation.ts'

test('releases desktop startup for a connected blank task surface', () => {
  assert.equal(isDesktopTaskSurfaceReady({
    bridgeState: 'connected',
    bridgeProjectId: null,
    homeTaskProjectId: null,
    sessionReady: false,
  }), true)
  assert.equal(isDesktopTaskSurfaceReady({
    bridgeState: 'connected',
    bridgeProjectId: 'alpha',
    homeTaskProjectId: 'alpha',
    sessionReady: false,
  }), true)
  assert.equal(isDesktopTaskSurfaceReady({
    bridgeState: 'connecting',
    bridgeProjectId: 'alpha',
    homeTaskProjectId: 'alpha',
    sessionReady: false,
  }), false)
  assert.equal(isDesktopTaskSurfaceReady({
    bridgeState: 'connected',
    bridgeProjectId: null,
    homeTaskProjectId: undefined,
    sessionReady: true,
  }), true)
})

test('resumes a queued first prompt only after its matching task scope is ready', () => {
  const ready = {
    pendingProjectId: 'alpha',
    bridgeProjectId: 'alpha',
    bridgeState: 'connected' as const,
    isRunning: false,
    restoringSession: false,
  }

  assert.equal(shouldResumePendingTaskSubmission(ready), true)
  assert.equal(shouldResumePendingTaskSubmission({ ...ready, bridgeProjectId: 'beta' }), false)
  assert.equal(shouldResumePendingTaskSubmission({ ...ready, bridgeState: 'connecting' }), false)
  assert.equal(shouldResumePendingTaskSubmission({ ...ready, isRunning: true }), false)
  assert.equal(shouldResumePendingTaskSubmission({ ...ready, restoringSession: true }), false)
})

test('initializes project expansion once, then preserves the user collapse state', () => {
  assert.deepEqual(syncExpandedProjectIds([], ['alpha', 'beta'], false), ['alpha', 'beta'])
  assert.deepEqual(syncExpandedProjectIds([], ['alpha', 'beta'], true), [])
})

test('drops removed projects without expanding the remaining projects', () => {
  assert.deepEqual(syncExpandedProjectIds(['alpha', 'removed'], ['alpha', 'beta'], true), ['alpha'])
})

test('builds one recent history across root and project conversations without duplicates', () => {
  const history = orderConversationHistory([
    { id: 'root-old', createdAt: '2026-07-20T10:00:00.000Z', projectId: null },
    { id: 'project-new', createdAt: '2026-07-23T10:00:00.000Z', projectId: 'alpha' },
    { id: 'root-pinned', createdAt: '2026-07-19T10:00:00.000Z', projectId: null },
    { id: 'archived', createdAt: '2026-07-24T10:00:00.000Z', projectId: 'beta' },
  ], { pinnedIds: ['root-pinned'], archivedIds: ['archived'], sort: 'priority' })

  assert.deepEqual(history.map((conversation) => conversation.id), ['root-pinned', 'project-new', 'root-old'])
  assert.equal(history.find((conversation) => conversation.id === 'project-new')?.projectId, 'alpha')
})

test('orders a newly created ISO timestamp ahead of older persisted sessions', () => {
  const history = orderConversationHistory([
    { id: 'older', createdAt: '2026-07-23T23:59:59.000Z', projectId: null },
    { id: 'new', createdAt: '2026-07-24T00:00:01.000Z', projectId: 'alpha' },
  ], { sort: 'created' })
  assert.deepEqual(history.map((conversation) => conversation.id), ['new', 'older'])
})

test('keeps project conversations out of root history', () => {
  const history = selectRootHistory([
    { id: 'root-history', createdAt: '2026-07-23T10:00:00.000Z', projectId: null },
    { id: 'project-history', createdAt: '2026-07-24T10:00:00.000Z', projectId: 'alpha' },
  ])

  assert.deepEqual(history.map((conversation) => conversation.id), ['root-history'])
})

test('keeps only durable archive records when reconciling legacy sidebar preferences', () => {
  assert.deepEqual(
    reconcileArchivedConversationIds(
      ['legacy-root', 'durable-existing', 'legacy-project', 'durable-existing'],
      ['durable-existing', 'durable-new'],
    ),
    ['durable-existing', 'durable-new'],
  )
})

test('catalog refresh preserves cached conversation data while replacing stale metadata', () => {
  const current = [{ id: 'alpha', title: '旧标题', messages: ['cached'], tools: ['cached-tool'], cursor: 'alpha-42', modelId: 'grok-4.5', createdAt: '2026-07-20T00:00:00.000Z' }]
  const incoming = [{ id: 'alpha', title: '新标题', messages: [], tools: [], createdAt: '2026-07-24T00:00:00.000Z' }]
  const merged = mergeConversationCatalog(current, incoming)
  assert.deepEqual(merged, [{ id: 'alpha', title: '新标题', messages: ['cached'], tools: ['cached-tool'], cursor: 'alpha-42', modelId: 'grok-4.5', createdAt: '2026-07-24T00:00:00.000Z' }])
})

test('uses the latest project conversation when sorting projects by recent activity', () => {
  const conversations = [
    { id: 'one', createdAt: '2026-07-24T05:00:00.000Z', projectId: 'alpha' },
    { id: 'two', createdAt: '2026-07-23T05:00:00.000Z', projectId: 'beta' },
  ]
  assert.equal(projectRecentActivity({ id: 'alpha', updatedAt: '2026-07-20T00:00:00.000Z' }, conversations), Date.parse('2026-07-24T05:00:00.000Z'))
})

test('never substitutes another session when an explicit scoped target is missing', () => {
  const known = [{ id: 'latest' }, { id: 'older' }]

  assert.deepEqual(selectScopedConversation(known, 'missing', false), {
    session: null,
    requestedSessionMissing: true,
    archivedOnly: false,
  })
  assert.deepEqual(selectScopedConversation(known, null, false), {
    session: known[0],
    requestedSessionMissing: false,
    archivedOnly: false,
  })
  assert.deepEqual(selectScopedConversation(known, 'latest', true), {
    session: null,
    requestedSessionMissing: false,
    archivedOnly: false,
  })
})

test('opens a blank task landing without creating a session', () => {
  const known = [{ id: 'latest' }]

  assert.deepEqual(planScopedConversationOpen(selectScopedConversation([], null, false)), {
    kind: 'landing',
  })
  assert.deepEqual(planScopedConversationOpen(selectScopedConversation(known, 'latest', true)), {
    kind: 'landing',
  })
  assert.deepEqual(planScopedConversationOpen(selectScopedConversation(known, null, false)), {
    kind: 'restore',
    session: known[0],
  })
  assert.deepEqual(planScopedConversationOpen(selectScopedConversation(known, 'missing', false)), {
    kind: 'missing',
  })
})

test('skips archived sessions during automatic restore and reports an archived-only scope', () => {
  const known = [{ id: 'latest' }, { id: 'older' }]

  assert.deepEqual(selectScopedConversation(known, null, false, ['latest']), {
    session: known[1],
    requestedSessionMissing: false,
    archivedOnly: false,
  })
  assert.deepEqual(selectScopedConversation(known, null, false, ['latest', 'older']), {
    session: null,
    requestedSessionMissing: false,
    archivedOnly: true,
  })
})

test('leaves the landing page after an empty new conversation becomes active', () => {
  assert.equal(shouldShowConversationLanding({
    activeConversationId: null,
    messageCount: 0,
    isRunning: false,
    isSwitchingTask: false,
  }), true)
  assert.equal(shouldShowConversationLanding({
    activeConversationId: 'new-session',
    messageCount: 0,
    isRunning: false,
    isSwitchingTask: false,
  }), false)
})

test('binds the sidebar selection to the visible or opening workspace page', () => {
  assert.equal(sidebarSelectedConversationId({
    page: 'chat',
    activeConversationId: 'current-session',
    restoringSession: null,
  }), 'current-session')
  assert.equal(sidebarSelectedConversationId({
    page: 'chat',
    activeConversationId: 'previous-session',
    restoringSession: { id: 'opening-session', kind: 'switch' },
  }), 'opening-session')
  assert.equal(sidebarSelectedConversationId({
    page: 'chat',
    activeConversationId: 'previous-session',
    restoringSession: { id: 'project-id', kind: 'create' },
  }), null)
  assert.equal(sidebarSelectedConversationId({
    page: 'automations',
    activeConversationId: 'current-session',
    restoringSession: null,
  }), null)
  assert.equal(sidebarSelectedConversationId({
    page: 'skills',
    activeConversationId: 'current-session',
    restoringSession: null,
  }), null)
  assert.equal(sidebarSelectedConversationId({
    page: 'chat',
    activeConversationId: 'current-session',
    restoringSession: null,
    archivedConversationIds: ['current-session'],
  }), null)
})

test('shows the task inspector only on the conversation page', () => {
  assert.equal(shouldShowTaskInspector({ page: 'chat', opened: true }), true)
  assert.equal(shouldShowTaskInspector({ page: 'chat', opened: false }), false)
  assert.equal(shouldShowTaskInspector({ page: 'automations', opened: true }), false)
  assert.equal(shouldShowTaskInspector({ page: 'memory', opened: true }), false)
  assert.equal(shouldShowTaskInspector({ page: 'skills', opened: true }), false)
})
