import {
  appointmentListQuery, availabilityQuery, bookBody, queueReorderBody, cancelBody, holdBody, patientBody, phoneE164, rescheduleBody, statusBody, updatePatientBody,
  type AppointmentStatus, type AppointmentView,
} from '@dr/contracts';
import {
  Appointment, Doctor, DoctorService, Organization, Patient, PatientProfile, QueryTypes, Service, SlotHold, UniqueConstraintError,
} from '@dr/db';
import { Router, type Request } from 'express';
import { LIVE_SQL } from '../lib/booking.js';
import { DateTime } from 'luxon';
import type { Deps } from '../context.js';
import { HttpError, conflict, forbidden, notFound } from '../errors.js';
import { auditFromReq } from '../lib/audit.js';
import type { Mode } from '../lib/availability.js';
import { assertFree as sharedAssertFree, freeSlots, isExclusionViolation, loadTarget, lockDoctor as sharedLock, type SlotRequest as BookingSlotRequest } from '../lib/booking.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { grant, parse, requireOrg, requirePermission, requireUser } from '../middleware.js';
import { createPatient, patientPhoneHash } from '../lib/patients.js';
import { advanceLeadsForPatient } from './crm.js';
import { apptScope, patientScope } from '../lib/scopes.js';

/**
 * Phase 5: patients, free slots, holds, booking and the appointment lifecycle.
 * Row-level security keeps clinics apart; the scope helpers below narrow what each
 * role sees inside a clinic (branch staff, a doctor's own patients).
 */

const LIVE: AppointmentStatus[] = ['booked', 'confirmed', 'checked_in', 'in_consultation'];
const STAFF_LEAD_MINUTES = 0;
const HOLD_MINUTES = 5;
const badRequest = (message: string) => new HttpError(400, 'validation_failed', message);

/** Allowed next statuses. Cancel and reschedule have their own endpoints. */
const NEXT: Record<string, AppointmentStatus[]> = {
  booked: ['confirmed', 'checked_in', 'in_consultation', 'no_show'],
  confirmed: ['checked_in', 'in_consultation', 'no_show'],
  checked_in: ['in_consultation', 'completed'],
  in_consultation: ['completed'],
};

type Repl = Record<string, unknown>;

