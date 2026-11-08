import { DateTime } from 'luxon';

/**
 * Free-slot engine. Pure: everything it needs is passed in, so it is unit-tested
 * without a database and gives the same answer to staff, the AI and the patient app.
 *
 * All clock times (weekly hours, holidays) are in the clinic's time zone; instants
 * (appointments, leave, holds) are absolute. Days are walked in the clinic's zone.
 */

export type Mode = 'clinic' | 'video' | 'phone';

export interface WeeklyRule {
  weekday: number; // 0 = Monday
  start: string; // "HH:MM" or "HH:MM:SS"
  end: string;
  mode: Mode;
  branchId: string | null;
  validFrom?: string | null; // YYYY-MM-DD
  validTo?: string | null;
}
export interface Interval { start: Date; end: Date }
export interface Busy extends Interval { mode: Mode }

export interface AvailabilityInput {
  timeZone: string;
  /** First day to look at, YYYY-MM-DD in the clinic's zone. */
  fromDate: string;
  days: number;
  now: Date;
  /** Earliest bookable time is now + this. */
  minLeadMinutes: number;
  slotMinutes: number;
  bufferMinutes: number;
  maxOnlinePerDay: number | null;
  durationMinutes: number;
  mode: Mode;
  /** For clinic visits: only this branch. Null = any branch the doctor works at. */
  branchId: string | null;
  rules: WeeklyRule[];
  /** Leave and blocked time. */
  unavailable: Interval[];
  /** Holidays; branchId null = the whole clinic is closed. */
  holidays: { onDate: string; branchId: string | null }[];
  /** Live appointments and active holds for this doctor (excluding the one being moved, if any). */
  busy: Busy[];
}

export interface Slot { start: string; end: string; branchId: string | null; mode: Mode }
export interface DaySlots { date: string; slots: Slot[] }

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;
const online = (m: Mode) => m === 'video' || m === 'phone';

export function computeAvailability(input: AvailabilityInput): DaySlots[] {
  const zone = input.timeZone;
  const earliest = new Date(input.now.getTime() + input.minLeadMinutes * 60_000);
  const step = Math.max(5, input.slotMinutes);
  const out: DaySlots[] = [];
  const first = DateTime.fromISO(input.fromDate, { zone });
  if (!first.isValid) throw new Error('invalid fromDate');

  // Buffer applies after every appointment, existing and new.
  const busy = input.busy.map((b) => ({ ...b, end: new Date(b.end.getTime() + input.bufferMinutes * 60_000) }));

  for (let d = 0; d < input.days; d++) {
    const day = first.plus({ days: d });
    const date = day.toISODate()!;
    const weekday = day.weekday - 1; // luxon: 1 = Monday
    const slots: Slot[] = [];

    if (input.holidays.some((h) => h.onDate === date && h.branchId === null)) {
      out.push({ date, slots });
      continue;
    }
    if (online(input.mode) && input.maxOnlinePerDay !== null) {
      const dayStart = day.startOf('day').toJSDate();
      const dayEnd = day.plus({ days: 1 }).startOf('day').toJSDate();
      const used = input.busy.filter((b) => online(b.mode) && b.start >= dayStart && b.start < dayEnd).length;
      if (used >= input.maxOnlinePerDay) {
        out.push({ date, slots });
        continue;
      }
    }

    const sessions = input.rules
      .filter((r) => r.weekday === weekday && r.mode === input.mode)
      .filter((r) => input.mode !== 'clinic' || input.branchId === null || r.branchId === input.branchId)
      .filter((r) => (!r.validFrom || r.validFrom <= date) && (!r.validTo || date <= r.validTo))
      .filter((r) => !(r.branchId && input.holidays.some((h) => h.onDate === date && h.branchId === r.branchId)))
      .sort((a, b) => a.start.localeCompare(b.start));

    for (const r of sessions) {
      const [sh, sm] = r.start.split(':').map(Number) as [number, number];
      const [eh, em] = r.end.split(':').map(Number) as [number, number];
      const sessionStart = day.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
      const sessionEnd = day.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
      for (let t = sessionStart; t.plus({ minutes: input.durationMinutes }) <= sessionEnd; t = t.plus({ minutes: step })) {
        const start = t.toJSDate();
        const end = t.plus({ minutes: input.durationMinutes }).toJSDate();
        if (start < earliest) continue;
        const withBuffer = { start, end: new Date(end.getTime() + input.bufferMinutes * 60_000) };
        if (input.unavailable.some((u) => overlaps({ start, end }, u))) continue;
        if (busy.some((b) => overlaps(withBuffer, b))) continue;
        slots.push({ start: start.toISOString(), end: end.toISOString(), branchId: r.mode === 'clinic' ? r.branchId : null, mode: r.mode });
      }
    }
    // Two sessions can produce the same start (e.g. adjoining sessions); keep the first.
    const seen = new Set<string>();
    out.push({ date, slots: slots.filter((s) => (seen.has(s.start) ? false : (seen.add(s.start), true))) });
  }
  return out;
}

/** "Today" in the clinic's zone, as YYYY-MM-DD. */
export const todayIn = (timeZone: string, now = new Date()) => DateTime.fromJSDate(now, { zone: timeZone }).toISODate()!;
