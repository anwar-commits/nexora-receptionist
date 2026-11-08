import { paymentBody, refundBody, walkInBody } from '@dr/contracts';
import { QueryTypes } from '@dr/db';
import { Router, type Request } from 'express';
import { DateTime } from 'luxon';
import type { Deps } from '../context.js';
import { HttpError, conflict, forbidden, notFound } from '../errors.js';
import { auditFromReq } from '../lib/audit.js';
import { decrypt } from '../lib/crypto.js';
import { apptScope, patientScope } from '../lib/scopes.js';
import { grant, parse, requireOrg, requirePermission, requireUser } from '../middleware.js';

/**
 * Phase 7: the front desk. Payments taken at the counter (cash, UPI, card) with numbered
 * receipts, refunds within each role's limit, the day's collection, and walk-ins.
 * Online payment links (Razorpay) arrive with integrations (Phase 13).
 */

type Repl = Record<string, unknown>;
const badRequest = (message: string) => new HttpError(400, 'validation_failed', message);
const LIVE_OR_DONE = `('booked','confirmed','checked_in','in_consultation','completed')`;

export function receptionRouter(deps: Deps): Router {
  const { db, config } = deps;
  const r = Router();
  const user = requireUser(deps);
  const org = requireOrg(deps);
  const inOrg = <T>(req: Request, fn: () => Promise<T>) => db.withContext({ orgId: req.ctx!.org!.id, userId: req.ctx!.userId }, fn);
  const q = <T extends object>(sql: string, replacements: Repl = {}) => db.sequelize.query<T>(sql, { replacements, type: QueryTypes.SELECT });
  const exec = (sql: string, replacements: Repl = {}) => db.sequelize.query(sql, { replacements });
  const orgId = (req: Request) => req.ctx!.org!.id;
  const tzOf = async () => (await q<{ timezone: string }>(`SELECT timezone FROM app.organizations WHERE id = NULLIF(current_setting('app.org_id', true), '')::uuid`))[0]?.timezone ?? 'Asia/Kolkata';

  /** Branch-scoped staff work only at their branches; returns the branch to use. */
  async function deskBranch(req: Request, perm: string, branchId: string | undefined | null) {
    const mine = req.ctx!.org!.branchIds;
    const g = grant(req, perm);
    if (branchId) {
      if (g.scope !== 'org' && mine.length && !mine.includes(branchId)) throw forbidden('This is not one of your branches');
      return branchId;
    }
    if (mine.length) return mine[0]!;
    const [b] = await q<{ id: string }>(`SELECT id FROM app.branches WHERE deleted_at IS NULL AND is_active ORDER BY created_at LIMIT 1`);
    if (!b) throw notFound('No open branch');
    return b.id;
  }

  // =====================================================================
  // Walk-ins
  // =====================================================================
  r.post('/queue/walk-in', user, org, requirePermission('appointment:manage'), async (req, res) => {
    const body = parse(walkInBody, req.body);
    const out = await inOrg(req, async () => {
      const branchId = await deskBranch(req, 'appointment:manage', body.branchId);
      const ps = patientScope(req, 'patient:read');
      const [p] = await q<{ id: string }>(`SELECT pp.id FROM app.patient_profiles pp WHERE pp.id = :id AND pp.deleted_at IS NULL AND ${ps.sql}`, { id: body.patientProfileId, ...ps.repl });
      if (!p) throw badRequest('Unknown patient');
      const [d] = await q<{ display_name: string }>(`SELECT display_name FROM app.doctors WHERE id = :id AND deleted_at IS NULL AND is_active`, { id: body.doctorId });
      if (!d) throw badRequest('Unknown or inactive doctor');
      const [s] = await q<{ id: string }>(`SELECT id FROM app.services WHERE id = :id AND is_active AND 'clinic' = ANY(modes)`, { id: body.serviceId });
      if (!s) throw badRequest('Unknown service, or not offered at the clinic');
      const date = DateTime.now().setZone(await tzOf()).toISODate()!;
      const letter = (d.display_name.replace(/^dr\.?\s*/i, '').trim().split(/\s+/).pop()?.[0] ?? 'T').toUpperCase().replace(/[^A-Z]/, 'T');
      await exec('SELECT pg_advisory_xact_lock(hashtext(:k))', { k: `${branchId}:${date}` });
      const [n] = await q<{ n: string; pos: string }>(
        `SELECT (SELECT count(*) FROM app.queue_tokens WHERE branch_id = :b AND service_date = :d AND token LIKE :prefix) AS n,
                (SELECT COALESCE(max(position), 0) FROM app.queue_tokens WHERE branch_id = :b AND service_date = :d AND doctor_id = :doc) AS pos`,
        { b: branchId, d: date, prefix: `${letter}-%`, doc: body.doctorId });
      const token = `${letter}-${String(Number(n!.n) + 1).padStart(2, '0')}`;
      const [t] = await q<{ id: string }>(
        `INSERT INTO app.queue_tokens (organization_id, branch_id, appointment_id, patient_profile_id, doctor_id, token, service_date, is_walk_in, status, position, service_id, created_by)
         VALUES (:org, :b, NULL, :pp, :doc, :token, :d, true, 'waiting', :pos, :svc, :me) RETURNING id`,
        { org: orgId(req), b: branchId, pp: body.patientProfileId, doc: body.doctorId, token, d: date, pos: Number(n!.pos) + 1, svc: body.serviceId, me: req.ctx!.userId });
      await auditFromReq(req, { action: 'queue.walk_in', targetType: 'queue_token', targetId: t!.id, details: { token, doctorId: body.doctorId } });
      return { id: t!.id, token };
    });
    res.status(201).json(out);
  });

  /** Walk-ins have no appointment, so their token is moved along directly. */
  const walkInStep = (step: 'in_room' | 'done') => async (req: Request, res: import('express').Response) => {
    await inOrg(req, async () => {
      const [t] = await q<{ id: string; branch_id: string; status: string; appointment_id: string | null }>(`SELECT id, branch_id, status, appointment_id FROM app.queue_tokens WHERE id = :id`, { id: String(req.params.id) });
      if (!t) throw notFound('Token not found');
      await deskBranch(req, 'appointment:manage', t.branch_id);
      if (t.appointment_id) throw conflict('This patient has an appointment: update the appointment instead');
      const allowed = step === 'in_room' ? ['waiting', 'called'] : ['waiting', 'called', 'in_room'];
      if (!allowed.includes(t.status)) throw conflict(`A ${t.status.replace('_', ' ')} token cannot move to ${step.replace('_', ' ')}`);
      await exec(`UPDATE app.queue_tokens SET status = :s, status_changed_at = now() WHERE id = :id`, { id: t.id, s: step });
      await auditFromReq(req, { action: `queue.${step}`, targetType: 'queue_token', targetId: t.id });
    });
    res.json({ ok: true });
  };
  r.post('/queue/:id/in-room', user, org, requirePermission('appointment:manage'), walkInStep('in_room'));
  r.post('/queue/:id/done', user, org, requirePermission('appointment:manage'), walkInStep('done'));

  // =====================================================================
  // Payments
  // =====================================================================
  const PAY_SELECT = `
    SELECT py.id, py.receipt_number, py.amount_paise, py.refunded_paise, py.method, py.status, py.purpose, py.reference, py.created_at, py.captured_at,
           py.branch_id, py.appointment_id, py.queue_token_id, py.patient_profile_id, pp.mrn, p.full_name AS patient_name, u.full_name AS collected_by
      FROM app.payments py
      JOIN app.patient_profiles pp ON pp.id = py.patient_profile_id JOIN app.patients p ON p.id = pp.patient_id
      LEFT JOIN app.users u ON u.id = py.collected_by`;
  const payJson = (x: Record<string, unknown>) => ({
    id: x.id, receiptNumber: x.receipt_number, amountPaise: Number(x.amount_paise), refundedPaise: Number(x.refunded_paise), method: x.method, status: x.status,
    purpose: x.purpose, reference: x.reference, branchId: x.branch_id, appointmentId: x.appointment_id, queueTokenId: x.queue_token_id,
    patient: { profileId: x.patient_profile_id, mrn: x.mrn, fullName: x.patient_name }, collectedBy: x.collected_by,
    at: new Date((x.captured_at ?? x.created_at) as string).toISOString(),
  });

  /** Fee due for a visit minus what was already collected (net of refunds). */
  async function dueFor(kind: 'appointment' | 'token', id: string) {
    if (kind === 'appointment') {
      const [a] = await q<{ fee: string | null; paid: string; patient: string; branch: string | null; status: string; service: string }>(
        `SELECT a.fee_paise AS fee, a.patient_profile_id AS patient, a.branch_id AS branch, a.status, s.name AS service,
                COALESCE((SELECT sum(amount_paise - refunded_paise) FROM app.payments WHERE appointment_id = a.id AND status IN ('captured','partially_refunded','refunded')), 0) AS paid
           FROM app.appointments a JOIN app.services s ON s.id = a.service_id WHERE a.id = :id`, { id });
      return a ? { fee: a.fee === null ? null : Number(a.fee), paid: Number(a.paid), patient: a.patient, branch: a.branch, status: a.status, service: a.service } : null;
    }
    const [t] = await q<{ fee: string | null; paid: string; patient: string; branch: string; status: string; service: string | null }>(
      `SELECT COALESCE(ds.fee_override_paise, s.fee_paise) AS fee, t.patient_profile_id AS patient, t.branch_id AS branch, t.status, s.name AS service,
              COALESCE((SELECT sum(amount_paise - refunded_paise) FROM app.payments WHERE queue_token_id = t.id AND status IN ('captured','partially_refunded','refunded')), 0) AS paid
         FROM app.queue_tokens t LEFT JOIN app.services s ON s.id = t.service_id
         LEFT JOIN app.doctor_services ds ON ds.doctor_id = t.doctor_id AND ds.service_id = t.service_id WHERE t.id = :id`, { id });
    return t ? { fee: t.fee === null ? null : Number(t.fee), paid: Number(t.paid), patient: t.patient, branch: t.branch, status: t.status, service: t.service } : null;
  }

  /** Visits today at the desk's branch that still owe money. */
  r.get('/payments/due', user, org, requirePermission('payment:collect'), async (req, res) => {
    const out = await inOrg(req, async () => {
      const branchId = await deskBranch(req, 'payment:collect', req.query.branchId ? String(req.query.branchId) : undefined);
      const tz = await tzOf();
      const day = DateTime.now().setZone(tz);
      const a = await q<Record<string, unknown>>(
        `SELECT 'appointment' AS kind, a.id, a.patient_profile_id, pp.mrn, p.full_name, s.name AS service, d.display_name AS doctor, a.status::text AS status, lower(a.slot) AS at, a.fee_paise AS fee,
                COALESCE((SELECT sum(amount_paise - refunded_paise) FROM app.payments WHERE appointment_id = a.id AND status IN ('captured','partially_refunded','refunded')), 0) AS paid,
                (SELECT token FROM app.queue_tokens WHERE appointment_id = a.id) AS token
           FROM app.appointments a JOIN app.services s ON s.id = a.service_id JOIN app.doctors d ON d.id = a.doctor_id
           JOIN app.patient_profiles pp ON pp.id = a.patient_profile_id JOIN app.patients p ON p.id = pp.patient_id
          WHERE a.branch_id = :b AND a.slot && tstzrange(:from, :to) AND a.status IN ${LIVE_OR_DONE} AND a.fee_paise > 0
         UNION ALL
         SELECT 'walk_in', t.id, t.patient_profile_id, pp.mrn, p.full_name, s.name, d.display_name, t.status, t.checked_in_at, COALESCE(ds.fee_override_paise, s.fee_paise),
                COALESCE((SELECT sum(amount_paise - refunded_paise) FROM app.payments WHERE queue_token_id = t.id AND status IN ('captured','partially_refunded','refunded')), 0),
                t.token
           FROM app.queue_tokens t JOIN app.services s ON s.id = t.service_id JOIN app.doctors d ON d.id = t.doctor_id
           LEFT JOIN app.doctor_services ds ON ds.doctor_id = t.doctor_id AND ds.service_id = t.service_id
           JOIN app.patient_profiles pp ON pp.id = t.patient_profile_id JOIN app.patients p ON p.id = pp.patient_id
          WHERE t.branch_id = :b AND t.service_date = :date AND t.is_walk_in AND t.status <> 'left' AND COALESCE(ds.fee_override_paise, s.fee_paise) > 0
          ORDER BY at`,
        { b: branchId, from: day.startOf('day').toISO(), to: day.endOf('day').toISO(), date: day.toISODate() });
      const items = a.map((x) => ({
        kind: x.kind, id: x.id, patient: { profileId: x.patient_profile_id, mrn: x.mrn, fullName: x.full_name }, service: x.service, doctor: x.doctor, status: x.status,
        at: new Date(x.at as string).toISOString(), feePaise: Number(x.fee), paidPaise: Number(x.paid), duePaise: Math.max(0, Number(x.fee) - Number(x.paid)), token: x.token,
      }));
      return { branchId, items, totalDuePaise: items.reduce((n, i) => n + i.duePaise, 0) };
    });
    res.json(out);
  });

  r.post('/payments', user, org, requirePermission('payment:collect'), async (req, res) => {
    const body = parse(paymentBody, req.body);
    const result = await inOrg(req, async () => {
      const [existing] = await q<Record<string, unknown>>(`${PAY_SELECT} WHERE py.idempotency_key = :k`, { k: body.idempotencyKey });
      if (existing) return { created: false, payment: payJson(existing) };

      const ps = patientScope(req, 'patient:read');
      const [p] = await q<{ id: string; home_branch_id: string | null }>(`SELECT pp.id, pp.home_branch_id FROM app.patient_profiles pp WHERE pp.id = :id AND pp.deleted_at IS NULL AND ${ps.sql}`, { id: body.patientProfileId, ...ps.repl });
      if (!p) throw badRequest('Unknown patient');
      let branchId: string | null = null;
      if (body.appointmentId || body.queueTokenId) {
        const kind = body.appointmentId ? 'appointment' : 'token';
        if (kind === 'appointment') {
          const s = apptScope(req, 'appointment:read');
          const [ok] = await q<{ id: string }>(`SELECT a.id FROM app.appointments a JOIN app.doctors d ON d.id = a.doctor_id WHERE a.id = :id AND ${s.sql}`, { id: body.appointmentId, ...s.repl });
          if (!ok) throw badRequest('Unknown appointment');
        }
        // Lock the visit so two desks cannot collect the same fee at once.
        await exec('SELECT pg_advisory_xact_lock(hashtext(:k))', { k: `pay:${body.appointmentId ?? body.queueTokenId}` });
        const due = await dueFor(kind, (body.appointmentId ?? body.queueTokenId)!);
        if (!due) throw badRequest(`Unknown ${kind === 'appointment' ? 'appointment' : 'walk-in'}`);
        if (due.patient !== body.patientProfileId) throw badRequest('That visit belongs to another patient');
        if (['cancelled', 'rescheduled', 'no_show', 'left'].includes(due.status)) throw conflict(`This visit is ${due.status.replace('_', ' ')}; nothing to collect`);
        if (due.fee !== null && body.amountPaise > due.fee - due.paid) {
          throw conflict(due.fee - due.paid <= 0 ? 'This visit is already paid' : `Only ₹${(due.fee - due.paid) / 100} is due for this visit`);
        }
        branchId = due.branch;
      }
      branchId = await deskBranch(req, 'payment:collect', branchId ?? p.home_branch_id);
      const [counter] = await q<{ n: number; prefix: string | null }>(
        `UPDATE app.organization_settings SET next_receipt = next_receipt + 1 WHERE organization_id = :org RETURNING next_receipt - 1 AS n, mrn_prefix AS prefix`, { org: orgId(req) });
      const receipt = `${counter!.prefix ?? 'RC'}-R-${String(counter!.n).padStart(5, '0')}`;
      const [row] = await q<{ id: string }>(
        `INSERT INTO app.payments (organization_id, branch_id, patient_profile_id, appointment_id, queue_token_id, purpose, amount_paise, method, status, receipt_number,
                                   collected_by, idempotency_key, reference, captured_at)
         VALUES (:org, :b, :pp, :a, :t, :purpose, :amount, :method, 'captured', :receipt, :me, :k, :ref, now()) RETURNING id`,
        { org: orgId(req), b: branchId, pp: body.patientProfileId, a: body.appointmentId ?? null, t: body.queueTokenId ?? null, purpose: body.purpose, amount: body.amountPaise,
          method: body.method, receipt, me: req.ctx!.userId, k: body.idempotencyKey, ref: body.reference ?? null });
      await auditFromReq(req, { action: 'payment.collect', targetType: 'payment', targetId: row!.id, details: { amountPaise: body.amountPaise, method: body.method, receipt } });
      const [created] = await q<Record<string, unknown>>(`${PAY_SELECT} WHERE py.id = :id`, { id: row!.id });
      return { created: true, payment: payJson(created!) };
    });
    res.status(result.created ? 201 : 200).json(result.payment);
  });

  async function loadPayment(req: Request, id: string, perm: string) {
    const [x] = await q<Record<string, unknown>>(`${PAY_SELECT} WHERE py.id = :id`, { id });
    if (!x) throw notFound('Payment not found');
    const mine = req.ctx!.org!.branchIds;
    if (grant(req, perm).scope !== 'org' && mine.length && x.branch_id && !mine.includes(x.branch_id as string)) throw notFound('Payment not found');
    return x;
  }

  /** Refund at the desk. Receptionists have a limit set by the clinic; the owner and branch managers do not. */
  r.post('/payments/:id/refund', user, org, requirePermission('payment:refund'), async (req, res) => {
    const body = parse(refundBody, req.body);
    const out = await inOrg(req, async () => {
      await exec('SELECT pg_advisory_xact_lock(hashtext(:k))', { k: `refund:${String(req.params.id)}` });
      const x = await loadPayment(req, String(req.params.id), 'payment:refund');
      const left = Number(x.amount_paise) - Number(x.refunded_paise);
      if (body.amountPaise > left) throw conflict(left <= 0 ? 'This payment is already fully refunded' : `At most ₹${left / 100} can be refunded`);
      const role = req.ctx!.org!.roleKey;
      if (!['owner', 'branch_manager'].includes(role) && grant(req, 'payment:refund').scope !== 'org') {
        const [s] = await q<{ limit: string }>(`SELECT refund_limit_receptionist_paise AS limit FROM app.organization_settings WHERE organization_id = :org`, { org: orgId(req) });
        if (body.amountPaise > Number(s!.limit)) throw forbidden(`Refunds above ₹${Number(s!.limit) / 100} need the owner or a branch manager`);
      }
      await exec(`INSERT INTO app.refunds (organization_id, payment_id, amount_paise, reason, approved_by, status) VALUES (:org, :p, :amt, :reason, :me, 'processed')`,
        { org: orgId(req), p: x.id, amt: body.amountPaise, reason: body.reason, me: req.ctx!.userId });
      const total = Number(x.refunded_paise) + body.amountPaise;
      await exec(`UPDATE app.payments SET refunded_paise = :t, status = CAST(:s AS app.payment_status) WHERE id = :id`,
        { id: x.id, t: total, s: total >= Number(x.amount_paise) ? 'refunded' : 'partially_refunded' });
      await auditFromReq(req, { action: 'payment.refund', targetType: 'payment', targetId: x.id as string, details: { amountPaise: body.amountPaise, reason: body.reason } });
      return payJson((await loadPayment(req, x.id as string, 'payment:refund')));
    });
    res.json(out);
  });

  /** The day's collection at a branch: every payment, totals by method and by person, refunds. */
  r.get('/payments', user, org, requirePermission('payment:collect'), async (req, res) => {
    const out = await inOrg(req, async () => {
      const tz = await tzOf();
      const date = req.query.date ? String(req.query.date) : DateTime.now().setZone(tz).toISODate()!;
      const d = DateTime.fromISO(date, { zone: tz });
      if (!d.isValid) throw badRequest('Use YYYY-MM-DD');
      const conds = ['py.created_at >= :from AND py.created_at < :to'];
      const repl: Repl = { from: d.startOf('day').toISO(), to: d.plus({ days: 1 }).startOf('day').toISO() };
      if (req.query.patientProfileId) { conds.length = 0; conds.push('py.patient_profile_id = :pid'); repl.pid = String(req.query.patientProfileId); }
      else {
        const branchId = await deskBranch(req, 'payment:collect', req.query.branchId ? String(req.query.branchId) : undefined);
        conds.push('py.branch_id = :b'); repl.b = branchId;
      }
      const rows = await q<Record<string, unknown>>(`${PAY_SELECT} WHERE ${conds.join(' AND ')} ORDER BY py.created_at DESC`, repl);
      const items = rows.map(payJson);
      const refunds = req.query.patientProfileId ? [] : await q<{ amount: string; method: string }>(
        `SELECT r.amount_paise AS amount, py.method FROM app.refunds r JOIN app.payments py ON py.id = r.payment_id
          WHERE r.created_at >= :from AND r.created_at < :to AND py.branch_id = :b`, repl);
      const byMethod: Record<string, { collectedPaise: number; refundedPaise: number; count: number }> = {};
      for (const p of items) { const m = (byMethod[p.method as string] ??= { collectedPaise: 0, refundedPaise: 0, count: 0 }); m.collectedPaise += p.amountPaise; m.count += 1; }
      for (const r2 of refunds) { const m = (byMethod[r2.method] ??= { collectedPaise: 0, refundedPaise: 0, count: 0 }); m.refundedPaise += Number(r2.amount); }
      const byPerson: Record<string, number> = {};
      for (const p of items) byPerson[(p.collectedBy as string) ?? '—'] = (byPerson[(p.collectedBy as string) ?? '—'] ?? 0) + p.amountPaise;
      const collected = items.reduce((n, p) => n + p.amountPaise, 0);
      const refunded = refunds.reduce((n, r2) => n + Number(r2.amount), 0);
      return { date, branchId: repl.b ?? null, items, totals: { collectedPaise: collected, refundedPaise: refunded, netPaise: collected - refunded, byMethod, byPerson } };
    });
    res.json(out);
  });

  /** Everything needed to print a receipt. */
  r.get('/payments/:id/receipt', user, org, requirePermission('payment:collect'), async (req, res) => {
    const out = await inOrg(req, async () => {
      const x = await loadPayment(req, String(req.params.id), 'payment:collect');
      const [o] = await q<{ name: string; legal_name: string | null; gstin: string | null; branch: string | null; address: string | null; city: string | null; phone: string | null; phone_enc: Buffer; timezone: string }>(
        `SELECT o.name, o.legal_name, o.gstin, o.timezone, b.name AS branch, b.address_line AS address, b.city, b.phone, p.phone_e164_enc AS phone_enc
           FROM app.organizations o, app.payments py LEFT JOIN app.branches b ON b.id = py.branch_id
           JOIN app.patient_profiles pp ON pp.id = py.patient_profile_id JOIN app.patients p ON p.id = pp.patient_id
          WHERE o.id = py.organization_id AND py.id = :id`, { id: x.id });
      return {
        ...payJson(x),
        clinic: { name: o!.name, legalName: o!.legal_name, gstin: o!.gstin, branch: o!.branch, address: [o!.address, o!.city].filter(Boolean).join(', '), phone: o!.phone },
        patientPhone: decrypt(config.dataKey, o!.phone_enc), timeZone: o!.timezone,
      };
    });
    res.json(out);
  });

  return r;
}
