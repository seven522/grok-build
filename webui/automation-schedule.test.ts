import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AutomationScheduleValidationError,
  evaluateScheduleDue,
  isDue,
  nextDueAt,
  parseAutomationSchedule,
} from './automation-schedule.ts'

function localDate(year: number, month: number, day: number, hour: number, minute = 0, second = 0, millisecond = 0): Date {
  return new Date(year, month - 1, day, hour, minute, second, millisecond)
}

test('strictly parses only the supported manual, interval, and daily schedule shapes', () => {
  assert.deepEqual(parseAutomationSchedule({ kind: 'manual' }), { kind: 'manual' })
  assert.deepEqual(parseAutomationSchedule({ kind: 'interval', everyMinutes: 15 }), { kind: 'interval', everyMinutes: 15 })
  assert.deepEqual(parseAutomationSchedule({ kind: 'daily', hour: 9, minute: 5 }), { kind: 'daily', hour: 9, minute: 5 })

  for (const invalid of [
    null,
    [],
    { kind: 'manual', everyMinutes: 5 },
    { kind: 'interval' },
    { kind: 'interval', everyMinutes: 0 },
    { kind: 'interval', everyMinutes: 1.5 },
    { kind: 'interval', everyMinutes: 10_081 },
    { kind: 'daily', hour: 24, minute: 0 },
    { kind: 'daily', hour: 8, minute: 60 },
    { kind: 'daily', hour: '08', minute: 0 },
    { kind: 'weekly', day: 1 },
  ]) {
    assert.throws(() => parseAutomationSchedule(invalid), AutomationScheduleValidationError)
  }
})

test('calculates the next interval from an injected clock and crosses midnight once', () => {
  const schedule = { kind: 'interval', everyMinutes: 15 } as const
  assert.deepEqual(nextDueAt(schedule, localDate(2026, 7, 25, 10, 0)), localDate(2026, 7, 25, 10, 15))
  assert.deepEqual(nextDueAt(schedule, localDate(2026, 7, 25, 23, 55)), localDate(2026, 7, 26, 0, 10))
  assert.equal(nextDueAt({ kind: 'manual' }, localDate(2026, 7, 25, 10, 0)), null)
})

test('calculates daily schedules in the system local timezone across the midnight boundary', () => {
  const midnight = { kind: 'daily', hour: 0, minute: 0 } as const
  const morning = { kind: 'daily', hour: 9, minute: 0 } as const

  assert.deepEqual(nextDueAt(midnight, localDate(2026, 7, 25, 23, 59, 59, 999)), localDate(2026, 7, 26, 0, 0))
  assert.deepEqual(nextDueAt(midnight, localDate(2026, 7, 25, 0, 0)), localDate(2026, 7, 26, 0, 0))
  assert.deepEqual(nextDueAt(morning, localDate(2026, 7, 25, 8, 59, 59, 999)), localDate(2026, 7, 25, 9, 0))
  assert.deepEqual(nextDueAt(morning, localDate(2026, 7, 25, 9, 0)), localDate(2026, 7, 26, 9, 0))
})

test('marks an exactly due schedule as ready without treating it as a misfire', () => {
  const schedule = { kind: 'interval', everyMinutes: 5 } as const
  const now = localDate(2026, 7, 25, 10, 5)
  const decision = evaluateScheduleDue(schedule, now, now.toISOString())

  assert.deepEqual(decision, {
    due: true,
    missed: false,
    scheduledFor: now,
    enqueueCount: 1,
  })
  assert.equal(isDue(schedule, now, now), true)
})

test('a missed schedule makes one recovery decision and advances from now without replaying a backlog', () => {
  const schedule = { kind: 'interval', everyMinutes: 5 } as const
  const scheduledFor = localDate(2026, 7, 25, 10, 5)
  const now = localDate(2026, 7, 25, 10, 35)
  const decision = evaluateScheduleDue(schedule, now, scheduledFor)

  assert.equal(decision.due, true)
  assert.equal(decision.missed, true)
  assert.equal(decision.enqueueCount, 1)
  assert.deepEqual(nextDueAt(schedule, now), localDate(2026, 7, 25, 10, 40))
  assert.equal(isDue(schedule, now, nextDueAt(schedule, now)), false)
})

test('rejects malformed persisted due times instead of silently treating them as ready', () => {
  const schedule = { kind: 'daily', hour: 9, minute: 0 } as const
  const now = localDate(2026, 7, 25, 10, 0)
  assert.throws(() => evaluateScheduleDue(schedule, now, '2026-07-25 09:00'), AutomationScheduleValidationError)
  assert.throws(() => evaluateScheduleDue(schedule, now, new Date('not-a-date')), AutomationScheduleValidationError)
  assert.equal(isDue({ kind: 'manual' }, now, null), false)
})
