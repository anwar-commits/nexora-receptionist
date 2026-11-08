import type { ScoringCondition } from '@dr/contracts';

/**
 * Lead score = sum of the points of the rules that apply. Transparent on purpose:
 * every lead carries a breakdown of which rule gave how many points.
 */

export interface ScoringRule { key: string; label: string; points: number; condition: ScoringCondition; isActive: boolean }
export interface LeadFacts {
  interest: string | null;
  source: string;
  wantsVisitBy: string | null; // YYYY-MM-DD
  hasUpcomingAppointment: boolean;
  isReturningPatient: boolean;
  lastActivityAt: Date;
  today: string; // YYYY-MM-DD in the clinic's zone
  now: Date;
}
export interface ScoreResult { score: number; breakdown: { rule: string; label: string; points: number }[] }

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

export function applies(c: ScoringCondition, f: LeadFacts): boolean {
  switch (c.type) {
    case 'named_service': return !!f.interest && f.interest.trim().length > 0;
    case 'source_in': return (c.values as string[]).includes(f.source);
    case 'wants_visit_within_days': return !!f.wantsVisitBy && daysBetween(f.today, f.wantsVisitBy) >= 0 && daysBetween(f.today, f.wantsVisitBy) <= c.days;
    case 'has_upcoming_appointment': return f.hasUpcomingAppointment;
    case 'returning_patient': return f.isReturningPatient;
    case 'no_activity_days': return f.now.getTime() - f.lastActivityAt.getTime() >= c.days * DAY;
  }
}

export function scoreLead(rules: ScoringRule[], f: LeadFacts): ScoreResult {
  const breakdown = rules.filter((r) => r.isActive && applies(r.condition, f)).map((r) => ({ rule: r.key, label: r.label, points: r.points }));
  const score = Math.max(0, Math.min(100, breakdown.reduce((n, b) => n + b.points, 0)));
  return { score, breakdown };
}

/** Starting rules for a new clinic. Clinics can change points or switch rules off. */
export const DEFAULT_RULES: ScoringRule[] = [
  { key: 'named_service', label: 'Named a service', points: 20, condition: { type: 'named_service' }, isActive: true },
  { key: 'visit_within_7_days', label: 'Wants a visit within 7 days', points: 15, condition: { type: 'wants_visit_within_days', days: 7 }, isActive: true },
  { key: 'referred', label: 'Referred by a partner or doctor', points: 15, condition: { type: 'source_in', values: ['referral_partner', 'doctor_referral'] }, isActive: true },
  { key: 'upcoming_visit', label: 'Has a visit booked', points: 25, condition: { type: 'has_upcoming_appointment' }, isActive: true },
  { key: 'returning', label: 'Returning patient', points: 10, condition: { type: 'returning_patient' }, isActive: true },
  { key: 'quiet_5_days', label: 'No activity for 5 days', points: -15, condition: { type: 'no_activity_days', days: 5 }, isActive: true },
];
