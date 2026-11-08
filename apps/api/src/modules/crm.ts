import {
  consentBody, leadBody, leadStageBody, noteBody, patientBody, scoringCondition, scoringRuleBody, taskBody, updateLeadBody, updateScoringRuleBody, updateTaskBody,
  type LeadStage,
} from '@dr/contracts';
import { Membership, QueryTypes } from '@dr/db';
import { Router, type Request } from 'express';
import { DateTime } from 'luxon';
import type { Deps } from '../context.js';
import { HttpError, conflict, forbidden, notFound } from '../errors.js';
import { auditFromReq } from '../lib/audit.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { createPatient, patientPhoneHash } from '../lib/patients.js';
import { DEFAULT_RULES, scoreLead, type ScoringRule } from '../lib/scoring.js';
import { apptScope, leadScope, patientScope } from '../lib/scopes.js';
import { grant, parse, requireOrg, requirePermission, requireUser } from '../middleware.js';

/**
 * Phase 6 (plan Phase 5): the patient pipeline. Leads move from enquiry to retained,
 * every change is an append-only event, the score is a transparent sum of rules,
 * and tasks and consents hang off leads and patients.
 */

type Repl = Record<string, unknown>;
const OPEN_STAGES: LeadStage[] = ['enquiry', 'qualified', 'booked', 'consulted', 'treatment_plan', 'follow_up'];
const badRequest = (message: string) => new HttpError(400, 'validation_failed', message);

interface LeadRow {
  id: string; display_name: string | null; phone_e164_enc: Buffer | null; interest: string | null; source: string; source_detail: Record<string, string>;
  stage: LeadStage; score: number; score_breakdown: unknown; owner_kind: 'ai' | 'user' | 'unassigned'; owner_user_id: string | null; owner_name: string | null;
  next_action_at: Date | null; wants_visit_by: string | null; branch_id: string | null; patient_id: string | null; patient_profile_id: string | null;
  mrn: string | null; patient_name: string | null; lost_reason: string | null; created_at: Date; updated_at: Date;
  has_upcoming: boolean; is_returning: boolean; last_activity: Date;
}

const LEAD_SELECT = `
  SELECT l.id, l.display_name, l.phone_e164_enc, l.interest, l.source, l.source_detail, l.stage, l.score, l.score_breakdown,
         l.owner_kind, l.owner_user_id, u.full_name AS owner_name, l.next_action_at, l.wants_visit_by::text, l.branch_id,
         l.patient_id, pp.id AS patient_profile_id, pp.mrn, p.full_name AS patient_name, l.lost_reason, l.created_at, l.updated_at,
         EXISTS (SELECT 1 FROM app.appointments a WHERE a.patient_profile_id = pp.id AND upper(a.slot) > now()
                  AND a.status IN ('booked','confirmed','checked_in','in_consultation')) AS has_upcoming,
         EXISTS (SELECT 1 FROM app.appointments a WHERE a.patient_profile_id = pp.id AND a.status = 'completed') AS is_returning,
         GREATEST(l.created_at, COALESCE((SELECT max(e.created_at) FROM app.lead_events e WHERE e.lead_id = l.id), l.created_at)) AS last_activity
    FROM app.leads l
    LEFT JOIN app.users u ON u.id = l.owner_user_id
    LEFT JOIN app.patient_profiles pp ON pp.patient_id = l.patient_id AND pp.organization_id = l.organization_id
    LEFT JOIN app.patients p ON p.id = l.patient_id`;

