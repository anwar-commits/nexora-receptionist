import { Doctor, DoctorService, QueryTypes, Service } from '@dr/db';
import { DateTime } from 'luxon';
import type { Deps } from '../context.js';
import { HttpError, conflict } from '../errors.js';
import { computeAvailability, type Busy, type Mode, type WeeklyRule } from './availability.js';

/**
 * The booking core shared by staff screens and the AI receptionist: free slots, the
 * doctor/service check and the "is this exact time still free" check. Runs inside withContext.
 */

export const LIVE_SQL = `('held','booked','confirmed','checked_in','in_consultation')`;
const badRequest = (message: string) => new HttpError(400, 'validation_failed', message);

export interface SlotRequest {
  doctor: Doctor; service: Service; mode: Mode; branchId: string | null;
  fromDate: string; days: number; excludeAppointmentId?: string; excludeHoldId?: string;
  /** Earliest bookable time is now + this many minutes. Staff 0; the AI keeps a margin. */
  minLeadMinutes?: number;
}

export async function freeSlots(deps: Deps, timeZone: string, s: SlotRequest) {
  const q = <T extends object>(sql: string, replacements: Record<string, unknown>) => deps.db.sequelize.query<T>(sql, { replacements, type: QueryTypes.SELECT });
  const windowStart = DateTime.fromISO(s.fromDate, { zone: timeZone }).startOf('day');
  const windowEnd = windowStart.plus({ days: s.days + 1 });
  const repl = { doctor: s.doctor.id, a: windowStart.toISO(), b: windowEnd.toISO(), ex: s.excludeAppointmentId ?? null, hold: s.excludeHoldId ?? null, tz: timeZone };
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
    timeZone, fromDate: s.fromDate, days: s.days, now: new Date(), minLeadMinutes: s.minLeadMinutes ?? 0,
    slotMinutes: s.doctor.slotMinutes, bufferMinutes: s.doctor.bufferMinutes, maxOnlinePerDay: s.doctor.maxOnlinePerDay,
    durationMinutes: s.service.durationMinutes, mode: s.mode, branchId: s.branchId,
    rules: rules.map((x): WeeklyRule => ({ weekday: x.weekday, start: x.start_local, end: x.end_local, mode: x.mode, branchId: x.branch_id, validFrom: x.valid_from, validTo: x.valid_to })),
    unavailable: leave.map((x) => ({ start: new Date(x.s), end: new Date(x.e) })),
    holidays: holidays.map((h) => ({ onDate: h.on_date, branchId: h.branch_id })),
    busy: busy.map((x): Busy => ({ start: new Date(x.s), end: new Date(x.e), mode: x.mode })),
  });
}

/** Loads and checks doctor + service for a booking. */
export async function loadTarget(doctorId: string, serviceId: string, mode: Mode) {
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
export async function assertFree(deps: Deps, timeZone: string, s: Omit<SlotRequest, 'fromDate' | 'days'>, start: string) {
  const when = DateTime.fromISO(start, { setZone: true });
  if (!when.isValid) throw badRequest('Invalid start time');
  const [day] = await freeSlots(deps, timeZone, { ...s, fromDate: when.setZone(timeZone).toISODate()!, days: 1 });
  const slot = day?.slots.find((x) => +new Date(x.start) === +when.toJSDate() && (s.mode !== 'clinic' || !s.branchId || x.branchId === s.branchId));
  if (!slot) throw conflict('That time is not free. Pick another slot.');
  return slot;
}

export const lockDoctor = (deps: Deps, doctorId: string) => deps.db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:d))', { replacements: { d: doctorId } });
export const isExclusionViolation = (e: unknown) => (e as { original?: { code?: string } })?.original?.code === '23P01';