export function schedulingRouter(deps: Deps): Router {
  const { db, config } = deps;
  const r = Router();
  const user = requireUser(deps);
  const org = requireOrg(deps);
  const inOrg = <T>(req: Request, fn: () => Promise<T>) => db.withContext({ orgId: req.ctx!.org!.id, userId: req.ctx!.userId }, fn);
  const orgId = (req: Request) => req.ctx!.org!.id;
  const q = <T extends object>(sql: string, replacements: Repl = {}) => db.sequelize.query<T>(sql, { replacements, type: QueryTypes.SELECT });
  const phoneHash = (phone: string) => patientPhoneHash(deps, phone);

  /** May this member book or move an appointment to this doctor / mode / branch? */
  async function assertCanBook(req: Request, doctor: Doctor, mode: Mode, branchId: string | null) {
    const g = grant(req, 'appointment:manage');
    const mine = req.ctx!.org!.branchIds;
    if (g.scope === 'org' || (g.scope === 'branch' && mine.length === 0)) return;
    if (g.scope === 'own') {
      if (doctor.userId !== req.ctx!.userId) throw forbidden('You can only book your own appointments');
      return;
    }
    if (g.scope === 'branch') {
      if (mode === 'clinic') {
        if (branchId && mine.includes(branchId)) return;
        throw forbidden('You can only book clinic visits at your branches');
      }
      const [row] = await q<{ n: string }>(`SELECT count(*) AS n FROM app.schedule_rules WHERE doctor_id = :id AND branch_id IN (:mine)`, { id: doctor.id, mine });
      if (Number(row?.n) > 0) return;
      throw forbidden('This doctor does not work at your branches');
    }
    throw forbidden();
  }

  async function assertPatientVisible(req: Request, profileId: string, perm: string) {
    const s = patientScope(req, perm);
    const [row] = await q<{ id: string }>(`SELECT pp.id FROM app.patient_profiles pp WHERE pp.id = :id AND pp.deleted_at IS NULL AND ${s.sql}`, { id: profileId, ...s.repl });
    if (!row) throw notFound('Patient not found');
  }

  const timeZone = async (req: Request) => (await Organization.findByPk(orgId(req)))?.timezone ?? 'Asia/Kolkata';

  // ---------- slots (shared with the AI receptionist in lib/booking.ts) ----------
  type SlotRequest = BookingSlotRequest;
  const availability = async (req: Request, s: SlotRequest) => freeSlots(deps, await timeZone(req), { ...s, minLeadMinutes: STAFF_LEAD_MINUTES });
  const assertFree = async (req: Request, s: Omit<SlotRequest, 'fromDate' | 'days'>, start: string) => sharedAssertFree(deps, await timeZone(req), s, start);
  const lockDoctor = (doctorId: string) => sharedLock(deps, doctorId);

  async function appointmentView(where: string, repl: Repl): Promise<AppointmentView[]> {
    const rows = await q<Record<string, unknown>>(
      `SELECT a.id, lower(a.slot) AS start, upper(a.slot) AS "end", a.status, a.mode, a.branch_id, a.doctor_id, d.display_name AS doctor_name,
              a.service_id, s.name AS service_name, a.fee_paise, a.patient_profile_id, pp.mrn, p.full_name, a.reason_text, a.booked_by_kind,
              a.cancelled_reason, a.rescheduled_from, a.created_at,
              (SELECT qt.token FROM app.queue_tokens qt WHERE qt.appointment_id = a.id) AS queue_token
         FROM app.appointments a
         JOIN app.doctors d ON d.id = a.doctor_id
         JOIN app.services s ON s.id = a.service_id
         JOIN app.patient_profiles pp ON pp.id = a.patient_profile_id
         JOIN app.patients p ON p.id = pp.patient_id
        WHERE ${where}
        ORDER BY lower(a.slot), d.display_name`, repl);
    return rows.map((x) => ({
      id: x.id as string, start: new Date(x.start as string).toISOString(), end: new Date(x.end as string).toISOString(),
      status: x.status as AppointmentStatus, mode: x.mode as Mode, branchId: x.branch_id as string | null,
      doctorId: x.doctor_id as string, doctorName: x.doctor_name as string, serviceId: x.service_id as string, serviceName: x.service_name as string,
      feePaise: x.fee_paise === null ? null : Number(x.fee_paise),
      patient: { profileId: x.patient_profile_id as string, mrn: x.mrn as string, fullName: x.full_name as string },
      reasonText: x.reason_text as string | null, bookedByKind: x.booked_by_kind as string, cancelledReason: x.cancelled_reason as string | null,
      rescheduledFrom: x.rescheduled_from as string | null, createdAt: new Date(x.created_at as string).toISOString(),
      queueToken: (x.queue_token as string | null) ?? null,
    }));
  }

  async function loadVisibleAppointment(req: Request, id: string, perm: string) {
    const s = apptScope(req, perm);
    const [v] = await appointmentView(`a.id = :id AND ${s.sql}`, { id, ...s.repl });
    if (!v) throw notFound('Appointment not found');
    const a = await Appointment.findByPk(id);
    if (!a) throw notFound('Appointment not found');
    return { view: v, a };
  }

  // =====================================================================
  // Patients
  // =====================================================================
  type PatientRow = { id: string; mrn: string; home_branch_id: string | null; city?: string | null; full_name: string; phone_e164_enc: Buffer; date_of_birth: string | null; sex: string | null; preferred_language: string; acquisition_source?: string | null; next_appointment?: Date | null; last_visit?: Date | null };
  /** Lists show a masked number (98•• ••• 451); the full number is shown when a record is opened. */
  const maskPhone = (e164: string) => {
    const d = e164.replace(/^\+91/, '');
    return d.length === 10 ? `${d.slice(0, 2)}•• ••• ${d.slice(7)}` : `${e164.slice(0, 4)}•••${e164.slice(-3)}`;
  };
  const patientJson = (x: PatientRow, opts: { mask?: boolean } = {}) => {
    const phone = decrypt(config.dataKey, x.phone_e164_enc);
    return {
      id: x.id, mrn: x.mrn, fullName: x.full_name, phone: opts.mask ? maskPhone(phone) : phone, phoneMasked: !!opts.mask, dateOfBirth: x.date_of_birth,
      sex: x.sex, preferredLanguage: x.preferred_language, homeBranchId: x.home_branch_id, city: x.city ?? null, source: x.acquisition_source ?? null,
      nextAppointmentAt: x.next_appointment ? new Date(x.next_appointment).toISOString() : null,
      lastVisitAt: x.last_visit ? new Date(x.last_visit).toISOString() : null,
    };
  };
  const PATIENT_SELECT = `SELECT pp.id, pp.mrn, pp.home_branch_id, pp.city, pp.acquisition_source, p.full_name, p.phone_e164_enc, p.date_of_birth::text, p.sex, p.preferred_language,
      (SELECT min(lower(a.slot)) FROM app.appointments a WHERE a.patient_profile_id = pp.id AND lower(a.slot) > now() AND a.status IN ${LIVE_SQL}) AS next_appointment,
      (SELECT max(lower(a.slot)) FROM app.appointments a WHERE a.patient_profile_id = pp.id AND a.status = 'completed') AS last_visit
    FROM app.patient_profiles pp JOIN app.patients p ON p.id = pp.patient_id`;

  /** Search by full mobile number, clinic patient ID or part of the name. */
  r.get('/patients', user, org, requirePermission('patient:read'), async (req, res) => {
    const term = String(req.query.q ?? '').trim();
    const items = await inOrg(req, async () => {
      const s = patientScope(req, 'patient:read');
      const repl: Repl = { ...s.repl };
      let cond = 'TRUE';
      let searchedByPhone = false;
      if (term) {
        const phone = phoneE164.safeParse(term);
        if (phone.success && /\d{10}/.test(term.replace(/\D/g, ''))) {
          searchedByPhone = true;
          cond = 'p.phone_hash = :hash';
          repl.hash = phoneHash(phone.data);
        } else if (/^[A-Za-z0-9]{1,6}-\d+$/.test(term)) {
          cond = 'upper(pp.mrn) = upper(:mrn)';
          repl.mrn = term;
        } else {
          cond = `lower(p.full_name) LIKE :name ESCAPE '\\'`;
          repl.name = `%${term.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        }
      }
      const extra: string[] = [];
      if (req.query.upcoming === '1') extra.push(`EXISTS (SELECT 1 FROM app.appointments a WHERE a.patient_profile_id = pp.id AND lower(a.slot) > now() AND a.status IN ${LIVE_SQL})`);
      if (req.query.source) { extra.push('pp.acquisition_source = :src'); repl.src = String(req.query.source); }
      const rows = await q<PatientRow>(`${PATIENT_SELECT} WHERE pp.deleted_at IS NULL AND ${s.sql} AND ${cond}${extra.map((x) => ` AND ${x}`).join('')} ORDER BY pp.created_at DESC LIMIT 50`, repl);
      // The caller already knows the number they searched for; otherwise numbers stay masked in lists.
      return rows.map((x) => patientJson(x, { mask: !searchedByPhone }));
    });
    res.json({ items });
  });

  r.post('/patients', user, org, requirePermission('patient:manage'), async (req, res) => {
    const body = parse(patientBody, req.body);
    const g = grant(req, 'patient:manage');
    const mine = req.ctx!.org!.branchIds;
    let homeBranchId = body.homeBranchId ?? null;
    if (g.scope === 'branch' && mine.length) {
      homeBranchId ??= mine[0]!;
      if (!mine.includes(homeBranchId)) throw forbidden('You can only register patients at your branches');
    }
    const out = await inOrg(req, async () => {
      const id = await createPatient(deps, req, body, homeBranchId);
      const [row] = await q<PatientRow>(`${PATIENT_SELECT} WHERE pp.id = :id`, { id });
      return patientJson(row!);
    });
    res.status(201).json(out);
  });

  r.get('/patients/:id', user, org, requirePermission('patient:read'), async (req, res) => {
    const out = await inOrg(req, async () => {
      const id = String(req.params.id);
      await assertPatientVisible(req, id, 'patient:read');
      const [row] = await q<PatientRow & { patient_id: string }>(`${PATIENT_SELECT.replace('SELECT pp.id,', 'SELECT pp.id, pp.patient_id,')} WHERE pp.id = :id`, { id });
      let appointments: AppointmentView[] = [];
      if (req.ctx!.org!.grants.has('appointment:read')) {
        const a = apptScope(req, 'appointment:read');
        appointments = await appointmentView(`a.patient_profile_id = :id AND ${a.sql}`, { id, ...a.repl });
      }
      // Every read of a patient record is logged (who, which patient, why).
      await db.sequelize.query(
        `INSERT INTO app.data_access_logs (organization_id, actor_kind, actor_id, patient_id, resource_type, resource_id, purpose)
         VALUES (:org, 'user', :me, :patient, 'patient_profile', :id, 'care')`,
        { replacements: { org: orgId(req), me: req.ctx!.userId, patient: row!.patient_id, id } },
      );
      return { ...patientJson(row!), appointments };
    });
    res.json(out);
  });

  r.patch('/patients/:id', user, org, requirePermission('patient:manage'), async (req, res) => {
    const body = parse(updatePatientBody, req.body);
    const out = await inOrg(req, async () => {
      const id = String(req.params.id);
      await assertPatientVisible(req, id, 'patient:manage');
      const profile = await PatientProfile.findByPk(id);
      const person = profile && await Patient.findByPk(profile.patientId);
      if (!profile || !person) throw notFound('Patient not found');
      const mine = req.ctx!.org!.branchIds;
      if (body.homeBranchId && grant(req, 'patient:manage').scope === 'branch' && mine.length && !mine.includes(body.homeBranchId)) {
        throw forbidden('You can only move patients to your branches');
      }
      await person.update({
        ...(body.fullName !== undefined ? { fullName: body.fullName } : {}),
        ...(body.phone !== undefined ? { phoneE164Enc: encrypt(config.dataKey, body.phone), phoneHash: phoneHash(body.phone) } : {}),
        ...(body.dateOfBirth !== undefined ? { dateOfBirth: body.dateOfBirth } : {}),
        ...(body.sex !== undefined ? { sex: body.sex } : {}),
        ...(body.preferredLanguage !== undefined ? { preferredLanguage: body.preferredLanguage } : {}),
      });
      await profile.update({
        ...(body.homeBranchId !== undefined ? { homeBranchId: body.homeBranchId } : {}),
        ...(body.city !== undefined ? { city: body.city } : {}),
        ...(body.acquisitionSource !== undefined ? { acquisitionSource: body.acquisitionSource } : {}),
      });
      await auditFromReq(req, { action: 'patient.update', targetType: 'patient_profile', targetId: id, details: { fields: Object.keys(body) } });
      const [row] = await q<PatientRow>(`${PATIENT_SELECT} WHERE pp.id = :id`, { id });
      return patientJson(row!);
    });
    res.json(out);
  });

  // =====================================================================
  // Free slots and holds
  // =====================================================================
  r.get('/availability', user, org, requirePermission('appointment:read'), async (req, res) => {
    const query = parse(availabilityQuery, req.query);
    const out = await inOrg(req, async () => {
      const { doctor, service } = await loadTarget(query.doctorId, query.serviceId, query.mode);
      return availability(req, { doctor, service, mode: query.mode, branchId: query.branchId ?? null, fromDate: query.from, days: query.days });
    });
    res.json({ days: out });
  });

  /** Holds a slot for a few minutes while a caller decides. */
  r.post('/holds', user, org, requirePermission('appointment:manage'), async (req, res) => {
    const body = parse(holdBody, req.body);
    const out = await inOrg(req, async () => {
      await lockDoctor(body.doctorId);
      const { doctor, service } = await loadTarget(body.doctorId, body.serviceId, body.mode);
      await assertCanBook(req, doctor, body.mode, body.branchId);
      const slot = await assertFree(req, { doctor, service, mode: body.mode, branchId: body.branchId }, body.start);
      await db.sequelize.query('DELETE FROM app.slot_holds WHERE doctor_id = :d AND expires_at <= now()', { replacements: { d: doctor.id } });
      const hold = await SlotHold.create({
        organizationId: orgId(req), doctorId: doctor.id, serviceId: service.id, mode: body.mode, branchId: slot.branchId,
        slot: [{ value: new Date(slot.start), inclusive: true }, { value: new Date(slot.end), inclusive: false }],
        heldByKind: 'staff', heldByRef: null, createdBy: req.ctx!.userId, expiresAt: new Date(Date.now() + HOLD_MINUTES * 60_000),
      });
      return { id: hold.id, start: slot.start, end: slot.end, expiresAt: hold.expiresAt.toISOString() };
    });
    res.status(201).json(out);
  });

  r.delete('/holds/:id', user, org, requirePermission('appointment:manage'), async (req, res) => {
    await inOrg(req, () => SlotHold.destroy({ where: { id: String(req.params.id) } }));
    res.status(204).end();
  });

  // =====================================================================
  // Appointments
  // =====================================================================
  r.get('/appointments', user, org, requirePermission('appointment:read'), async (req, res) => {
    const query = parse(appointmentListQuery, req.query);
    const items = await inOrg(req, async () => {
      const s = apptScope(req, 'appointment:read');
      const conds = ['a.slot && tstzrange(:from, :to)', s.sql];
      if (query.doctorId) conds.push('a.doctor_id = :doctorId');
      if (query.branchId) conds.push('a.branch_id = :branchId');
      if (query.patientProfileId) conds.push('a.patient_profile_id = :patientProfileId');
      if (query.includeInactive === '0') conds.push(`a.status IN ${LIVE_SQL}`);
      return appointmentView(conds.join(' AND '), { ...query, ...s.repl });
    });
    res.json({ items });
  });

  /** Upcoming appointments that now clash with leave or a holiday and need moving. */
  r.get('/appointments/attention', user, org, requirePermission('appointment:read'), async (req, res) => {
    const items = await inOrg(req, async () => {
      const s = apptScope(req, 'appointment:read');
      const tz = await timeZone(req);
      return appointmentView(`a.status IN ${LIVE_SQL} AND upper(a.slot) > now() AND ${s.sql} AND (
          EXISTS (SELECT 1 FROM app.schedule_exceptions x WHERE x.doctor_id = a.doctor_id AND x.kind IN ('leave','block') AND x.during && a.slot)
          OR EXISTS (SELECT 1 FROM app.holidays h WHERE h.on_date = (lower(a.slot) AT TIME ZONE :tz)::date
                     AND (h.branch_id IS NULL OR h.branch_id = a.branch_id)))`, { ...s.repl, tz });
    });
    res.json({ items });
  });

  r.get('/appointments/:id', user, org, requirePermission('appointment:read'), async (req, res) => {
    const out = await inOrg(req, async () => (await loadVisibleAppointment(req, String(req.params.id), 'appointment:read')).view);
    res.json(out);
  });

  r.post('/appointments', user, org, requirePermission('appointment:manage'), async (req, res) => {
    const body = parse(bookBody, req.body);
    const result = await inOrg(req, async () => {
      if (body.idempotencyKey) {
        const existing = await Appointment.findOne({ where: { idempotencyKey: body.idempotencyKey } });
        if (existing) return { created: false, view: (await loadVisibleAppointment(req, existing.id, 'appointment:read')).view };
      }
      await lockDoctor(body.doctorId);
      const { doctor, service, fee } = await loadTarget(body.doctorId, body.serviceId, body.mode);
      await assertCanBook(req, doctor, body.mode, body.branchId);
      await assertPatientVisible(req, body.patientProfileId, 'patient:read');
      const slot = await assertFree(req, { doctor, service, mode: body.mode, branchId: body.branchId, excludeHoldId: body.holdId }, body.start);
      try {
        const a = await Appointment.create({
          organizationId: orgId(req), branchId: slot.branchId, doctorId: doctor.id, serviceId: service.id, patientProfileId: body.patientProfileId,
          mode: body.mode, slot: [{ value: new Date(slot.start), inclusive: true }, { value: new Date(slot.end), inclusive: false }],
          status: 'booked', bookedByKind: 'staff', bookedById: req.ctx!.userId, feePaise: fee, reasonText: body.reasonText ?? null,
          idempotencyKey: body.idempotencyKey ?? null, rescheduledFrom: null, statusChangedBy: req.ctx!.userId,
        });
        if (body.holdId) await SlotHold.destroy({ where: { id: body.holdId } });
        await auditFromReq(req, { action: 'appointment.book', targetType: 'appointment', targetId: a.id, details: { doctorId: doctor.id, start: slot.start, mode: body.mode } });
        // The patient's open enquiry moves to "booked" on the pipeline.
        await advanceLeadsForPatient(deps, req, body.patientProfileId, ['enquiry', 'qualified'], 'booked', a.id);
        return { created: true, view: (await loadVisibleAppointment(req, a.id, 'appointment:read')).view };
      } catch (e) {
        if (isExclusionViolation(e)) throw conflict('That time was just taken. Pick another slot.');
        if (e instanceof UniqueConstraintError) throw conflict('This booking was already made');
        throw e;
      }
    });
    res.status(result.created ? 201 : 200).json(result.view);
  });

  r.post('/appointments/:id/status', user, org, requirePermission('appointment:manage'), async (req, res) => {
    const body = parse(statusBody, req.body);
    const out = await inOrg(req, async () => {
      const { a, view } = await loadVisibleAppointment(req, String(req.params.id), 'appointment:manage');
      const allowed = NEXT[a.status] ?? [];
      if (!allowed.includes(body.status)) throw conflict(`A ${a.status.replace('_', ' ')} appointment cannot be marked ${body.status.replace('_', ' ')}`);
      const start = a.slot[0].value;
      const tz = await timeZone(req);
      if (body.status === 'checked_in') {
        if (a.mode !== 'clinic') throw conflict('Only clinic visits are checked in');
        const day = (d: Date) => DateTime.fromJSDate(d, { zone: tz }).toISODate();
        if (day(start) !== day(new Date())) throw conflict('Patients can only be checked in on the day of their appointment');
      }
      if (body.status === 'no_show' && start > new Date()) throw conflict('An appointment can only be marked no-show after it starts');
      if (body.status === 'in_consultation' && start.getTime() - Date.now() > 60 * 60_000) throw conflict('This consultation is more than an hour away');
      await a.update({ status: body.status, statusChangedAt: new Date(), statusChangedBy: req.ctx!.userId });
      // Waiting room: check-in issues a token; the token follows the visit.
      if (body.status === 'checked_in') await issueToken(req, a, tz);
      if (body.status === 'in_consultation') await setTokenStatus(a.id, 'in_room');
      if (body.status === 'completed') {
        await setTokenStatus(a.id, 'done');
        await advanceLeadsForPatient(deps, req, a.patientProfileId, ['booked'], 'consulted', a.id);
      }
      await auditFromReq(req, { action: 'appointment.status', targetType: 'appointment', targetId: a.id, details: { from: view.status, to: body.status } });
      return (await loadVisibleAppointment(req, a.id, 'appointment:read')).view;
    });
    res.json(out);
  });

  r.post('/appointments/:id/cancel', user, org, requirePermission('appointment:manage'), async (req, res) => {
    const body = parse(cancelBody, req.body);
    const out = await inOrg(req, async () => {
      const { a, view } = await loadVisibleAppointment(req, String(req.params.id), 'appointment:manage');
      if (!['booked', 'confirmed'].includes(a.status)) throw conflict(`A ${a.status.replace('_', ' ')} appointment cannot be cancelled`);
      await a.update({ status: 'cancelled', cancelledReason: body.reason, statusChangedAt: new Date(), statusChangedBy: req.ctx!.userId });
      await auditFromReq(req, { action: 'appointment.cancel', targetType: 'appointment', targetId: a.id, details: { from: view.status, reason: body.reason } });
      return (await loadVisibleAppointment(req, a.id, 'appointment:read')).view;
    });
    res.json(out);
  });

  /** Moves an appointment: the old one is kept as "rescheduled" and linked from the new one. */
  r.post('/appointments/:id/reschedule', user, org, requirePermission('appointment:manage'), async (req, res) => {
    const body = parse(rescheduleBody, req.body);
    const out = await inOrg(req, async () => {
      const { a } = await loadVisibleAppointment(req, String(req.params.id), 'appointment:manage');
      if (!['booked', 'confirmed'].includes(a.status)) throw conflict(`A ${a.status.replace('_', ' ')} appointment cannot be moved`);
      const doctorId = body.doctorId ?? a.doctorId;
      const mode = body.mode ?? a.mode;
      const branchId = mode === 'clinic' ? (body.branchId !== undefined ? body.branchId : a.branchId) : null;
      await lockDoctor(doctorId);
      const { doctor, service, fee } = await loadTarget(doctorId, a.serviceId, mode);
      await assertCanBook(req, doctor, mode, branchId);
      const slot = await assertFree(req, { doctor, service, mode, branchId, excludeAppointmentId: a.id }, body.start);
      await a.update({ status: 'rescheduled', statusChangedAt: new Date(), statusChangedBy: req.ctx!.userId, cancelledReason: body.reason ?? null });
      try {
        const n = await Appointment.create({
          organizationId: orgId(req), branchId: slot.branchId, doctorId, serviceId: a.serviceId, patientProfileId: a.patientProfileId, mode,
          slot: [{ value: new Date(slot.start), inclusive: true }, { value: new Date(slot.end), inclusive: false }],
          status: 'booked', bookedByKind: 'staff', bookedById: req.ctx!.userId,
          feePaise: doctorId === a.doctorId ? a.feePaise : fee, reasonText: a.reasonText, idempotencyKey: null, rescheduledFrom: a.id, statusChangedBy: req.ctx!.userId,
        });
        await auditFromReq(req, { action: 'appointment.reschedule', targetType: 'appointment', targetId: n.id, details: { from: a.id, start: slot.start, doctorId } });
        return (await loadVisibleAppointment(req, n.id, 'appointment:read')).view;
      } catch (e) {
        if (isExclusionViolation(e)) throw conflict('That time was just taken. Pick another slot.');
        throw e;
      }
    });
    res.json(out);
  });

  // =====================================================================
  // Waiting room (queue tokens)
  // =====================================================================
  /** Token like "M-03": the doctor's surname initial and a number per branch, day and letter. */
  async function issueToken(req: Request, a: Appointment, tz: string) {
    if (!a.branchId) return;
    const [doc] = await q<{ display_name: string }>(`SELECT display_name FROM app.doctors WHERE id = :id`, { id: a.doctorId });
    const letter = (doc?.display_name.replace(/^dr\.?\s*/i, '').trim().split(/\s+/).pop()?.[0] ?? 'T').toUpperCase().replace(/[^A-Z]/, 'T');
    const date = DateTime.now().setZone(tz).toISODate()!;
    await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: `${a.branchId}:${date}` } });
    const [n] = await q<{ n: string; pos: string }>(
      `SELECT (SELECT count(*) FROM app.queue_tokens WHERE branch_id = :b AND service_date = :d AND token LIKE :prefix) AS n,
              (SELECT COALESCE(max(position), 0) FROM app.queue_tokens WHERE branch_id = :b AND service_date = :d AND doctor_id = :doc) AS pos`,
      { b: a.branchId, d: date, prefix: `${letter}-%`, doc: a.doctorId });
    const token = `${letter}-${String(Number(n!.n) + 1).padStart(2, '0')}`;
    await db.sequelize.query(
      `INSERT INTO app.queue_tokens (organization_id, branch_id, appointment_id, patient_profile_id, doctor_id, token, service_date, is_walk_in, status, position)
       VALUES (:org, :b, :appt, :pp, :doc, :token, :d, false, 'waiting', :pos)
       ON CONFLICT (appointment_id) WHERE appointment_id IS NOT NULL DO NOTHING`,
      { replacements: { org: orgId(req), b: a.branchId, appt: a.id, pp: a.patientProfileId, doc: a.doctorId, token, d: date, pos: Number(n!.pos) + 1 } });
  }
  const setTokenStatus = (appointmentId: string, status: 'in_room' | 'done') =>
    db.sequelize.query(`UPDATE app.queue_tokens SET status = :status, status_changed_at = now() WHERE appointment_id = :id AND status NOT IN ('done','left')`, { replacements: { id: appointmentId, status } });

  async function queueBranch(req: Request, branchId: string | undefined) {
    const mine = req.ctx!.org!.branchIds;
    const g = grant(req, 'appointment:read');
    if (branchId) {
      if (g.scope !== 'org' && mine.length && !mine.includes(branchId)) throw forbidden('This is not one of your branches');
      return branchId;
    }
    if (mine.length) return mine[0]!;
    const [b] = await q<{ id: string }>(`SELECT id FROM app.branches WHERE deleted_at IS NULL AND is_active ORDER BY created_at LIMIT 1`);
    if (!b) throw notFound('No open branch');
    return b.id;
  }

  r.get('/queue', user, org, requirePermission('appointment:read'), async (req, res) => {
    const out = await inOrg(req, async () => {
      const tz = await timeZone(req);
      const branchId = await queueBranch(req, req.query.branchId ? String(req.query.branchId) : undefined);
      const date = req.query.date ? String(req.query.date) : DateTime.now().setZone(tz).toISODate()!;
      const own = grant(req, 'appointment:read').scope === 'own';
      const rows = await q<Record<string, unknown>>(
        `SELECT t.id, t.token, t.status, t.position, t.doctor_id, d.display_name AS doctor_name, t.appointment_id, lower(a.slot) AS appt_start,
                t.patient_profile_id, pp.mrn, p.full_name, t.checked_in_at, t.called_at, t.is_walk_in
           FROM app.queue_tokens t
           JOIN app.patient_profiles pp ON pp.id = t.patient_profile_id JOIN app.patients p ON p.id = pp.patient_id
           LEFT JOIN app.doctors d ON d.id = t.doctor_id LEFT JOIN app.appointments a ON a.id = t.appointment_id
          WHERE t.branch_id = :b AND t.service_date = :date ${own ? 'AND d.user_id = :me' : ''}
          ORDER BY d.display_name, t.position`, { b: branchId, date, me: req.ctx!.userId });
      return {
        branchId, date,
        items: rows.map((x) => ({
          id: x.id, token: x.token, status: x.status, position: x.position, doctorId: x.doctor_id, doctorName: x.doctor_name,
          appointmentId: x.appointment_id, appointmentStart: x.appt_start ? new Date(x.appt_start as string).toISOString() : null,
          patient: { profileId: x.patient_profile_id, mrn: x.mrn, fullName: x.full_name },
          checkedInAt: new Date(x.checked_in_at as string).toISOString(), calledAt: x.called_at ? new Date(x.called_at as string).toISOString() : null,
          waitingMinutes: ['waiting', 'called'].includes(x.status as string) ? Math.floor((Date.now() - new Date(x.checked_in_at as string).getTime()) / 60_000) : null,
          isWalkIn: x.is_walk_in,
        })),
      };
    });
    res.json(out);
  });

  async function loadToken(req: Request, id: string) {
    const [t] = await q<{ id: string; branch_id: string; status: string; doctor_id: string; appointment_id: string | null }>(
      `SELECT id, branch_id, status, doctor_id, appointment_id FROM app.queue_tokens WHERE id = :id`, { id });
    if (!t) throw notFound('Token not found');
    await queueBranch(req, t.branch_id);
    if (t.appointment_id) {
      const s = apptScope(req, 'appointment:manage');
      const [ok] = await q<{ id: string }>(`SELECT a.id FROM app.appointments a JOIN app.doctors d ON d.id = a.doctor_id WHERE a.id = :id AND ${s.sql}`, { id: t.appointment_id, ...s.repl });
      if (!ok) throw notFound('Token not found');
    }
    return t;
  }

  r.post('/queue/:id/call', user, org, requirePermission('appointment:manage'), async (req, res) => {
    await inOrg(req, async () => {
      const t = await loadToken(req, String(req.params.id));
      if (t.status !== 'waiting') throw conflict('Only waiting patients can be called');
      await db.sequelize.query(`UPDATE app.queue_tokens SET status = 'called', called_at = now(), status_changed_at = now() WHERE id = :id`, { replacements: { id: t.id } });
      await auditFromReq(req, { action: 'queue.call', targetType: 'queue_token', targetId: t.id });
    });
    res.json({ ok: true });
  });

  r.post('/queue/:id/left', user, org, requirePermission('appointment:manage'), async (req, res) => {
    await inOrg(req, async () => {
      const t = await loadToken(req, String(req.params.id));
      if (!['waiting', 'called'].includes(t.status)) throw conflict('Only waiting patients can be marked as left');
      await db.sequelize.query(`UPDATE app.queue_tokens SET status = 'left', status_changed_at = now() WHERE id = :id`, { replacements: { id: t.id } });
      await auditFromReq(req, { action: 'queue.left', targetType: 'queue_token', targetId: t.id });
    });
    res.json({ ok: true });
  });

  r.post('/queue/reorder', user, org, requirePermission('appointment:manage'), async (req, res) => {
    const body = parse(queueReorderBody, req.body);
    await inOrg(req, async () => {
      const tokens = await Promise.all(body.tokenIds.map((id) => loadToken(req, id)));
      if (tokens.some((t) => t.doctor_id !== body.doctorId)) throw badRequest('All tokens must be for the same doctor');
      if (new Set(tokens.map((t) => t.branch_id)).size !== 1) throw badRequest('All tokens must be at the same branch');
      for (const [i, t] of tokens.entries()) {
        await db.sequelize.query(`UPDATE app.queue_tokens SET position = :p WHERE id = :id`, { replacements: { id: t.id, p: i + 1 } });
      }
      await auditFromReq(req, { action: 'queue.reorder', targetType: 'doctor', targetId: body.doctorId, details: { count: tokens.length } });
    });
    res.json({ ok: true });
  });

  return r;
}