export function crmRouter(deps: Deps): Router {
  const { db, config } = deps;
  const r = Router();
  const user = requireUser(deps);
  const org = requireOrg(deps);
  const inOrg = <T>(req: Request, fn: () => Promise<T>) => db.withContext({ orgId: req.ctx!.org!.id, userId: req.ctx!.userId }, fn);
  const orgId = (req: Request) => req.ctx!.org!.id;
  const q = <T extends object>(sql: string, replacements: Repl = {}) => db.sequelize.query<T>(sql, { replacements, type: QueryTypes.SELECT });
  const exec = (sql: string, replacements: Repl = {}) => db.sequelize.query(sql, { replacements });

  // ---------- scoring ----------
  async function rules(req: Request): Promise<(ScoringRule & { id: string })[]> {
    let rows = await q<{ id: string; key: string; label: string; points: number; condition: unknown; is_active: boolean }>(
      `SELECT id, key, label, points, condition, is_active FROM app.lead_scoring_rules ORDER BY points DESC, key`);
    if (rows.length === 0) {
      for (const d of DEFAULT_RULES) {
        await exec(`INSERT INTO app.lead_scoring_rules (organization_id, key, label, points, condition, is_active) VALUES (:org, :key, :label, :points, CAST(:condition AS jsonb), true)`,
          { org: orgId(req), key: d.key, label: d.label, points: d.points, condition: JSON.stringify(d.condition) });
      }
      rows = await q(`SELECT id, key, label, points, condition, is_active FROM app.lead_scoring_rules ORDER BY points DESC, key`);
    }
    return rows.map((x) => ({ id: x.id, key: x.key, label: x.label, points: x.points, condition: scoringCondition.parse(x.condition), isActive: x.is_active }));
  }

  const timeZone = async () => (await q<{ timezone: string }>(`SELECT timezone FROM app.organizations WHERE id = NULLIF(current_setting('app.org_id', true), '')::uuid`))[0]?.timezone ?? 'Asia/Kolkata';

  /** Scores leads against the clinic's rules and stores any change. */
  async function scored(req: Request, rows: LeadRow[]) {
    if (rows.length === 0) return rows;
    const rs = await rules(req);
    const today = DateTime.now().setZone(await timeZone()).toISODate()!;
    for (const row of rows) {
      const res = scoreLead(rs, {
        interest: row.interest, source: row.source, wantsVisitBy: row.wants_visit_by, hasUpcomingAppointment: row.has_upcoming,
        isReturningPatient: row.is_returning, lastActivityAt: new Date(row.last_activity), today, now: new Date(),
      });
      if (res.score !== row.score || JSON.stringify(res.breakdown) !== JSON.stringify(row.score_breakdown)) {
        await exec(`UPDATE app.leads SET score = :score, score_breakdown = CAST(:b AS jsonb) WHERE id = :id`, { id: row.id, score: res.score, b: JSON.stringify(res.breakdown) });
      }
      row.score = res.score;
      row.score_breakdown = res.breakdown;
    }
    return rows;
  }

  const leadJson = (x: LeadRow) => ({
    id: x.id, displayName: x.display_name ?? x.patient_name, phone: x.phone_e164_enc ? decrypt(config.dataKey, x.phone_e164_enc) : null,
    interest: x.interest, source: x.source, sourceDetail: x.source_detail, stage: x.stage, score: x.score, scoreBreakdown: x.score_breakdown,
    ownerKind: x.owner_kind, ownerUserId: x.owner_user_id, ownerName: x.owner_name,
    nextActionAt: x.next_action_at ? new Date(x.next_action_at).toISOString() : null, wantsVisitBy: x.wants_visit_by, branchId: x.branch_id,
    patient: x.patient_profile_id ? { profileId: x.patient_profile_id, mrn: x.mrn, fullName: x.patient_name } : null,
    lostReason: x.lost_reason, createdAt: new Date(x.created_at).toISOString(), updatedAt: new Date(x.updated_at).toISOString(),
    hasUpcomingAppointment: x.has_upcoming,
    overdue: !!x.next_action_at && new Date(x.next_action_at) < new Date() && OPEN_STAGES.includes(x.stage),
  });

  async function loadLead(req: Request, id: string, perm: 'lead:read' | 'lead:manage') {
    const s = leadScope(req, perm);
    const [row] = await q<LeadRow>(`${LEAD_SELECT} WHERE l.id = :id AND ${s.sql}`, { id, ...s.repl });
    if (!row) throw notFound('Lead not found');
    return row;
  }

  async function event(req: Request, leadId: string, kind: string, extra: { from?: LeadStage | null; to?: LeadStage | null; note?: string | null; refType?: string; refId?: string } = {}) {
    await exec(`INSERT INTO app.lead_events (organization_id, lead_id, kind, from_stage, to_stage, ref_type, ref_id, actor_kind, actor_id, note)
                VALUES (:org, :lead, :kind, CAST(:from AS app.lead_stage), CAST(:to AS app.lead_stage), :refType, :refId, 'user', :me, :note)`,
      { org: orgId(req), lead: leadId, kind, from: extra.from ?? null, to: extra.to ?? null, refType: extra.refType ?? null, refId: extra.refId ?? null, me: req.ctx!.userId, note: extra.note ?? null });
  }

  async function assertOwner(req: Request, ownerKind: string, ownerUserId: string | null | undefined) {
    if (ownerKind !== 'user' || !ownerUserId) return;
    const m = await Membership.findOne({ where: { organizationId: orgId(req), userId: ownerUserId, status: 'active' } });
    if (!m) throw badRequest('That person is not active staff in this clinic');
  }

  async function profileToPatientId(req: Request, profileId: string, perm: string) {
    const s = patientScope(req, perm);
    const [row] = await q<{ patient_id: string }>(`SELECT pp.patient_id FROM app.patient_profiles pp WHERE pp.id = :id AND pp.deleted_at IS NULL AND ${s.sql}`, { id: profileId, ...s.repl });
    if (!row) throw badRequest('Unknown patient');
    return row.patient_id;
  }

  // =====================================================================
  // Scoring rules
  // =====================================================================
  r.get('/lead-scoring-rules', user, org, requirePermission('lead:read'), async (req, res) => {
    res.json({ items: await inOrg(req, () => rules(req)) });
  });

  r.post('/lead-scoring-rules', user, org, requirePermission('org:update'), async (req, res) => {
    const body = parse(scoringRuleBody, req.body);
    const out = await inOrg(req, async () => {
      await rules(req);
      try {
        await exec(`INSERT INTO app.lead_scoring_rules (organization_id, key, label, points, condition, is_active) VALUES (:org, :key, :label, :points, CAST(:c AS jsonb), :active)`,
          { org: orgId(req), key: body.key, label: body.label, points: body.points, c: JSON.stringify(body.condition), active: body.isActive });
      } catch (e) {
        if ((e as { original?: { code?: string } }).original?.code === '23505') throw conflict('A rule with this key already exists');
        throw e;
      }
      await auditFromReq(req, { action: 'lead_scoring.create', targetType: 'organization', targetId: orgId(req), details: { key: body.key, points: body.points } });
      return rules(req);
    });
    res.status(201).json({ items: out });
  });

  r.patch('/lead-scoring-rules/:id', user, org, requirePermission('org:update'), async (req, res) => {
    const body = parse(updateScoringRuleBody, req.body);
    const out = await inOrg(req, async () => {
      const [before] = await q<{ key: string; points: number; is_active: boolean }>(`SELECT key, points, is_active FROM app.lead_scoring_rules WHERE id = :id`, { id: String(req.params.id) });
      if (!before) throw notFound('Rule not found');
      await exec(`UPDATE app.lead_scoring_rules SET label = COALESCE(:label, label), points = COALESCE(:points, points), is_active = COALESCE(:active, is_active) WHERE id = :id`,
        { id: String(req.params.id), label: body.label ?? null, points: body.points ?? null, active: body.isActive ?? null });
      await auditFromReq(req, { action: 'lead_scoring.update', targetType: 'organization', targetId: orgId(req), details: { key: before.key, before: { points: before.points, isActive: before.is_active }, after: body } });
      return rules(req);
    });
    res.json({ items: out });
  });

  // =====================================================================
  // Leads
  // =====================================================================
  r.get('/leads', user, org, requirePermission('lead:read'), async (req, res) => {
    const items = await inOrg(req, async () => {
      const s = leadScope(req, 'lead:read');
      const conds = [s.sql];
      const repl: Repl = { ...s.repl };
      const owner = String(req.query.owner ?? '');
      if (owner === 'me') { conds.push('l.owner_user_id = :me'); repl.me = req.ctx!.userId; }
      else if (owner === 'ai' || owner === 'unassigned') { conds.push('l.owner_kind = :ok'); repl.ok = owner; }
      if (req.query.source) { conds.push('l.source = :source'); repl.source = String(req.query.source); }
      if (req.query.stage) { conds.push('l.stage = CAST(:stage AS app.lead_stage)'); repl.stage = String(req.query.stage); }
      if (req.query.patientProfileId) { conds.push('pp.id = :pid'); repl.pid = String(req.query.patientProfileId); }
      if (req.query.includeClosed !== '1') conds.push(`(l.stage NOT IN ('retained','lost') OR l.updated_at > now() - interval '30 days')`);
      const rows = await q<LeadRow>(`${LEAD_SELECT} WHERE ${conds.join(' AND ')} ORDER BY l.next_action_at NULLS LAST, l.created_at DESC LIMIT 500`, repl);
      return (await scored(req, rows)).map(leadJson);
    });
    res.json({ items });
  });

  r.get('/leads/:id', user, org, requirePermission('lead:read'), async (req, res) => {
    const out = await inOrg(req, async () => {
      const row = (await scored(req, [await loadLead(req, String(req.params.id), 'lead:read')]))[0]!;
      const events = await q<{ id: string; kind: string; from_stage: string | null; to_stage: string | null; note: string | null; ref_type: string | null; ref_id: string | null; actor_kind: string; actor_name: string | null; created_at: Date }>(
        `SELECT e.id, e.kind, e.from_stage, e.to_stage, e.note, e.ref_type, e.ref_id, e.actor_kind, u.full_name AS actor_name, e.created_at
           FROM app.lead_events e LEFT JOIN app.users u ON u.id = e.actor_id WHERE e.lead_id = :id ORDER BY e.created_at DESC, e.id`, { id: row.id });
      return {
        ...leadJson(row),
        events: events.map((e) => ({ id: e.id, kind: e.kind, fromStage: e.from_stage, toStage: e.to_stage, note: e.note, refType: e.ref_type, refId: e.ref_id, actor: e.actor_kind === 'user' ? e.actor_name : e.actor_kind, at: new Date(e.created_at).toISOString() })),
      };
    });
    res.json(out);
  });

  r.post('/leads', user, org, requirePermission('lead:manage'), async (req, res) => {
    const body = parse(leadBody, req.body);
    const g = grant(req, 'lead:manage');
    const mine = req.ctx!.org!.branchIds;
    let branchId = body.branchId ?? null;
    if (g.scope === 'branch' && mine.length) {
      branchId ??= mine[0]!;
      if (!mine.includes(branchId)) throw forbidden('You can only add leads for your branches');
    }
    // Counsellors own what they create.
    const ownerKind = g.scope === 'assigned' ? 'user' : body.ownerKind;
    const ownerUserId = g.scope === 'assigned' ? req.ctx!.userId : body.ownerUserId ?? null;
    const out = await inOrg(req, async () => {
      await assertOwner(req, ownerKind, ownerUserId);
      const hash = body.phone ? patientPhoneHash(deps, body.phone) : null;
      if (hash) {
        const [open] = await q<{ id: string }>(`SELECT id FROM app.leads WHERE phone_hash = :hash AND stage NOT IN ('retained','lost')`, { hash });
        if (open) throw new HttpError(409, 'conflict', 'This number already has an open lead', { leadId: open.id });
      }
      // Link to the patient: chosen explicitly, or the one registered patient with this exact number and name.
      let patientId: string | null = null;
      if (body.patientProfileId) patientId = await profileToPatientId(req, body.patientProfileId, 'patient:read');
      else if (hash && body.displayName) {
        const m = await q<{ patient_id: string }>(`SELECT p.id AS patient_id FROM app.patients p JOIN app.patient_profiles pp ON pp.patient_id = p.id
           WHERE p.phone_hash = :hash AND lower(p.full_name) = lower(:name) AND pp.deleted_at IS NULL`, { hash, name: body.displayName });
        if (m.length === 1) patientId = m[0]!.patient_id;
      }
      const [row] = await q<{ id: string }>(
        `INSERT INTO app.leads (organization_id, patient_id, display_name, phone_hash, phone_e164_enc, interest, source, source_detail, owner_kind, owner_user_id,
                                next_action_at, wants_visit_by, branch_id, created_by)
         VALUES (:org, :patient, :name, :hash, :enc, :interest, :source, CAST(:detail AS jsonb), :ownerKind, :ownerUserId, :next, :wants, :branch, :me) RETURNING id`,
        {
          org: orgId(req), patient: patientId, name: body.displayName ?? null, hash, enc: body.phone ? encrypt(config.dataKey, body.phone) : null,
          interest: body.interest ?? null, source: body.source, detail: JSON.stringify(body.sourceDetail), ownerKind, ownerUserId,
          next: body.nextActionAt ?? null, wants: body.wantsVisitBy ?? null, branch: branchId, me: req.ctx!.userId,
        });
      await event(req, row!.id, 'created', { to: 'enquiry', note: body.note ?? null });
      await auditFromReq(req, { action: 'lead.create', targetType: 'lead', targetId: row!.id, details: { source: body.source } });
      return leadJson((await scored(req, [await loadLead(req, row!.id, 'lead:read')]))[0]!);
    });
    res.status(201).json(out);
  });

  r.patch('/leads/:id', user, org, requirePermission('lead:manage'), async (req, res) => {
    const body = parse(updateLeadBody, req.body);
    const out = await inOrg(req, async () => {
      const row = await loadLead(req, String(req.params.id), 'lead:manage');
      const g = grant(req, 'lead:manage');
      const ownerKind = body.ownerKind ?? row.owner_kind;
      const ownerUserId = body.ownerKind !== undefined && body.ownerKind !== 'user' ? null : body.ownerUserId !== undefined ? body.ownerUserId : row.owner_user_id;
      if ((ownerKind === 'user') !== !!ownerUserId) throw badRequest('Choose who owns this lead');
      if (g.scope === 'assigned' && ownerUserId !== req.ctx!.userId && !(ownerKind === 'unassigned')) throw forbidden('You can only keep or release your own leads');
      await assertOwner(req, ownerKind, ownerUserId);
      const mine = req.ctx!.org!.branchIds;
      if (body.branchId && g.scope === 'branch' && mine.length && !mine.includes(body.branchId)) throw forbidden('You can only move leads to your branches');
      const patientId = body.patientProfileId === undefined ? undefined : body.patientProfileId === null ? null : await profileToPatientId(req, body.patientProfileId, 'patient:read');
      const sets: string[] = ['updated_at = now()'];
      const repl: Repl = { id: row.id };
      const put = (col: string, key: string, v: unknown) => { sets.push(`${col} = :${key}`); repl[key] = v; };
      if (body.displayName !== undefined) put('display_name', 'name', body.displayName);
      if (body.phone !== undefined) {
        put('phone_hash', 'hash', body.phone ? patientPhoneHash(deps, body.phone) : null);
        put('phone_e164_enc', 'enc', body.phone ? encrypt(config.dataKey, body.phone) : null);
      }
      if (body.interest !== undefined) put('interest', 'interest', body.interest);
      if (body.source !== undefined) put('source', 'source', body.source);
      if (body.branchId !== undefined) put('branch_id', 'branch', body.branchId);
      if (body.nextActionAt !== undefined) put('next_action_at', 'next', body.nextActionAt);
      if (body.wantsVisitBy !== undefined) put('wants_visit_by', 'wants', body.wantsVisitBy);
      if (patientId !== undefined) put('patient_id', 'patient', patientId);
      put('owner_kind', 'ok', ownerKind);
      put('owner_user_id', 'ou', ownerUserId);
      if (sets.some((x) => x.startsWith('display_name')) && body.displayName === null && !row.phone_e164_enc && body.phone === undefined) throw badRequest('Give a name or a mobile number');
      await exec(`UPDATE app.leads SET ${sets.join(', ')} WHERE id = :id`, repl);
      if (ownerKind !== row.owner_kind || ownerUserId !== row.owner_user_id) await event(req, row.id, 'owner_changed', { note: ownerKind === 'user' ? 'Assigned to a staff member' : ownerKind === 'ai' ? 'Handed to the AI' : 'Unassigned' });
      if (patientId !== undefined && patientId !== row.patient_id) await event(req, row.id, 'patient_linked', { refType: 'patient', refId: body.patientProfileId ?? undefined });
      await auditFromReq(req, { action: 'lead.update', targetType: 'lead', targetId: row.id, details: { fields: Object.keys(body) } });
      return leadJson((await scored(req, [await loadLead(req, row.id, 'lead:read')]))[0]!);
    });
    res.json(out);
  });

  r.post('/leads/:id/stage', user, org, requirePermission('lead:manage'), async (req, res) => {
    const body = parse(leadStageBody, req.body);
    const out = await inOrg(req, async () => {
      const row = await loadLead(req, String(req.params.id), 'lead:manage');
      if (row.stage === body.stage) return leadJson((await scored(req, [row]))[0]!);
      await exec(`UPDATE app.leads SET stage = CAST(:stage AS app.lead_stage), lost_reason = :reason, updated_at = now() WHERE id = :id`,
        { id: row.id, stage: body.stage, reason: body.stage === 'lost' ? body.lostReason! : null });
      await event(req, row.id, 'stage_changed', { from: row.stage, to: body.stage, note: body.stage === 'lost' ? body.lostReason : null });
      await auditFromReq(req, { action: 'lead.stage', targetType: 'lead', targetId: row.id, details: { from: row.stage, to: body.stage } });
      return leadJson((await scored(req, [await loadLead(req, row.id, 'lead:read')]))[0]!);
    });
    res.json(out);
  });

  r.post('/leads/:id/notes', user, org, requirePermission('lead:manage'), async (req, res) => {
    const body = parse(noteBody, req.body);
    await inOrg(req, async () => {
      const row = await loadLead(req, String(req.params.id), 'lead:manage');
      await event(req, row.id, 'note', { note: body.text });
      await exec(`UPDATE app.leads SET updated_at = now() WHERE id = :id`, { id: row.id });
    });
    res.status(201).json({ ok: true });
  });

  /** Registers the lead as a patient and links them, in one step (counsellors included). */
  r.post('/leads/:id/patient', user, org, requirePermission('lead:manage'), async (req, res) => {
    const body = parse(patientBody, req.body);
    const out = await inOrg(req, async () => {
      const row = await loadLead(req, String(req.params.id), 'lead:manage');
      if (row.patient_id) throw conflict('This lead is already linked to a patient');
      const profileId = await createPatient(deps, req, { ...body, acquisitionSource: body.acquisitionSource ?? row.source }, body.homeBranchId ?? row.branch_id);
      const [p] = await q<{ patient_id: string }>(`SELECT patient_id FROM app.patient_profiles WHERE id = :id`, { id: profileId });
      await exec(`UPDATE app.leads SET patient_id = :p, updated_at = now() WHERE id = :id`, { id: row.id, p: p!.patient_id });
      await event(req, row.id, 'patient_linked', { refType: 'patient', refId: profileId });
      return leadJson((await scored(req, [await loadLead(req, row.id, 'lead:read')]))[0]!);
    });
    res.status(201).json(out);
  });

  // =====================================================================
  // Tasks
  // =====================================================================
  const canSeeAllTasks = (req: Request) => req.ctx!.org!.grants.get('lead:manage')?.scope === 'org';
  const taskScope = (req: Request) => canSeeAllTasks(req)
    ? { sql: 'TRUE', repl: {} as Repl }
    : { sql: `((t.assignee_kind = 'user' AND t.assignee_ref = :meText) OR (t.assignee_kind = 'role' AND t.assignee_ref = :roleKey) OR t.created_by_user = :me)`, repl: { me: req.ctx!.userId, meText: req.ctx!.userId, roleKey: req.ctx!.org!.roleKey } as Repl };

  const TASK_SELECT = `SELECT t.id, t.kind, t.title, t.priority, t.status, t.assignee_kind, t.assignee_ref, u.full_name AS assignee_name, t.due_at, t.related_type, t.related_id,
      t.notes, t.created_at, t.completed_at, cu.full_name AS created_by_name,
      COALESCE(l.display_name, lp.full_name, p.full_name, ap.full_name) AS related_label
    FROM app.tasks t
    LEFT JOIN app.users u ON t.assignee_kind = 'user' AND u.id::text = t.assignee_ref
    LEFT JOIN app.users cu ON cu.id = t.created_by_user
    LEFT JOIN app.leads l ON t.related_type = 'lead' AND l.id = t.related_id
    LEFT JOIN app.patients lp ON lp.id = l.patient_id
    LEFT JOIN app.patient_profiles pp ON t.related_type = 'patient' AND pp.id = t.related_id
    LEFT JOIN app.patients p ON p.id = pp.patient_id
    LEFT JOIN app.appointments a ON t.related_type = 'appointment' AND a.id = t.related_id
    LEFT JOIN app.patient_profiles app_ ON app_.id = a.patient_profile_id
    LEFT JOIN app.patients ap ON ap.id = app_.patient_id`;
  const taskJson = (t: Record<string, unknown>) => ({
    id: t.id, kind: t.kind, title: t.title, priority: t.priority, status: t.status,
    assignee: { kind: t.assignee_kind, ref: t.assignee_ref, name: t.assignee_kind === 'role' ? String(t.assignee_ref).replace('_', ' ') : t.assignee_name },
    dueAt: t.due_at ? new Date(t.due_at as string).toISOString() : null, related: t.related_type ? { type: t.related_type, id: t.related_id, label: t.related_label } : null,
    notes: t.notes, createdAt: new Date(t.created_at as string).toISOString(), completedAt: t.completed_at ? new Date(t.completed_at as string).toISOString() : null,
    createdBy: t.created_by_name, overdue: !!t.due_at && new Date(t.due_at as string) < new Date() && ['open', 'in_progress'].includes(t.status as string),
  });

  r.get('/tasks', user, org, async (req, res) => {
    const items = await inOrg(req, async () => {
      const s = taskScope(req);
      const conds = [s.sql];
      const repl: Repl = { ...s.repl };
      if (req.query.mine === '1') { conds.push(`((t.assignee_kind = 'user' AND t.assignee_ref = :meText2) OR (t.assignee_kind = 'role' AND t.assignee_ref = :roleKey2))`); repl.meText2 = req.ctx!.userId; repl.roleKey2 = req.ctx!.org!.roleKey; }
      if (req.query.status === 'open' || !req.query.status) conds.push(`t.status IN ('open','in_progress')`);
      if (req.query.relatedType && req.query.relatedId) { conds.push('t.related_type = :rt AND t.related_id = :rid'); repl.rt = String(req.query.relatedType); repl.rid = String(req.query.relatedId); }
      const rows = await q<Record<string, unknown>>(`${TASK_SELECT} WHERE ${conds.join(' AND ')} ORDER BY t.due_at NULLS LAST, t.created_at DESC LIMIT 200`, repl);
      return rows.map(taskJson);
    });
    res.json({ items });
  });

  r.post('/tasks', user, org, async (req, res) => {
    const g = req.ctx!.org!.grants;
    if (!g.has('lead:manage') && !g.has('appointment:manage') && !g.has('patient:manage')) throw forbidden();
    const body = parse(taskBody, req.body);
    const out = await inOrg(req, async () => {
      if (body.assigneeUserId) {
        const m = await Membership.findOne({ where: { organizationId: orgId(req), userId: body.assigneeUserId, status: 'active' } });
        if (!m) throw badRequest('That person is not active staff in this clinic');
      }
      if (body.assigneeRole) {
        const [role] = await q<{ id: string }>(`SELECT id FROM app.roles WHERE key = :k AND (organization_id IS NULL OR organization_id = :org)`, { k: body.assigneeRole, org: orgId(req) });
        if (!role) throw badRequest('Unknown role');
      }
      if (body.relatedType === 'lead' && req.ctx!.org!.grants.has('lead:read')) await loadLead(req, body.relatedId!, 'lead:read');
      else if (body.relatedType === 'lead') throw forbidden();
      if (body.relatedType === 'patient') await profileToPatientId(req, body.relatedId!, 'patient:read');
      if (body.relatedType === 'appointment') {
        const [a] = await q<{ id: string }>(`SELECT id FROM app.appointments WHERE id = :id`, { id: body.relatedId });
        if (!a) throw badRequest('Unknown appointment');
      }
      const [row] = await q<{ id: string }>(
        `INSERT INTO app.tasks (organization_id, kind, title, priority, status, assignee_kind, assignee_ref, due_at, related_type, related_id, created_by_kind, created_by_user, notes)
         VALUES (:org, :kind, :title, CAST(:priority AS app.priority), 'open', :ak, :ar, :due, :rt, :rid, 'user', :me, :notes) RETURNING id`,
        { org: orgId(req), kind: body.kind, title: body.title, priority: body.priority, ak: body.assigneeUserId ? 'user' : 'role', ar: body.assigneeUserId ?? body.assigneeRole,
          due: body.dueAt ?? null, rt: body.relatedType ?? null, rid: body.relatedId ?? null, me: req.ctx!.userId, notes: body.notes ?? null });
      if (body.relatedType === 'lead') await event(req, body.relatedId!, 'task_created', { note: body.title, refType: 'task', refId: row!.id });
      await auditFromReq(req, { action: 'task.create', targetType: 'task', targetId: row!.id, details: { kind: body.kind } });
      const [t] = await q<Record<string, unknown>>(`${TASK_SELECT} WHERE t.id = :id`, { id: row!.id });
      return taskJson(t!);
    });
    res.status(201).json(out);
  });

  r.patch('/tasks/:id', user, org, async (req, res) => {
    const body = parse(updateTaskBody, req.body);
    const out = await inOrg(req, async () => {
      const s = taskScope(req);
      const [t] = await q<Record<string, unknown>>(`${TASK_SELECT} WHERE t.id = :id AND ${s.sql}`, { id: String(req.params.id), ...s.repl });
      if (!t) throw notFound('Task not found');
      if (['done', 'cancelled'].includes(t.status as string) && body.status && body.status !== t.status) throw conflict('This task is already closed');
      const closing = body.status === 'done' || body.status === 'cancelled';
      await exec(`UPDATE app.tasks SET status = COALESCE(CAST(:status AS app.task_status), status), title = COALESCE(:title, title),
                    priority = COALESCE(CAST(:priority AS app.priority), priority), due_at = CASE WHEN :dueSet THEN CAST(:due AS timestamptz) ELSE due_at END,
                    notes = CASE WHEN :notesSet THEN :notes ELSE notes END,
                    completed_at = CASE WHEN :closing THEN now() ELSE completed_at END, completed_by = CASE WHEN :closing THEN CAST(:me AS uuid) ELSE completed_by END
                  WHERE id = :id`,
        { id: t.id, status: body.status ?? null, title: body.title ?? null, priority: body.priority ?? null, dueSet: body.dueAt !== undefined, due: body.dueAt ?? null,
          notesSet: body.notes !== undefined, notes: body.notes ?? null, closing, me: req.ctx!.userId });
      if (closing && t.related_type === 'lead') await event(req, t.related_id as string, body.status === 'done' ? 'task_done' : 'task_cancelled', { note: t.title as string, refType: 'task', refId: t.id as string });
      await auditFromReq(req, { action: 'task.update', targetType: 'task', targetId: t.id as string, details: body });
      const [n] = await q<Record<string, unknown>>(`${TASK_SELECT} WHERE t.id = :id`, { id: t.id });
      return taskJson(n!);
    });
    res.json(out);
  });

  // =====================================================================
  // Consents (append-only ledger) and the patient timeline
  // =====================================================================
  async function patientIdFor(req: Request, profileId: string) {
    const s = patientScope(req, 'patient:read');
    const [row] = await q<{ patient_id: string }>(`SELECT pp.patient_id FROM app.patient_profiles pp WHERE pp.id = :id AND pp.deleted_at IS NULL AND ${s.sql}`, { id: profileId, ...s.repl });
    if (!row) throw notFound('Patient not found');
    return row.patient_id;
  }

  const consentRows = (patientId: string) => q<{ id: string; purpose: string; state: string; captured_via: string; evidence_ref: string | null; notice_version: string; recorded_by: string | null; recorded_at: Date }>(
    `SELECT c.id, c.purpose, c.state, c.captured_via, c.evidence_ref, c.notice_version, u.full_name AS recorded_by, c.recorded_at
       FROM app.consents c LEFT JOIN app.users u ON u.id = c.recorded_by_user
      WHERE c.patient_id = :p ORDER BY c.recorded_at DESC, c.id`, { p: patientId });

  r.get('/patients/:id/consents', user, org, requirePermission('patient:read'), async (req, res) => {
    const out = await inOrg(req, async () => {
      const rows = await consentRows(await patientIdFor(req, String(req.params.id)));
      const history = rows.map((c) => ({ id: c.id, purpose: c.purpose, state: c.state, capturedVia: c.captured_via, evidenceRef: c.evidence_ref, noticeVersion: c.notice_version, recordedBy: c.recorded_by, recordedAt: new Date(c.recorded_at).toISOString() }));
      const current: Record<string, (typeof history)[number]> = {};
      for (const h of history) current[h.purpose] ??= h;
      return { current, history };
    });
    res.json(out);
  });

  r.post('/patients/:id/consents', user, org, requirePermission('patient:manage'), async (req, res) => {
    const body = parse(consentBody, req.body);
    const out = await inOrg(req, async () => {
      const s = patientScope(req, 'patient:manage');
      const [row] = await q<{ patient_id: string }>(`SELECT pp.patient_id FROM app.patient_profiles pp WHERE pp.id = :id AND pp.deleted_at IS NULL AND ${s.sql}`, { id: String(req.params.id), ...s.repl });
      if (!row) throw notFound('Patient not found');
      const [c] = await q<{ id: string }>(
        `INSERT INTO app.consents (organization_id, patient_id, purpose, state, captured_via, evidence_ref, notice_version, recorded_by_user)
         VALUES (:org, :p, CAST(:purpose AS app.consent_purpose), CAST(:state AS app.consent_state), :via, :evidence, 'clinic-staff-v1', :me) RETURNING id`,
        { org: orgId(req), p: row.patient_id, purpose: body.purpose, state: body.state, via: body.capturedVia, evidence: body.evidenceRef ?? null, me: req.ctx!.userId });
      await auditFromReq(req, { action: 'consent.record', targetType: 'patient_profile', targetId: String(req.params.id), details: { purpose: body.purpose, state: body.state } });
      return { id: c!.id };
    });
    res.status(201).json(out);
  });

  /** Everything that happened with a patient, newest first: visits, pipeline, consents, tasks. */
  r.get('/patients/:id/timeline', user, org, requirePermission('patient:read'), async (req, res) => {
    const out = await inOrg(req, async () => {
      const profileId = String(req.params.id);
      const patientId = await patientIdFor(req, profileId);
      const items: { at: string; kind: string; title: string; detail?: string | null; actor?: string | null }[] = [];
      const g = req.ctx!.org!.grants;

      if (g.has('appointment:read')) {
        const s = apptScope(req, 'appointment:read');
        const appts = await q<{ id: string; start: Date; status: string; mode: string; service: string; doctor: string; created_at: Date; booked_by_kind: string; actor: string | null }>(
          `SELECT a.id, lower(a.slot) AS start, a.status, a.mode, s.name AS service, d.display_name AS doctor, a.created_at, a.booked_by_kind, u.full_name AS actor
             FROM app.appointments a JOIN app.doctors d ON d.id = a.doctor_id JOIN app.services s ON s.id = a.service_id LEFT JOIN app.users u ON u.id = a.booked_by_id
            WHERE a.patient_profile_id = :pid AND ${s.sql}`, { pid: profileId, ...s.repl });
        const tz = await timeZone();
        for (const a of appts) {
          items.push({ at: new Date(a.created_at).toISOString(), kind: 'appointment', title: `Booked ${a.service} with ${a.doctor}`,
            detail: `${DateTime.fromJSDate(new Date(a.start)).setZone(tz).toFormat('ccc d LLL, h:mm a')} · ${a.mode}`, actor: a.booked_by_kind === 'ai_agent' ? 'AI receptionist' : a.actor });
        }
        if (appts.length) {
          const changes = await q<{ action: string; details: Record<string, string>; created_at: Date; actor: string | null }>(
            `SELECT al.action, al.details, al.occurred_at AS created_at, u.full_name AS actor FROM app.audit_logs al LEFT JOIN app.users u ON u.id = al.actor_id
              WHERE al.organization_id = :org AND al.target_type = 'appointment' AND al.target_id IN (:ids) AND al.action IN ('appointment.status','appointment.cancel','appointment.reschedule')`,
            { org: orgId(req), ids: appts.map((a) => a.id) });
          const LABEL: Record<string, string> = { confirmed: 'Appointment confirmed', checked_in: 'Checked in', in_consultation: 'Went in to the doctor', completed: 'Visit completed', no_show: 'Did not come' };
          for (const c of changes) {
            const title = c.action === 'appointment.cancel' ? 'Appointment cancelled' : c.action === 'appointment.reschedule' ? 'Appointment moved' : LABEL[c.details.to ?? ''] ?? `Status: ${c.details.to}`;
            items.push({ at: new Date(c.created_at).toISOString(), kind: 'appointment', title, detail: c.details.reason ?? null, actor: c.actor });
          }
        }
      }
      if (g.has('lead:read')) {
        const s = leadScope(req, 'lead:read');
        const ev = await q<{ kind: string; from_stage: string | null; to_stage: string | null; note: string | null; created_at: Date; actor: string | null; actor_kind: string; interest: string | null }>(
          `SELECT e.kind, e.from_stage, e.to_stage, e.note, e.created_at, u.full_name AS actor, e.actor_kind, l.interest
             FROM app.lead_events e JOIN app.leads l ON l.id = e.lead_id LEFT JOIN app.users u ON u.id = e.actor_id
            WHERE l.patient_id = :p AND ${s.sql}`, { p: patientId, ...s.repl });
        const STAGE: Record<string, string> = { enquiry: 'Enquiry', qualified: 'Qualified', booked: 'Booked', consulted: 'Consulted', treatment_plan: 'Treatment plan', follow_up: 'Follow-up', retained: 'Retained', lost: 'Lost' };
        for (const e of ev) {
          const title = e.kind === 'created' ? `Enquiry${e.interest ? `: ${e.interest}` : ''}` : e.kind === 'stage_changed' ? `Pipeline: ${STAGE[e.from_stage ?? ''] ?? '—'} → ${STAGE[e.to_stage ?? '']}` :
            e.kind === 'note' ? 'Note' : e.kind === 'task_created' ? 'Task added' : e.kind === 'task_done' ? 'Task done' : e.kind === 'task_cancelled' ? 'Task cancelled' :
            e.kind === 'patient_linked' ? 'Registered as a patient' : e.kind === 'owner_changed' ? 'Owner changed' : e.kind.replace(/_/g, ' ');
          items.push({ at: new Date(e.created_at).toISOString(), kind: 'lead', title, detail: e.note, actor: e.actor_kind === 'user' ? e.actor : e.actor_kind === 'system' ? 'Automatic' : e.actor_kind });
        }
      }
      for (const c of await consentRows(patientId)) {
        const PURPOSE: Record<string, string> = { care_data_processing: 'data processing for care', whatsapp_updates: 'WhatsApp updates', ai_followup_calls: 'AI follow-up calls', marketing: 'marketing', call_recording_notice: 'call recording notice', data_share: 'data sharing', referral_contact: 'referral contact' };
        items.push({ at: new Date(c.recorded_at).toISOString(), kind: 'consent', title: `Consent ${c.state === 'given' ? 'given' : c.state}: ${PURPOSE[c.purpose] ?? c.purpose}`, detail: `Recorded ${c.captured_via === 'in_clinic' ? 'in the clinic' : c.captured_via.replace('_', ' ')}`, actor: c.recorded_by });
      }
      items.sort((a, b) => b.at.localeCompare(a.at));
      return { items: items.slice(0, 200) };
    });
    res.json(out);
  });

  return r;
}

