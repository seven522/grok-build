import {
  memoryScopeAllows,
  redactMemoryText,
  type MemoryRecord,
  type MemoryScope,
} from './memory-store.ts'
import type { SemanticMemoryHit } from './memory-semantic-adapter.ts'

export type MemoryContextSectionKind = 'project-rules' | 'scoped-facts' | 'current-session' | 'retrieved-memories'

export type MemoryContextBuildInput = {
  scope: MemoryScope
  projectRules?: readonly string[]
  /** A caller-generated summary; never a raw ACP event/transcript. */
  currentSessionSummary?: string
  facts?: readonly MemoryRecord[]
  retrievedMemories?: readonly (MemoryRecord | SemanticMemoryHit)[]
  maxChars?: number
  includeUserScoped?: boolean
  includeRestricted?: boolean
}

export type MemoryContextSection = {
  kind: MemoryContextSectionKind
  title: string
  included: number
  omitted: number
  memoryIds: string[]
}

export type DeterministicMemoryContext = {
  text: string
  maxChars: number
  usedChars: number
  redacted: boolean
  sections: MemoryContextSection[]
  includedMemoryIds: string[]
  omittedMemoryIds: string[]
}

const MAX_CONTEXT_CHARS = 128 * 1024

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const contextBudget = (value: number | undefined) => {
  const maxChars = value ?? 8_000
  if (!Number.isSafeInteger(maxChars) || maxChars < 64 || maxChars > MAX_CONTEXT_CHARS) {
    throw new Error(`memory context budget 必须在 64 到 ${MAX_CONTEXT_CHARS} 之间`)
  }
  return maxChars
}

const factOrder = (left: MemoryRecord, right: MemoryRecord) => (
  Number(right.pinned) - Number(left.pinned)
  || right.confidence - left.confidence
  || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  || left.id.localeCompare(right.id)
)

const retrievedOrder = (left: SemanticMemoryHit, right: SemanticMemoryHit) => (
  right.score - left.score
  || factOrder(left.record, right.record)
)

const isHit = (value: MemoryRecord | SemanticMemoryHit): value is SemanticMemoryHit => 'record' in value && 'score' in value

const visibleFact = (record: MemoryRecord, input: MemoryContextBuildInput) => (
  record.status === 'active'
  && (input.includeRestricted === true || record.sensitivity !== 'restricted')
  && memoryScopeAllows(record.scope, input.scope, { includeUserScoped: input.includeUserScoped === true })
)

const clipped = (value: string, maxChars: number) => {
  if (value.length <= maxChars) return value
  if (maxChars <= 1) return '…'.slice(0, maxChars)
  return `${value.slice(0, maxChars - 1).trimEnd()}…`
}

const recordLine = (record: MemoryRecord) => {
  const title = redactMemoryText(record.title).text.replace(/\s+/g, ' ').trim()
  const fact = redactMemoryText(record.fact).text.replace(/\s+/g, ' ').trim()
  const source = record.provenance.sourceEventIds.join(', ')
  const flags = [
    `confidence=${record.confidence.toFixed(3)}`,
    `sensitivity=${record.sensitivity}`,
    record.pinned ? 'pinned=true' : '',
  ].filter(Boolean).join('; ')
  return `- [${record.id}] ${title}: ${fact} (${flags}; sources=${source})`
}

const sectionTitle: Record<MemoryContextSectionKind, string> = {
  'project-rules': 'Project rules',
  'scoped-facts': 'Inspectable scoped facts',
  'current-session': 'Current session summary',
  'retrieved-memories': 'Retrieved memories',
}

type ContextEntry = {
  line: string
  memoryId?: string
  redacted: boolean
}

/**
 * Builds a bounded model-context string in a deliberately fixed order:
 * project rules -> scoped inspectable facts -> current session summary ->
 * retrieved memories.  Entries are whole-line and deterministically omitted
 * at the budget boundary rather than silently moving a later section ahead.
 */
