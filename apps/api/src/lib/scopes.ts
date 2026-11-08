import type { Request } from 'express';
import { grant } from '../middleware.js';

/**
 * Inside a clinic, a permission's scope narrows what a member sees:
 *  org      — everything in the clinic
 *  branch   — their branches (or everything if they have no branch restriction)
 *  own      — a doctor's own appointments and patients
 *  assigned — a counsellor's own leads (plus unassigned ones to pick up)
 * Row-level security separates clinics; these SQL conditions separate people within one.
 */
export interface Scope { sql: string; repl: Record<string, unknown> }

const ALL: Scope = { sql: 'TRUE', repl: {} };
const NONE: Scope = { sql: 'FALSE', repl: {} };
const wide = (req: Request, scope: string) => scope === 'org' || (scope === 'branch' && req.ctx!.org!.branchIds.length === 0);

/** Condition on appointments `a` joined with doctors `d`. */
export function apptScope(req: Request, perm: string): Scope {
  const g = grant(req, perm);
  if (wide(req, g.scope)) return ALL;
  const mine = req.ctx!.org!.branchIds;
  if (g.scope === 'branch') {
    return {
      sql: `(a.branch_id IN (:mine) OR (a.branch_id IS NULL AND EXISTS (
              SELECT 1 FROM app.schedule_rules sr WHERE sr.doctor_id = a.doctor_id AND sr.branch_id IN (:mine))))`,
      repl: { mine },
    };
  }
  if (g.scope === 'own') return { sql: 'd.user_id = :me', repl: { me: req.ctx!.userId } };
  return NONE;
}

/** Condition on patient_profiles `pp`. */
export function patientScope(req: Request, perm: string): Scope {
  const g = grant(req, perm);
  if (wide(req, g.scope)) return ALL;
  const mine = req.ctx!.org!.branchIds;
  const me = req.ctx!.userId;
  if (g.scope === 'branch') {
    return {
      sql: `(pp.home_branch_id IS NULL OR pp.home_branch_id IN (:mine) OR EXISTS (
              SELECT 1 FROM app.appointments a2 WHERE a2.patient_profile_id = pp.id AND a2.branch_id IN (:mine)))`,
      repl: { mine },
    };
  }
  if (g.scope === 'own') {
    return {
      sql: `EXISTS (SELECT 1 FROM app.appointments a2 JOIN app.doctors d2 ON d2.id = a2.doctor_id
                     WHERE a2.patient_profile_id = pp.id AND d2.user_id = :me)`,
      repl: { me },
    };
  }
  if (g.scope === 'assigned') {
    // A counsellor sees the patients behind the leads they own.
    return {
      sql: `EXISTS (SELECT 1 FROM app.leads l2 WHERE l2.patient_id = pp.patient_id AND l2.organization_id = pp.organization_id AND l2.owner_user_id = :me)`,
      repl: { me },
    };
  }
  return NONE;
}

/** Condition on leads `l`. Leads without a branch (e.g. from ads) are clinic-wide. */
export function leadScope(req: Request, perm: string): Scope {
  const g = grant(req, perm);
  if (wide(req, g.scope)) return ALL;
  if (g.scope === 'branch') return { sql: '(l.branch_id IS NULL OR l.branch_id IN (:mine))', repl: { mine: req.ctx!.org!.branchIds } };
  if (g.scope === 'assigned') return { sql: `(l.owner_user_id = :me OR l.owner_kind = 'unassigned')`, repl: { me: req.ctx!.userId } };
  return NONE;
}
