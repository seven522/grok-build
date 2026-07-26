export function syncExpandedProjectIds(current: string[], available: string[], initialized: boolean) {
  if (!initialized) return [...available]
  const availableIds = new Set(available)
  return current.filter((id) => availableIds.has(id))
}

export type NavigableConversation = {
  id: string
  createdAt: string
  projectId: string | null
}

export function isDesktopTaskSurfaceReady({
  bridgeState,
  bridgeProjectId,
  homeTaskProjectId,
  sessionReady,
}: {
  bridgeState: 'offline' | 'connecting' | 'connected' | 'error'
  bridgeProjectId: string | null
  homeTaskProjectId: string | null | undefined
  sessionReady: boolean
}) {
  return sessionReady || (
    homeTaskProjectId !== undefined
    && bridgeState === 'connected'
    && bridgeProjectId === homeTaskProjectId
  )
}

/**
 * A first prompt may be submitted while its project Bridge is still changing
 * scope.  Resume it only after the same scope is connected and no existing
 * session transition or running task can be interrupted.
 */
export function shouldResumePendingTaskSubmission({
  pendingProjectId,
  bridgeProjectId,
  bridgeState,
  isRunning,
  restoringSession,
}: {
  pendingProjectId: string | null
  bridgeProjectId: string | null
  bridgeState: 'offline' | 'connecting' | 'connected' | 'error'
  isRunning: boolean
  restoringSession: boolean
}) {
  return (
    pendingProjectId === bridgeProjectId
    && bridgeState === 'connected'
    && !isRunning
    && !restoringSession
  )
}

const activityTime = (value: string) => {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function orderConversationHistory<T extends NavigableConversation>(
  conversations: T[],
  options: {
    archivedIds?: string[]
    pinnedIds?: string[]
    sort?: 'priority' | 'created'
  } = {},
) {
  const archived = new Set(options.archivedIds ?? [])
  const pinned = new Set(options.pinnedIds ?? [])
  return conversations
    .filter((conversation) => !archived.has(conversation.id))
    .sort((left, right) => {
      if (options.sort !== 'created') {
        const leftPinned = pinned.has(left.id)
        const rightPinned = pinned.has(right.id)
        if (leftPinned !== rightPinned) return leftPinned ? -1 : 1
      }
      return activityTime(right.createdAt) - activityTime(left.createdAt)
    })
}

export function selectRootHistory<T extends NavigableConversation>(conversations: T[]) {
  return conversations.filter((conversation) => conversation.projectId === null)
}

/**
 * Sidebar preferences used to be the only place where an archived task was
 * remembered.  Now that task workspaces have a durable lifecycle, only IDs
 * confirmed by that lifecycle may remain hidden.  Keep the existing order for
 * durable IDs, then append durable records that were not in the preference.
 */
export function reconcileArchivedConversationIds(
  current: readonly string[],
  durableArchivedTaskIds: readonly string[],
) {
  const remaining = new Set(durableArchivedTaskIds)
  const reconciled: string[] = []
  for (const id of current) {
    if (remaining.delete(id)) reconciled.push(id)
  }
  for (const id of durableArchivedTaskIds) {
    if (remaining.delete(id)) reconciled.push(id)
  }
  return reconciled
}

export function mergeConversationCatalog<T extends { id: string; messages: unknown; tools: unknown }>(current: T[], incoming: T[]) {
  const cachedById = new Map(current.map((conversation) => [conversation.id, conversation]))
  return incoming.map((conversation) => {
    const cached = cachedById.get(conversation.id)
    return cached ? { ...cached, ...conversation, messages: cached.messages, tools: cached.tools } : conversation
  })
}

export function selectScopedConversation<T extends { id: string }>(
  conversations: T[],
  requestedSessionId: string | null,
  forceNewSession: boolean,
  archivedIds: string[] = [],
) {
  if (forceNewSession) return { session: null, requestedSessionMissing: false, archivedOnly: false }
  const archived = new Set(archivedIds)
  const availableConversations = conversations.filter((conversation) => !archived.has(conversation.id))
  const archivedOnly = conversations.length > 0 && availableConversations.length === 0
  if (requestedSessionId) {
    const session = availableConversations.find((conversation) => conversation.id === requestedSessionId) ?? null
    return { session, requestedSessionMissing: !session, archivedOnly }
  }
  return { session: availableConversations[0] ?? null, requestedSessionMissing: false, archivedOnly }
}

export function planScopedConversationOpen<T>(selection: {
  session: T | null
  requestedSessionMissing: boolean
}) {
  if (selection.requestedSessionMissing) return { kind: 'missing' as const }
  if (!selection.session) return { kind: 'landing' as const }
  return { kind: 'restore' as const, session: selection.session }
}

export function shouldShowConversationLanding({
  activeConversationId,
  messageCount,
  isRunning,
  isSwitchingTask,
}: {
  activeConversationId: string | null
  messageCount: number
  isRunning: boolean
  isSwitchingTask: boolean
}) {
  return !activeConversationId && messageCount === 0 && !isRunning && !isSwitchingTask
}

export function shouldShowTaskInspector({
  page,
  opened,
}: {
  page: 'chat' | 'automations' | 'skills' | 'memory'
  opened: boolean
}) {
  return page === 'chat' && opened
}

export function sidebarSelectedConversationId({
  page,
  activeConversationId,
  restoringSession,
  archivedConversationIds = [],
}: {
  page: 'chat' | 'automations' | 'skills' | 'memory'
  activeConversationId: string | null
  restoringSession: { id: string; kind: 'switch' | 'create' } | null
  archivedConversationIds?: string[]
}) {
  if (page !== 'chat' || restoringSession?.kind === 'create') return null
  const selectedConversationId = restoringSession?.kind === 'switch' ? restoringSession.id : activeConversationId
  return selectedConversationId && !archivedConversationIds.includes(selectedConversationId) ? selectedConversationId : null
}

export function projectRecentActivity(
  project: { id: string; updatedAt: string },
  conversations: NavigableConversation[],
) {
  return conversations
    .filter((conversation) => conversation.projectId === project.id)
    .reduce((latest, conversation) => Math.max(latest, activityTime(conversation.createdAt)), activityTime(project.updatedAt))
}
