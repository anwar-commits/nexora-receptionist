import {
  appointmentListQuery, availabilityQuery, bookBody, cancelBody, holdBody, patientBody, phoneE164, rescheduleBody, statusBody, updatePatientBody,
  type AppointmentStatus, type AppointmentView,
} from '@dr/contracts';
import {
  Appointment, Doctor, DoctorService, Organization, OrganizationSettings, Patient, PatientProfile, QueryTypes, Service, SlotHold, UniqueConstraintError,
} from '@dr/db';
import { Router, type Request } from 'express';
import { DateTime } from 'luxon';
import type { Deps } from '../context.js';
import { HttpError, conflict, forbidden, notFound } from '../errors.js';
import { auditFromReq } from '../lib/audit.js';
import { computeAvailability, type Busy, type Mode, type WeeklyRule } from '../lib/availability.js';
import { decrypt, encrypt, hmac } from '../lib/crypto.js';
import { grant, parse, requireOrg, requirePermission, requireUser } from '../middleware.js';

/**
 * Phase 5: patients, free slots, holds, booking and the appointment lifecycle.
 * Row-level security keeps clinics apart; the scope helpers below narrow what each
 * role sees inside a clinic (branch staff, a doctor's own patients).
 */

const LIVE: AppointmentStatus[] = ['booked', 'confirmed', 'checked_in', 'in_consultation'];
const LIVE_SQL = `('held','booked','confirmed','checked_in','in_consultation')`;
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
interface Scope { sql: string; repl: Repl }

