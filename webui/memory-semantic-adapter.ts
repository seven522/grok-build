import {
  MemoryValidationError,
  memoryScopeAllows,
  type MemoryRecord,
  type MemoryScope,
} from './memory-store.ts'

/**
 * Adapters search already-isolated memory records only.  They never receive a
 * task-event ledger, an ACP transcript, credentials, or a database handle.
 * A future Mem0 implementation can satisfy this interface without becoming a
 * second task database.
 */
export type SemanticMemorySearchInput = {
  scope: MemoryScope
  query: string
  candidates: readonly MemoryRecord[]
  limit?: number
  includeUserScoped?: boolean
  includeRestricted?: boolean
}

export type SemanticMemoryHit = {
  record: MemoryRecord
  score: number
  matchingTerms: string[]
}

export interface SemanticMemoryAdapter {
  readonly name: string
  search(input: SemanticMemorySearchInput): Promise<SemanticMemoryHit[]>
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const MAX_QUERY_LENGTH = 4_096

const normalizedQuery = (value: unknown) => {
  if (typeof value !== 'string') throw new MemoryValidationError('memory search query 无效')
  const query = value.normalize('NFKC').trim()
  if (!query || query.length > MAX_QUERY_LENGTH || query.includes('\0')) throw new MemoryValidationError('memory search query 无效')
  return query.toLocaleLowerCase()
}

const searchLimit = (value: number | undefined) => {
  const limit = value ?? 12
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new MemoryValidationError('memory search limit 必须在 1 到 100 之间')
  return limit
}

/**
 * Tokenization intentionally requires no model or network.  CJK characters
 * get both single-character and adjacent-bigram tokens, while identifiers and
 * English words stay intact for code, command, and project vocabulary.
 */
export const deterministicMemoryTokens = (value: string): string[] => {
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
  const tokens = new Set<string>()
  for (const word of normalized.match(/[a-z0-9][a-z0-9_./:-]{1,127}/g) ?? []) tokens.add(word)
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (const character of run) tokens.add(character)
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2))
  }
  return [...tokens].sort((left, right) => left.localeCompare(right))
}

const sourceOrder = (left: SemanticMemoryHit, right: SemanticMemoryHit) => (
  right.score - left.score
  || Number(right.record.pinned) - Number(left.record.pinned)
  || right.record.confidence - left.record.confidence
  || Date.parse(right.record.updatedAt) - Date.parse(left.record.updatedAt)
  || left.record.id.localeCompare(right.record.id)
)

const isolatedCandidates = (input: SemanticMemorySearchInput) => input.candidates
  .filter((record) => record.status === 'active')
  .filter((record) => input.includeRestricted === true || record.sensitivity !== 'restricted')
  .filter((record) => memoryScopeAllows(record.scope, input.scope, { includeUserScoped: input.includeUserScoped === true }))

/**
 * The boundary used by both the local scorer and future remote adapters.  It
 * applies scope/status/sensitivity filtering before handing any memory to an
 * adapter, making cross-project leakage impossible at the call site.
 */
export async function retrieveSemanticMemories(
  adapter: SemanticMemoryAdapter,
  input: SemanticMemorySearchInput,
): Promise<SemanticMemoryHit[]> {
  const query = normalizedQuery(input.query)
  const limit = searchLimit(input.limit)
  const candidates = isolatedCandidates({ ...input, query })
  const hits = await adapter.search({ ...input, query, candidates, limit })
  const candidateById = new Map(candidates.map((record) => [record.id, record]))
  const unique = new Set<string>()
  return hits
    .filter((hit) => candidateById.has(hit.record.id))
    .filter((hit) => Number.isFinite(hit.score) && hit.score > 0)
    .filter((hit) => !unique.has(hit.record.id) && (unique.add(hit.record.id), true))
    .map((hit) => ({
      // An adapter can rank an opaque candidate, but cannot replace its
      // inspected content or scope with a look-alike record.
      record: clone(candidateById.get(hit.record.id) as MemoryRecord),
      score: Math.round(hit.score * 1_000_000) / 1_000_000,
      matchingTerms: [...new Set(hit.matchingTerms)].sort((left, right) => left.localeCompare(right)),
    }))
    .sort(sourceOrder)
    .slice(0, limit)
}

/**
 * Deterministic lexical baseline.  It is deliberately simple and inspectable:
 * title matches count more than fact matches; exact normalized phrase matches
 * receive a small bonus.  A future vector/Mem0 adapter may replace only this
 * scoring implementation through SemanticMemoryAdapter.
 */
export function createDeterministicSemanticMemoryAdapter(): SemanticMemoryAdapter {
  return {
    name: 'runbuild-deterministic-facts-v1',
    async search(input) {
      const query = normalizedQuery(input.query)
      const terms = deterministicMemoryTokens(query)
      if (!terms.length) return []
      return isolatedCandidates(input)
        .map((record): SemanticMemoryHit | null => {
          const title = record.title.normalize('NFKC').toLocaleLowerCase()
          const fact = record.fact.normalize('NFKC').toLocaleLowerCase()
          const titleTokens = new Set(deterministicMemoryTokens(title))
          const factTokens = new Set(deterministicMemoryTokens(fact))
          const matchingTerms = terms.filter((term) => titleTokens.has(term) || factTokens.has(term))
          if (!matchingTerms.length) return null
          const titleMatches = matchingTerms.filter((term) => titleTokens.has(term)).length
          const factMatches = matchingTerms.filter((term) => factTokens.has(term)).length
          const coverage = matchingTerms.length / terms.length
          const phraseBonus = title.includes(query) || fact.includes(query) ? 0.35 : 0
          const score = coverage * 10 + titleMatches * 1.4 + factMatches * 0.6 + phraseBonus + (record.pinned ? 0.2 : 0) + record.confidence / 100
          return { record: clone(record), score, matchingTerms }
        })
        .filter((hit): hit is SemanticMemoryHit => hit !== null)
        .sort(sourceOrder)
        .slice(0, searchLimit(input.limit))
    },
  }
}
