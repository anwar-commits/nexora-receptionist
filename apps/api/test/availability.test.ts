import { describe, expect, it } from 'vitest';
import { computeAvailability, type AvailabilityInput } from '../src/lib/availability.js';

// Monday 9 Nov 2026 in India. 10:00 IST = 04:30 UTC.
const base: AvailabilityInput = {
  timeZone: 'Asia/Kolkata', fromDate: '2026-11-09', days: 1, now: new Date('2026-11-01T00:00:00Z'), minLeadMinutes: 0,
  slotMinutes: 30, bufferMinutes: 0, maxOnlinePerDay: null, durationMinutes: 30, mode: 'clinic', branchId: null,
  rules: [{ weekday: 0, start: '10:00', end: '12:00', mode: 'clinic', branchId: 'B1' }],
  unavailable: [], holidays: [], busy: [],
};
const starts = (i: Partial<AvailabilityInput>) => computeAvailability({ ...base, ...i })[0]!.slots.map((s) => s.start);

describe('free-slot engine', () => {
  it('walks sessions in the clinic time zone', () => {
    expect(starts({})).toEqual(['2026-11-09T04:30:00.000Z', '2026-11-09T05:00:00.000Z', '2026-11-09T05:30:00.000Z', '2026-11-09T06:00:00.000Z']);
    // a 60-minute service must fit inside the session
    expect(starts({ durationMinutes: 60 })).toEqual(['2026-11-09T04:30:00.000Z', '2026-11-09T05:00:00.000Z', '2026-11-09T05:30:00.000Z']);
    // Tuesday has no session
    expect(starts({ fromDate: '2026-11-10' })).toEqual([]);
  });

  it('skips booked time with the gap between patients', () => {
    const busy = [{ start: new Date('2026-11-09T05:00:00Z'), end: new Date('2026-11-09T05:30:00Z'), mode: 'clinic' as const }];
    expect(starts({ busy })).toEqual(['2026-11-09T04:30:00.000Z', '2026-11-09T05:30:00.000Z', '2026-11-09T06:00:00.000Z']);
    // a 10-minute gap rules out the slots touching the booking on either side
    expect(starts({ busy, bufferMinutes: 10 })).toEqual(['2026-11-09T06:00:00.000Z']);
  });

  it('respects leave, holidays, branch and lead time', () => {
    const unavailable = [{ start: new Date('2026-11-09T04:00:00Z'), end: new Date('2026-11-09T05:15:00Z') }];
    expect(starts({ unavailable })).toEqual(['2026-11-09T05:30:00.000Z', '2026-11-09T06:00:00.000Z']);
    expect(starts({ holidays: [{ onDate: '2026-11-09', branchId: null }] })).toEqual([]);
    expect(starts({ holidays: [{ onDate: '2026-11-09', branchId: 'B1' }] })).toEqual([]);
    expect(starts({ holidays: [{ onDate: '2026-11-09', branchId: 'B2' }] })).toHaveLength(4);
    expect(starts({ branchId: 'B2' })).toEqual([]);
    expect(starts({ now: new Date('2026-11-09T05:10:00Z'), minLeadMinutes: 15 })).toEqual(['2026-11-09T05:30:00.000Z', '2026-11-09T06:00:00.000Z']);
  });

  it('separates modes and caps online consults per day', () => {
    const rules = [...base.rules, { weekday: 0, start: '18:00', end: '19:00', mode: 'video' as const, branchId: null }];
    expect(starts({ rules, mode: 'video' })).toEqual(['2026-11-09T12:30:00.000Z', '2026-11-09T13:00:00.000Z']);
    const busy = [{ start: new Date('2026-11-09T12:30:00Z'), end: new Date('2026-11-09T13:00:00Z'), mode: 'video' as const }];
    expect(starts({ rules, mode: 'video', busy, maxOnlinePerDay: 2 })).toEqual(['2026-11-09T13:00:00.000Z']);
    expect(starts({ rules, mode: 'video', busy, maxOnlinePerDay: 1 })).toEqual([]);
    // clinic bookings do not count against the online cap
    expect(starts({ rules, mode: 'video', maxOnlinePerDay: 1, busy: [{ ...busy[0]!, start: new Date('2026-11-09T04:30:00Z'), end: new Date('2026-11-09T05:00:00Z'), mode: 'clinic' }] })).toHaveLength(2);
  });

  it('honours validity dates and returns one entry per day', () => {
    const out = computeAvailability({ ...base, days: 8, rules: [{ ...base.rules[0]!, validTo: '2026-11-12' }] });
    expect(out.map((d) => d.date)).toEqual(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16']);
    expect(out[0]!.slots).toHaveLength(4);
    expect(out[7]!.slots).toHaveLength(0); // next Monday is after validTo
  });
});