export function schedulingRouter(deps: Deps): Router {
  const { db, config } = deps;
  const r = Router();
  const user = requireUser(deps);
  const org = requireOrg(deps);
  const inOrg = <T>(req: Request, fn: () => Promise<T>) => db.withContext({ orgId: req.ctx!.org!.id, userId: req.ctx!.userId }, fn);
  const orgId = (req: Request) => req.ctx!.org!.id;
  const q = <T extends object>(sql: string, replacements: Repl = {}) => db.sequelize.query<T>(sql, { replacements, type: QueryTypes.SELECT });
  const phoneHash = (phone: string) => hmac(config.pepper, 'patient-phone', phone);

  // ---------- who sees what inside a clinic ----------
  /** SQL condition on appointments `a` (joined with doctors `d`) for a permission's scope. */
  function apptScope(req: Request, perm: string): Scope {
    const g = grant(req, perm);
    const mine = req.ctx!.org!.branchIds;
    if (g.scope === 'org' || (g.scope === 'branch' && mine.length === 0)) return { sql: 'TRUE', repl: {} };
    if (g.scope === 'branch') {
      return {
        sql: `(a.branch_id IN (:mine) OR (a.branch_id IS NULL AND EXISTS (
                SELECT 1 FROM app.schedule_rules sr WHERE sr.doctor_id = a.doctor_id AND sr.branch_id IN (:mine))))`,
        repl: { mine },
      };
    }
    if (g.scope === 'own') return { sql: 'd.user_id = :me', repl: { me: req.ctx!.userId } };
    return { sql: 'FALSE', repl: {} }; // 'assigned' arrives with the CRM
  }

  /** SQL condition on patient_profiles `pp` for a permission's scope. */
  function patientScope(req: Request, perm: string): Scope {
    const g = grant(req, perm);
    const mine = req.ctx!.org!.branchIds;
    if (g.scope === 'org' || (g.scope === 'branch' && mine.length === 0)) return { sql: 'TRUE', repl: {} };
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
        repl: { me: req.ctx!.userId },
      };
    }
    return { sql: 'FALSE', repl: {} };
  }

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

  // ---------- slots ----------
  interface SlotRequest {
    doctor: Doctor; service: Service; mode: Mode; branchId: string | null;
    fromDate: string; days: number; excludeAppointmentId?: string; excludeHoldId?: string;
  }
  async function availability(req: Request, s: SlotRequest) {
    const tz = await timeZone(req);
    const windowStart = DateTime.fromISO(s.fromDate, { zone: tz }).startOf('day');
    const windowEnd = windowStart.plus({ days: s.days + 1 });
    const repl = { doctor: s.doctor.id, a: windowStart.toISO(), b: windowEnd.toISO(), ex: s.excludeAppointmentId ?? null, hold: s.excludeHoldId ?? null, tz };
    const rules = await q<{ weekday: number; start_local: string; end_local: string; mode: Mode; branch_id: string | null; valid_from: string | null; valid_to: string | null }>(
      `SELECT r.weekday, r.start_local, r.end_local, r.mode, r.branch_id, r.valid_from::text, r.valid_to::text
         FROM app.schedule_rules r LEFT JOIN app.branches b ON b.id = r.branch_id
        WHERE r.doctor_id = :doctor AND (r.branch_id IS NULL OR (b.is_active AND b.deleted_at IS NULL))`, repl);
    const leave = await q<{ s: Date; e: Date }>(
      `SELECT lower(during) AS s, upper(during) AS e FROM app.schedule_exceptions
        WHERE doctor_id = :doctor AND kind IN ('leave','block') AND during && tstzrange(:a, :b)`, repl);
    const holidays = await q<{ on_date: string; branch_id: string | null }>(
      `SELECT on_date::text, branch_id FROM app.holidays WHERE on_date BETWEEN (CAST(:a AS timestamptz) AT TIME ZONE :tz)::date AND (CAST(:b AS timestamptz) AT TIME ZONE :tz)::date`, repl);
    const busy = await q<{ s: Date; e: Date; mode: Mode }>(
      `SELECT lower(slot) AS s, upper(slot) AS e, mode FROM app.appointments
        WHERE doctor_id = :doctor AND status IN ${LIVE_SQL} AND slot && tstzrange(:a, :b) AND (CAST(:ex AS uuid) IS NULL OR id <> CAST(:ex AS uuid))
       UNION ALL
       SELECT lower(slot), upper(slot), COALESCE(mode, 'clinic') FROM app.slot_holds
        WHERE doctor_id = :doctor AND expires_at > now() AND slot && tstzrange(:a, :b) AND (CAST(:hold AS uuid) IS NULL OR id <> CAST(:hold AS uuid))`, repl);

    return computeAvailability({
      timeZone: tz, fromDate: s.fromDate, days: s.days, now: new Date(), minLeadMinutes: STAFF_LEAD_MINUTES,
      slotMinutes: s.doctor.slotMinutes, bufferMinutes: s.doctor.bufferMinutes, maxOnlinePerDay: s.doctor.maxOnlinePerDay,
      durationMinutes: s.service.durationMinutes, mode: s.mode, branchId: s.branchId,
      rules: rules.map((x): WeeklyRule => ({ weekday: x.weekday, start: x.start_local, end: x.end_local, mode: x.mode, branchId: x.branch_id, validFrom: x.valid_from, validTo: x.valid_to })),
      unavailable: leave.map((x) => ({ start: new Date(x.s), end: new Date(x.e) })),
      holidays: holidays.map((h) => ({ onDate: h.on_date, branchId: h.branch_id })),
      busy: busy.map((x): Busy => ({ start: new Date(x.s), end: new Date(x.e), mode: x.mode })),
    });
  }

  /** Loads and checks doctor + service for a booking, returns them. */
  async function loadTarget(doctorId: string, serviceId: string, mode: Mode) {
    const doctor = await Doctor.findOne({ where: { id: doctorId, deletedAt: null, isActive: true } });
    if (!doctor) throw badRequest('Unknown or inactive doctor');
    const service = await Service.findOne({ where: { id: serviceId, isActive: true } });
    if (!service) throw badRequest('Unknown or retired service');
    if (!service.modes.includes(mode)) throw badRequest(`${service.name} cannot be booked as ${mode}`);
    const offered = await DoctorService.findAll({ where: { doctorId } });
    if (offered.length > 0 && !offered.some((o) => o.serviceId === serviceId)) throw badRequest(`${doctor.displayName} does not offer ${service.name}`);
    const override = offered.find((o) => o.serviceId === serviceId)?.feeOverridePaise ?? null;
    return { doctor, service, fee: override ?? service.feePaise };
  }

  /** The requested start must be one of the free slots right now. */
  async function assertFree(req: Request, s: Omit<SlotRequest, 'fromDate' | 'days'>, start: string) {
    const tz = await timeZone(req);
    const when = DateTime.fromISO(start, { setZone: true });
    if (!when.isValid) throw badRequest('Invalid start time');
    const [day] = await availability(req, { ...s, fromDate: when.setZone(tz).toISODate()!, days: 1 });
    const slot = day?.slots.find((x) => +new Date(x.start) === +when.toJSDate() && (s.mode !== 'clinic' || !s.branchId || x.branchId === s.branchId));
    if (!slot) throw conflict('That time is not free. Pick another slot.');
    return slot;
  }

  const lockDoctor = (doctorId: string) => db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:d))', { replacements: { d: doctorId } });
  const isExclusionViolation = (e: unknown) => (e as { original?: { code?: string } })?.original?.code === '23P01';

  async function appointmentView(where: string, repl: Repl): Promise<AppointmentView[]> {
    const rows = await q<Record<string, unknown>>(
      `SELECT a.id, lower(a.slot) AS start, upper(a.slot) AS "end", a.status, a.mode, a.branch_id, a.doctor_id, d.display_name AS doctor_name,
              a.service_id, s.name AS service_name, a.fee_paise, a.patient_profile_id, pp.mrn, p.full_name, a.reason_text, a.booked_by_kind,
              a.cancelled_reason, a.rescheduled_from, a.created_at
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
  const patientJson = (x: { id: string; mrn: string; home_branch_id: string | null; city?: string | null; full_name: string; phone_e164_enc: Buffer; date_of_birth: string | null; sex: string | null; preferred_language: string; next_appointment?: Date | null }) => ({
    id: x.id, mrn: x.mrn, fullName: x.full_name, phone: decrypt(config.dataKey, x.phone_e164_enc), dateOfBirth: x.date_of_birth,
    sex: x.sex, preferredLanguage: x.preferred_language, homeBranchId: x.home_branch_id, city: x.city ?? null,
    nextAppointmentAt: x.next_appointment ? new Date(x.next_appointment).toISOString() : null,
  });
  const PATIENT_SELECT = `SELECT pp.id, pp.mrn, pp.home_branch_id, pp.city, p.full_name, p.phone_e164_enc, p.date_of_birth::text, p.sex, p.preferred_language,
      (SELECT min(lower(a.slot)) FROM app.appointments a WHERE a.patient_profile_id = pp.id AND lower(a.slot) > now() AND a.status IN ${LIVE_SQL}) AS next_appointment
    FROM app.patient_profiles pp JOIN app.patients p ON p.id = pp.patient_id`;

  /** Search by full mobile number, clinic patient ID or part of the name. */
  r.get('/patients', user, org, requirePermission('patient:read'), async (req, res) => {
    const term = String(req.query.q ?? '').trim();
    const items = await inOrg(req, async () => {
      const s = patientScope(req, 'patient:read');
      const repl: Repl = { ...s.repl };
      let cond = 'TRUE';
      if (term) {
        const phone = phoneE164.safeParse(term);
        if (phone.success && /\d{10}/.test(term.replace(/\D/g, ''))) {
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
      const rows = await q<Parameters<typeof patientJson>[0]>(`${PATIENT_SELECT} WHERE pp.deleted_at IS NULL AND ${s.sql} AND ${cond} ORDER BY pp.created_at DESC LIMIT 50`, repl);
      return rows.map(patientJson);
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
      const hash = phoneHash(body.phone);
      // Families often share one mobile number, so the same number is fine; the same number AND name is a duplicate.
      const [dup] = await q<{ id: string; mrn: string }>(
        `SELECT pp.id, pp.mrn FROM app.patient_profiles pp JOIN app.patients p ON p.id = pp.patient_id
          WHERE pp.deleted_at IS NULL AND p.phone_hash = :hash AND lower(p.full_name) = lower(:name)`, { hash, name: body.fullName });
      if (dup) throw new HttpError(409, 'conflict', `${body.fullName} is already registered (${dup.mrn})`, { patientProfileId: dup.id });

      const [counter] = await q<{ n: number; prefix: string | null; name: string }>(
        `UPDATE app.organization_settings s SET next_mrn = next_mrn + 1 FROM app.organizations o
          WHERE s.organization_id = :org AND o.id = s.organization_id RETURNING s.next_mrn - 1 AS n, s.mrn_prefix AS prefix, o.name`, { org: orgId(req) });
      if (!counter) throw notFound();
      let prefix = counter.prefix;
      if (!prefix) {
        prefix = counter.name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).map((w) => w[0]!.toUpperCase()).join('').slice(0, 3) || 'PT';
        await OrganizationSettings.update({ mrnPrefix: prefix }, { where: { organizationId: orgId(req) } });
      }
      const person = await Patient.create({
        phoneE164Enc: encrypt(config.dataKey, body.phone), phoneHash: hash, fullName: body.fullName,
        dateOfBirth: body.dateOfBirth ?? null, sex: body.sex ?? null, preferredLanguage: body.preferredLanguage, createdByOrg: orgId(req),
      });
      const profile = await PatientProfile.create({
        organizationId: orgId(req), patientId: person.id, mrn: `${prefix}-${counter.n}`, homeBranchId,
        city: body.city ?? null, acquisitionSource: body.acquisitionSource ?? null,
      });
      await auditFromReq(req, { action: 'patient.create', targetType: 'patient_profile', targetId: profile.id, details: { mrn: profile.mrn } });
      const [row] = await q<Parameters<typeof patientJson>[0]>(`${PATIENT_SELECT} WHERE pp.id = :id`, { id: profile.id });
      return patientJson(row!);
    });
    res.status(201).json(out);
  });

  r.get('/patients/:id', user, org, requirePermission('patient:read'), async (req, res) => {
    const out = await inOrg(req, async () => {
      const id = String(req.params.id);
      await assertPatientVisible(req, id, 'patient:read');
      const [row] = await q<Parameters<typeof patientJson>[0] & { patient_id: string }>(`${PATIENT_SELECT.replace('SELECT pp.id,', 'SELECT pp.id, pp.patient_id,')} WHERE pp.id = :id`, { id });
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
      const [row] = await q<Parameters<typeof patientJson>[0]>(`${PATIENT_SELECT} WHERE pp.id = :id`, { id });
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

  return r;
}
