import { ENTRY_KINDS, type EntryKind, type JournalEntry } from './model.js';

/**
 * Review scheduling.
 *
 * Deliberately not gamified: no streaks, no scores, no daily target. The only
 * question an entry asks when it resurfaces is "does this still surprise you?".
 * Confirming understanding pushes the entry further out; the third confirmation
 * retires it entirely. An entry you keep failing to retire is a signal about
 * where your model of the codebase is actually weak, which is the whole point.
 *
 * `todo` entries are excluded from the schedule — they are work items, not
 * knowledge, and resurfacing them on a decay curve would be noise.
 */

export const DEFAULT_INTERVALS = [7, 30, 90];

const SCHEDULED_KINDS: ReadonlySet<EntryKind> = new Set<EntryKind>(['wtf', 'quirk', 'idiom', 'learned']);

export function isScheduled(kind: EntryKind): boolean {
  return SCHEDULED_KINDS.has(kind);
}

function addDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Next resurfacing date for an entry at the given confidence, or null once the
 * entry has been confirmed past the end of the interval table.
 */
export function nextRevisit(
  kind: EntryKind,
  confidence: number,
  from: Date,
  intervals: number[] = DEFAULT_INTERVALS,
): string | null {
  if (!isScheduled(kind)) {
    return null;
  }
  const table = intervals.length > 0 ? intervals : DEFAULT_INTERVALS;
  if (confidence >= table.length) {
    return null;
  }
  return addDays(from, table[confidence]).toISOString();
}

export function isDue(e: JournalEntry, now: Date): boolean {
  if (!e.revisitAt) {
    return false;
  }
  const due = Date.parse(e.revisitAt);
  return Number.isFinite(due) && due <= now.getTime();
}

export function dueEntries(entries: JournalEntry[], now: Date): JournalEntry[] {
  return entries
    .filter((e) => isDue(e, now))
    .sort((a, b) => Date.parse(a.revisitAt!) - Date.parse(b.revisitAt!));
}

/** Apply a "still surprises me" outcome, resetting the entry to the front of the schedule. */
export function markUnclear(e: JournalEntry, now: Date, intervals?: number[]): JournalEntry {
  return {
    ...e,
    confidence: 0,
    revisitAt: nextRevisit(e.kind, 0, now, intervals),
    updated: now.toISOString(),
  };
}

/** Apply a "I understand this now" outcome, pushing the entry further out. */
export function markUnderstood(e: JournalEntry, now: Date, intervals?: number[]): JournalEntry {
  const confidence = e.confidence + 1;
  return {
    ...e,
    confidence,
    revisitAt: nextRevisit(e.kind, confidence, now, intervals),
    updated: now.toISOString(),
  };
}

/**
 * Convert an open question into recorded knowledge. Confidence resets, because
 * having just worked something out is the least durable moment of knowing it.
 */
export function resolveQuestion(e: JournalEntry, resolution: string, now: Date, intervals?: number[]): JournalEntry {
  const body = resolution.trim().length > 0 ? `${e.body.trimEnd()}\n\n**Resolved:** ${resolution.trim()}` : e.body;
  return {
    ...e,
    kind: 'learned',
    body,
    confidence: 0,
    revisitAt: nextRevisit('learned', 0, now, intervals),
    updated: now.toISOString(),
  };
}

export interface RampUpStatus {
  total: number;
  byKind: Record<EntryKind, number>;
  openQuestions: number;
  dueNow: number;
  retired: number;
  modulesTouched: number;
  oldestOpenQuestionDays: number | null;
}

/**
 * Ramp-up status. Not a productivity metric — a map of where understanding is
 * thin. `modulesTouched` counts distinct top-two-level directories, which is a
 * rough but useful proxy for breadth of exposure.
 */
export function rampUpStatus(entries: JournalEntry[], now: Date): RampUpStatus {
  const byKind = Object.fromEntries(ENTRY_KINDS.map((k) => [k, 0])) as Record<EntryKind, number>;
  const modules = new Set<string>();
  let retired = 0;
  let oldestOpen: number | null = null;

  for (const e of entries) {
    byKind[e.kind] += 1;
    if (e.file) {
      modules.add(e.file.split('/').slice(0, 2).join('/'));
    }
    if (isScheduled(e.kind) && e.revisitAt === null) {
      retired += 1;
    }
    if (e.kind === 'wtf') {
      const age = Date.parse(e.created);
      if (Number.isFinite(age) && (oldestOpen === null || age < oldestOpen)) {
        oldestOpen = age;
      }
    }
  }

  return {
    total: entries.length,
    byKind,
    openQuestions: byKind.wtf,
    dueNow: dueEntries(entries, now).length,
    retired,
    modulesTouched: modules.size,
    oldestOpenQuestionDays:
      oldestOpen === null ? null : Math.floor((now.getTime() - oldestOpen) / 86_400_000),
  };
}
