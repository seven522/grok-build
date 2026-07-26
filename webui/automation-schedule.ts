/**
 * Pure, local-time scheduling primitives for persisted automations.
 *
 * The scheduler stores one `nextRunAt` value per automation. When it is in the
 * past, `evaluateScheduleDue` returns one enqueue decision only; callers must
 * calculate the replacement with `nextDueAt(schedule, now)` rather than
 * iterating from the old timestamp. That makes restart/misfire recovery
 * bounded and prevents a long downtime from replaying a backlog.
 */

export type ManualAutomationSchedule = {
  kind: 'manual'
}

export type IntervalAutomationSchedule = {
  kind: 'interval'
  everyMinutes: number
}

export type DailyAutomationSchedule = {
  kind: 'daily'
  hour: number
  minute: number
}

export type AutomationSchedule =
  | ManualAutomationSchedule
  | IntervalAutomationSchedule
  | DailyAutomationSchedule

export type AutomationScheduleInput = {
  kind?: unknown
  everyMinutes?: unknown
  hour?: unknown
  minute?: unknown
}

export type ScheduleDueDecision = {
  /** Whether the persisted next run is ready to enqueue. */
  due: boolean
  /** A ready run whose due time is before `now`, rather than exactly at it. */
  missed: boolean
  /** The persisted due time that was evaluated, if one exists. */
  scheduledFor: Date | null
  /** The recovery policy never produces more than one enqueue. */
  enqueueCount: 0 | 1
}

export class AutomationScheduleValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AutomationScheduleValidationError'
  }
}

const MINUTE_MS = 60_000
const MAX_INTERVAL_MINUTES = 7 * 24 * 60
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

function fail(message: string): never {
  throw new AutomationScheduleValidationError(message)
}

function asPlainRecord(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`${label}必须是对象`)
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) fail(`${label}必须是普通对象`)
  return input as Record<string, unknown>
}

function requireExactKeys(input: Record<string, unknown>, allowed: readonly string[], label: string) {
  const actual = Object.getOwnPropertyNames(input).sort()
  const expected = [...allowed].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label}包含不支持或缺失的字段`)
  }
}

function requireIntegerInRange(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(`${label}必须是 ${minimum} 到 ${maximum} 的整数`)
  }
  return value as number
}

function cloneValidDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) fail(`${label}必须是有效的 Date`)
  return new Date(value.getTime())
}

function parseScheduledFor(value: Date | string | null | undefined): Date | null {
  if (value == null) return null
  if (value instanceof Date) return cloneValidDate(value, 'scheduledFor')
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) {
    fail('scheduledFor必须是 ISO 8601 UTC 时间戳或 Date')
  }

  const parsed = new Date(value)
  const normalized = value.includes('.') ? value : value.replace('Z', '.000Z')
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== normalized) {
    fail('scheduledFor必须是有效的 ISO 8601 UTC 时间戳')
  }
  return parsed
}

/**
 * Parses an untrusted persisted/API value into the only supported schedules.
 * No implicit defaults or unknown fields are accepted so the control plane can
 * safely reject a malformed schedule before it reaches a worker.
 */
export function parseAutomationSchedule(input: unknown): AutomationSchedule {
  const record = asPlainRecord(input, '调度')
  if (typeof record.kind !== 'string') fail('调度类型不能为空')

  switch (record.kind) {
    case 'manual':
      requireExactKeys(record, ['kind'], 'manual 调度')
      return { kind: 'manual' }
    case 'interval':
      requireExactKeys(record, ['kind', 'everyMinutes'], 'interval 调度')
      return {
        kind: 'interval',
        everyMinutes: requireIntegerInRange(record.everyMinutes, 1, MAX_INTERVAL_MINUTES, 'everyMinutes'),
      }
    case 'daily':
      requireExactKeys(record, ['kind', 'hour', 'minute'], 'daily 调度')
      return {
        kind: 'daily',
        hour: requireIntegerInRange(record.hour, 0, 23, 'hour'),
        minute: requireIntegerInRange(record.minute, 0, 59, 'minute'),
      }
    default:
      fail('调度类型必须是 manual、interval 或 daily')
  }
}

function nextLocalDailyOccurrence(now: Date, hour: number, minute: number): Date {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0)
  if (today.getTime() > now.getTime()) return today

  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, minute, 0, 0)
  if (Number.isNaN(tomorrow.getTime())) fail('无法计算下一次 daily 调度时间')
  return tomorrow
}

/**
 * Returns the first future due time in the system's local timezone. `now` is
 * explicit so callers and tests can be deterministic. A manual schedule has
 * no future due time.
 */
export function nextDueAt(scheduleInput: AutomationSchedule, now: Date): Date | null {
  const schedule = parseAutomationSchedule(scheduleInput)
  const current = cloneValidDate(now, 'now')

  if (schedule.kind === 'manual') return null
  if (schedule.kind === 'interval') {
    const next = new Date(current.getTime() + schedule.everyMinutes * MINUTE_MS)
    if (Number.isNaN(next.getTime())) fail('无法计算下一次 interval 调度时间')
    return next
  }
  return nextLocalDailyOccurrence(current, schedule.hour, schedule.minute)
}

/**
 * Evaluates one persisted `nextRunAt` value. A missed schedule still creates
 * one enqueue decision only; it intentionally does not enumerate every
 * interval or day skipped while the app was offline.
 */
export function evaluateScheduleDue(
  scheduleInput: AutomationSchedule,
  now: Date,
  scheduledFor: Date | string | null | undefined,
): ScheduleDueDecision {
  const schedule = parseAutomationSchedule(scheduleInput)
  const current = cloneValidDate(now, 'now')
  const persistedDueAt = parseScheduledFor(scheduledFor)

  if (schedule.kind === 'manual' || !persistedDueAt) {
    return { due: false, missed: false, scheduledFor: persistedDueAt, enqueueCount: 0 }
  }

  const due = persistedDueAt.getTime() <= current.getTime()
  return {
    due,
    missed: due && persistedDueAt.getTime() < current.getTime(),
    scheduledFor: persistedDueAt,
    enqueueCount: due ? 1 : 0,
  }
}

/** Returns whether a persisted next run is ready; see `evaluateScheduleDue` for recovery details. */
export function isDue(
  scheduleInput: AutomationSchedule,
  now: Date,
  scheduledFor: Date | string | null | undefined,
): boolean {
  return evaluateScheduleDue(scheduleInput, now, scheduledFor).due
}
