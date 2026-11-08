import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, scoreLead, type LeadFacts } from '../src/lib/scoring.js';

const now = new Date('2026-11-08T06:00:00Z');
const base: LeadFacts = { interest: null, source: 'instagram', wantsVisitBy: null, hasUpcomingAppointment: false, isReturningPatient: false, lastActivityAt: now, today: '2026-11-08', now };

describe('lead scoring', () => {
  it('adds up only the rules that apply, with a breakdown', () => {
    expect(scoreLead(DEFAULT_RULES, base)).toEqual({ score: 0, breakdown: [] });
    const r = scoreLead(DEFAULT_RULES, { ...base, interest: 'FUE hair transplant', source: 'referral_partner', wantsVisitBy: '2026-11-12' });
    expect(r.score).toBe(50);
    expect(r.breakdown.map((b) => b.rule)).toEqual(['named_service', 'visit_within_7_days', 'referred']);
  });

  it('handles dates, inactivity and limits', () => {
    expect(scoreLead(DEFAULT_RULES, { ...base, wantsVisitBy: '2026-11-15' }).score).toBe(15); // 7 days away counts
    expect(scoreLead(DEFAULT_RULES, { ...base, wantsVisitBy: '2026-11-16' }).score).toBe(0);
    expect(scoreLead(DEFAULT_RULES, { ...base, wantsVisitBy: '2026-11-01' }).score).toBe(0); // in the past
    const quiet = { ...base, interest: 'PRP', lastActivityAt: new Date(now.getTime() - 5 * 86_400_000) };
    expect(scoreLead(DEFAULT_RULES, quiet)).toMatchObject({ score: 5, breakdown: [{ rule: 'named_service' }, { rule: 'quiet_5_days', points: -15 }] });
    expect(scoreLead(DEFAULT_RULES, { ...base, lastActivityAt: quiet.lastActivityAt }).score).toBe(0); // never below 0
    const all = { ...base, interest: 'x', source: 'doctor_referral', wantsVisitBy: '2026-11-09', hasUpcomingAppointment: true, isReturningPatient: true };
    expect(scoreLead(DEFAULT_RULES, all).score).toBe(85);
    expect(scoreLead(DEFAULT_RULES.map((r) => ({ ...r, points: 50 })), all).score).toBe(100); // never above 100
    expect(scoreLead(DEFAULT_RULES.map((r) => ({ ...r, isActive: false })), all).score).toBe(0);
  });
});
