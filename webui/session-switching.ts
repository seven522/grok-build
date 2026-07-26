export type SessionSwitchPlan = {
  kind: 'current' | 'resident' | 'restore'
  showCachedSnapshot: boolean
  shouldLoad: boolean
}

export type ConversationNavigationPlan =
  | { kind: 'current' }
  | { kind: 'switch' }
  | { kind: 'blocked'; reason: 'restoring' }

export function planConversationNavigation({
  activeConversationId,
  targetConversationId,
  restoringSession,
}: {
  activeConversationId: string | null
  targetConversationId: string
  restoringSession: boolean
}): ConversationNavigationPlan {
  if (targetConversationId === activeConversationId) return { kind: 'current' }
  if (restoringSession) return { kind: 'blocked', reason: 'restoring' }
  return { kind: 'switch' }
}

export function planSessionSwitch({
  currentSessionId,
  targetSessionId,
  residentSessionIds,
  hasCachedSnapshot,
}: {
  currentSessionId: string | null
  targetSessionId: string
  residentSessionIds: ReadonlySet<string>
  hasCachedSnapshot: boolean
}): SessionSwitchPlan {
  if (targetSessionId === currentSessionId) {
    return { kind: 'current', showCachedSnapshot: true, shouldLoad: false }
  }
  if (residentSessionIds.has(targetSessionId)) {
    return { kind: 'resident', showCachedSnapshot: true, shouldLoad: false }
  }
  return { kind: 'restore', showCachedSnapshot: hasCachedSnapshot, shouldLoad: true }
}

export function sessionLoadMeta(cursor?: string) {
  return cursor ? { cursor } : {}
}

export function replayNeedsSnapshotReset({
  hasCachedSnapshot,
  isReplay,
  alreadyReset,
}: {
  hasCachedSnapshot: boolean
  isReplay: boolean
  alreadyReset: boolean
}) {
  return hasCachedSnapshot && isReplay && !alreadyReset
}

export function shouldRevealLatestTaskContent({
  requestedConversationId,
  activeConversationId,
  restoringConversationId,
}: {
  requestedConversationId: string | null
  activeConversationId: string | null
  restoringConversationId: string | null
}) {
  return Boolean(
    requestedConversationId
    && requestedConversationId === activeConversationId
    && !restoringConversationId
  )
}

export function planScopeTransitionFailure({
  targetConversationId,
  previousConversationId,
  previousHasDraftOrContent,
}: {
  targetConversationId: string | null
  previousConversationId: string | null
  previousHasDraftOrContent: boolean
}) {
  if (targetConversationId && !previousConversationId && !previousHasDraftOrContent) {
    return {
      kind: 'preserve-target' as const,
      retryConversationId: targetConversationId,
    }
  }
  return { kind: 'rollback' as const }
}