export function buildDeterministicMemoryContext(input: MemoryContextBuildInput): DeterministicMemoryContext {
  const maxChars = contextBudget(input.maxChars)
  const seenMemoryIds = new Set<string>()
  const includedMemoryIds: string[] = []
  const omittedMemoryIds: string[] = []
  const sections: MemoryContextSection[] = []
  const fragments: string[] = []
  let usedChars = 0
  let redacted = false

  const appendSection = (kind: MemoryContextSectionKind, entries: readonly ContextEntry[]) => {
    if (!entries.length) return
    const heading = `## ${sectionTitle[kind]}\n`
    const prefix = fragments.length ? '\n\n' : ''
    let sectionText = ''
    let included = 0
    let omitted = 0
    const sectionMemoryIds: string[] = []
    for (const [index, entry] of entries.entries()) {
      const candidatePrefix = included === 0 ? `${prefix}${heading}` : ''
      const candidate = `${candidatePrefix}${entry.line}${index === entries.length - 1 ? '' : '\n'}`
      const remaining = maxChars - usedChars - sectionText.length
      if (candidate.length <= remaining) {
        sectionText += candidate
        included += 1
        redacted = redacted || entry.redacted
        if (entry.memoryId) {
          includedMemoryIds.push(entry.memoryId)
          sectionMemoryIds.push(entry.memoryId)
        }
        continue
      }
      // A long first entry may be clipped, but later entries are omitted: that
      // preserves both section order and a clear, reproducible budget policy.
      let keptCurrent = false
      if (included === 0 && remaining > prefix.length + heading.length + 4) {
        const lineBudget = remaining - prefix.length - heading.length
        const firstLine = clipped(entry.line, lineBudget)
        sectionText += `${prefix}${heading}${firstLine}`
        included += 1
        redacted = redacted || entry.redacted
        if (entry.memoryId) {
          includedMemoryIds.push(entry.memoryId)
          sectionMemoryIds.push(entry.memoryId)
        }
        keptCurrent = true
      }
      const skippedEntries = entries.slice(index + (keptCurrent ? 1 : 0))
      omitted += skippedEntries.length
      for (const skipped of skippedEntries) {
        if (skipped.memoryId) omittedMemoryIds.push(skipped.memoryId)
      }
      break
    }
    if (included) {
      fragments.push(sectionText)
      usedChars += sectionText.length
      sections.push({ kind, title: sectionTitle[kind], included, omitted, memoryIds: sectionMemoryIds })
    } else {
      for (const entry of entries) if (entry.memoryId) omittedMemoryIds.push(entry.memoryId)
      sections.push({ kind, title: sectionTitle[kind], included: 0, omitted: entries.length, memoryIds: [] })
    }
  }

  const projectRules = (input.projectRules ?? [])
    .map((rule) => redactMemoryText(rule))
    .map((rule) => ({ line: `- ${rule.text.replace(/\s+/g, ' ').trim()}`, redacted: rule.redacted }))
    .filter((rule) => rule.line !== '-')
  appendSection('project-rules', projectRules)

  const scopedFacts = (input.facts ?? [])
    .filter((record) => visibleFact(record, input))
    .sort(factOrder)
    .map((record) => ({
      line: recordLine(record),
      memoryId: record.id,
      redacted: redactMemoryText(record.title).redacted || redactMemoryText(record.fact).redacted || record.redacted,
    }))
  for (const fact of scopedFacts) if (fact.memoryId) seenMemoryIds.add(fact.memoryId)
  appendSection('scoped-facts', scopedFacts)

  const summary = input.currentSessionSummary === undefined ? undefined : redactMemoryText(input.currentSessionSummary)
  if (summary && summary.text.trim()) {
    appendSection('current-session', [{
      line: `- ${summary.text.replace(/\s+/g, ' ').trim()}`,
      redacted: summary.redacted,
    }])
  }

  const retrieved = (input.retrievedMemories ?? [])
    .map((candidate) => isHit(candidate) ? candidate : { record: candidate, score: 0, matchingTerms: [] })
    .filter((hit) => visibleFact(hit.record, input))
    .filter((hit) => !seenMemoryIds.has(hit.record.id))
    .sort(retrievedOrder)
    .map((hit) => ({
      line: recordLine(hit.record),
      memoryId: hit.record.id,
      redacted: redactMemoryText(hit.record.title).redacted || redactMemoryText(hit.record.fact).redacted || hit.record.redacted,
    }))
  appendSection('retrieved-memories', retrieved)

  return {
    text: fragments.join(''),
    maxChars,
    usedChars,
    redacted,
    sections,
    includedMemoryIds: [...new Set(includedMemoryIds)],
    omittedMemoryIds: [...new Set(omittedMemoryIds.filter((id) => !includedMemoryIds.includes(id)))],
  }
}

/** A clone helper for integrations that need a detached, inspectable result. */
export const cloneDeterministicMemoryContext = (context: DeterministicMemoryContext) => clone(context)