/**
 * Called by scheduling: when a patient books, their open enquiry moves to "booked";
 * when a visit is completed, a "booked" lead moves to "consulted". Runs in the caller's transaction.
 */
export async function advanceLeadsForPatient(deps: Deps, req: Request | null, profileId: string, from: LeadStage[], to: LeadStage, refId: string) {
  const { db } = deps;
  const rows = await db.sequelize.query<{ id: string; old: LeadStage }>(
    `WITH moved AS (
       SELECT l.id, l.stage AS old FROM app.leads l JOIN app.patient_profiles pp ON pp.patient_id = l.patient_id AND pp.organization_id = l.organization_id
        WHERE pp.id = :pid AND l.stage IN (:from) FOR UPDATE OF l)
     UPDATE app.leads l SET stage = CAST(:to AS app.lead_stage), updated_at = now() FROM moved WHERE l.id = moved.id
     RETURNING l.id, moved.old`,
    { replacements: { pid: profileId, from, to }, type: QueryTypes.SELECT });
  for (const row of rows) {
    await db.sequelize.query(
      `INSERT INTO app.lead_events (organization_id, lead_id, kind, from_stage, to_stage, ref_type, ref_id, actor_kind, actor_id)
       SELECT organization_id, id, 'stage_changed', CAST(:old AS app.lead_stage), CAST(:to AS app.lead_stage), 'appointment', :ref, 'system', NULL FROM app.leads WHERE id = :id`,
      { replacements: { id: row.id, old: row.old, to, ref: refId } });
  }
  void req;
  return rows.length;
}
