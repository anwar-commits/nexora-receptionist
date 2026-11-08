import { QueryTypes, type Transaction } from '@dr/db';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Deps } from '../context.js';
import { HttpError } from '../errors.js';
import { audit } from '../lib/audit.js';
import type { Mode } from '../lib/availability.js';
import { assertFree, freeSlots, isExclusionViolation, LIVE_SQL, loadTarget, lockDoctor } from '../lib/booking.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { createPatient, patientPhoneHash } from '../lib/patients.js';
import { advanceLeadsForPatient } from '../modules/crm.js';
import type { ToolDef } from './llm.js';
import type { AgentConfig } from './prompt.js';

/**
 * The receptionist's tools. They run on our server against the clinic's real calendar, and the
 * rules that matter are enforced here, not in the prompt:
 *  - booking needs an active hold made on THIS call and the caller's explicit yes;
 *  - one hold per call; after an emergency or self-harm turn nothing can be booked on the call;
 *  - a caller only ever sees or changes appointments of patients registered with their own number,
 *    and changing one needs the patient's date of birth;
 *  - consent is only recorded for a registered patient.
 * Every call is logged in tool_invocations (dates of birth masked).
 */

export interface CallCtx {
  orgId: string;
  callId: string;
  agentId: string;
  versionId: string;
  runId: string;
  config: AgentConfig;
  timeZone: string;
  /** Caller's number in E.164, if the phone network passed it on. */
  callerPhone: string | null;
}

export type SystemAction = { kind: 'end_call'; reason: string } | { kind: 'transfer'; number: string; reason: string };
export interface ToolOutcome {
  status: 'ok' | 'rejected' | 'error';
  result: Record<string, unknown>;
  action?: SystemAction;
}

type Repl = Record<string, unknown>;
const AI_LEAD_MINUTES = 30; // the AI never offers a slot starting in the next half hour
const HOLD_MINUTES = 10;
const NOTICE_VERSION = 'voice-v1';

class Rejected extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const reject = (code: string, message: string): never => { throw new Rejected(code, message); };

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const mode = z.enum(['clinic', 'video', 'phone']);

const SCHEMAS = {
  get_caller_context: z.object({}).strict(),
  list_services: z.object({}).strict(),
  get_availability: z.object({ service_id: uuid, mode: mode.default('clinic'), from_date: isoDate.optional(), doctor_id: uuid.optional(), branch_id: uuid.optional() }),
  hold_slot: z.object({ doctor_id: uuid, service_id: uuid, mode: mode.default('clinic'), start: z.string().min(10), branch_id: uuid.nullable().optional() }),
  book_appointment: z.object({ hold_id: uuid, confirmed_by_caller: z.boolean().optional(), patient_ref: uuid.optional(), full_name: z.string().trim().min(2).max(120).optional(), date_of_birth: isoDate.optional(), reason: z.string().max(500).optional() }),
  find_my_appointments: z.object({}).strict(),
  cancel_appointment: z.object({ appointment_id: uuid, date_of_birth: isoDate, reason: z.string().max(300).optional() }),
  reschedule_appointment: z.object({ appointment_id: uuid, date_of_birth: isoDate, hold_id: uuid, confirmed_by_caller: z.boolean().optional() }),
  create_or_update_lead: z.object({ name: z.string().trim().min(1).max(120).optional(), interest: z.string().max(200).optional(), notes: z.string().max(1000).optional(), wants_visit_by: isoDate.optional() }),
  record_consent: z.object({ purpose: z.enum(['whatsapp_updates', 'ai_followup_calls']), given: z.boolean() }),
  request_handoff: z.object({ reason: z.enum(['asked_for_person', 'complaint', 'billing', 'ai_unsure', 'clinical_question', 'vip']), note: z.string().max(500).optional() }),
  log_safety_event: z.object({ kind: z.enum(['abuse', 'emergency_redirect', 'self_harm_risk']), note: z.string().max(500) }),
  end_call: z.object({ reason: z.string().max(200).optional() }),
} as const;
export type ToolName = keyof typeof SCHEMAS;
export const TOOL_NAMES = Object.keys(SCHEMAS) as ToolName[];

/** JSON schemas the model sees. Descriptions say what the server will refuse, so the model asks first. */
export const TOOL_DEFS: ToolDef[] = [
  { name: 'get_caller_context', description: 'Who is calling: registered patients on this phone number (first names and patient_ref only) and how many upcoming appointments. Call once at the start.', input_schema: { type: 'object', properties: {} } },
  { name: 'list_services', description: 'Services the clinic offers, with duration, how they can be booked (clinic/video/phone), the fee if the clinic allows quoting it, and doctors.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_availability', description: 'Real free appointment times for a service (next 7 days from from_date). Offer at most three to the caller.', input_schema: { type: 'object', properties: { service_id: { type: 'string' }, mode: { type: 'string', enum: ['clinic', 'video', 'phone'] }, from_date: { type: 'string', description: 'YYYY-MM-DD' }, doctor_id: { type: 'string' }, branch_id: { type: 'string' } }, required: ['service_id'] } },
  { name: 'hold_slot', description: 'Hold the time the caller picked for 10 minutes while you confirm. Only one hold per call: a new hold replaces the old one.', input_schema: { type: 'object', properties: { doctor_id: { type: 'string' }, service_id: { type: 'string' }, mode: { type: 'string', enum: ['clinic', 'video', 'phone'] }, start: { type: 'string', description: 'start exactly as returned by get_availability' }, branch_id: { type: 'string' } }, required: ['doctor_id', 'service_id', 'start'] } },
  { name: 'book_appointment', description: 'Book the held slot. Only after reading back doctor, day, time, place and fee AND the caller clearly said yes: set confirmed_by_caller true. Use patient_ref for a registered patient; otherwise give the patient full_name (and date_of_birth if they share it) to register them with this phone number.', input_schema: { type: 'object', properties: { hold_id: { type: 'string' }, confirmed_by_caller: { type: 'boolean' }, patient_ref: { type: 'string' }, full_name: { type: 'string' }, date_of_birth: { type: 'string', description: 'YYYY-MM-DD' }, reason: { type: 'string', description: 'the problem in the caller\'s words' } }, required: ['hold_id', 'confirmed_by_caller'] } },
  { name: 'find_my_appointments', description: 'Upcoming appointments of patients registered with the caller\'s phone number.', input_schema: { type: 'object', properties: {} } },
  { name: 'cancel_appointment', description: 'Cancel one of the caller\'s appointments. Ask for the patient\'s date of birth first; the server checks it.', input_schema: { type: 'object', properties: { appointment_id: { type: 'string' }, date_of_birth: { type: 'string', description: 'YYYY-MM-DD' }, reason: { type: 'string' } }, required: ['appointment_id', 'date_of_birth'] } },
  { name: 'reschedule_appointment', description: 'Move one of the caller\'s appointments to a held slot (hold_slot first, same service). Needs the patient\'s date of birth and the caller\'s clear yes.', input_schema: { type: 'object', properties: { appointment_id: { type: 'string' }, date_of_birth: { type: 'string' }, hold_id: { type: 'string' }, confirmed_by_caller: { type: 'boolean' } }, required: ['appointment_id', 'date_of_birth', 'hold_id', 'confirmed_by_caller'] } },
  { name: 'create_or_update_lead', description: 'Note the caller\'s interest when they are not booking now, so staff can follow up.', input_schema: { type: 'object', properties: { name: { type: 'string' }, interest: { type: 'string' }, notes: { type: 'string' }, wants_visit_by: { type: 'string', description: 'YYYY-MM-DD' } } } },
  { name: 'record_consent', description: 'Record a registered patient\'s yes or no to WhatsApp updates or AI follow-up calls, in their own words on this call.', input_schema: { type: 'object', properties: { purpose: { type: 'string', enum: ['whatsapp_updates', 'ai_followup_calls'] }, given: { type: 'boolean' } }, required: ['purpose', 'given'] } },
  { name: 'request_handoff', description: 'Hand the call to clinic staff (transfer if a number is set, otherwise a call-back task).', input_schema: { type: 'object', properties: { reason: { type: 'string', enum: ['asked_for_person', 'complaint', 'billing', 'ai_unsure', 'clinical_question', 'vip'] }, note: { type: 'string', description: 'one line for staff' } }, required: ['reason'] } },
  { name: 'log_safety_event', description: 'Record abuse, or an emergency or self-harm statement the caller made that you noticed.', input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['abuse', 'emergency_redirect', 'self_harm_risk'] }, note: { type: 'string' } }, required: ['kind', 'note'] } },
  { name: 'end_call', description: 'End the call after saying goodbye.', input_schema: { type: 'object', properties: { reason: { type: 'string' } } } },
];

/** Tools a clinic's settings allow. The rest are not even shown to the model. */
export function allowedTools(c: AgentConfig): ToolName[] {
  return TOOL_NAMES.filter((n) =>
    !(n === 'book_appointment' && !c.guardrails.allowBooking)
    && !(n === 'cancel_appointment' && !c.guardrails.allowCancel)
    && !(n === 'reschedule_appointment' && !c.guardrails.allowReschedule)
    && !(n === 'hold_slot' && !c.guardrails.allowBooking && !c.guardrails.allowReschedule));
}

const maskArgs = (a: Record<string, unknown>) => ('date_of_birth' in a ? { ...a, date_of_birth: '••••-••-••' } : a);

/**
 * Runs one tool inside a savepoint of the caller's transaction (so a refused booking never
 * poisons the rest of the turn) and logs it.
 */
export async function runTool(deps: Deps, ctx: CallCtx, t: Transaction, name: string, rawInput: unknown): Promise<ToolOutcome> {
  const started = Date.now();
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  let outcome: ToolOutcome;
  try {
    if (!(TOOL_NAMES as string[]).includes(name) || !allowedTools(ctx.config).includes(name as ToolName)) reject('not_allowed', `The clinic has not enabled ${name}.`);
    const schema = SCHEMAS[name as ToolName];
    const parsed = schema.safeParse(input);
    if (!parsed.success) reject('invalid_input', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    outcome = await deps.db.sequelize.transaction({ transaction: t }, () => IMPL[name as ToolName](deps, ctx, parsed.data as never));
  } catch (e) {
    if (e instanceof Rejected) outcome = { status: 'rejected', result: { ok: false, rejected: e.code, message: e.message } };
    else if (e instanceof HttpError && e.status < 500) outcome = { status: 'rejected', result: { ok: false, rejected: e.code, message: e.message } };
    else if (isExclusionViolation(e)) outcome = { status: 'rejected', result: { ok: false, rejected: 'slot_taken', message: 'That time was just taken. Offer another.' } };
    else {
      deps.log.error({ err: e, tool: name }, 'voice tool failed');
      outcome = { status: 'error', result: { ok: false, rejected: 'error', message: 'Something went wrong. Offer a call back from the clinic.' } };
    }
  }
  await deps.db.sequelize.query(
    `INSERT INTO app.tool_invocations (organization_id, agent_run_id, tool, arguments, result, status, rejection_reason, latency_ms)
     VALUES (:org, :run, :tool, CAST(:args AS jsonb), CAST(:result AS jsonb), :status, :why, :ms)`,
    { replacements: { org: ctx.orgId, run: ctx.runId, tool: name, args: JSON.stringify(maskArgs(input)), result: JSON.stringify(outcome.result), status: outcome.status, why: (outcome.result.rejected as string | undefined) ?? null, ms: Date.now() - started }, transaction: t });
  return outcome;
}

// ---------------------------------------------------------------------------
// Implementations. Each runs inside withContext (RLS = this clinic) and a savepoint.
// ---------------------------------------------------------------------------
type Impl<N extends ToolName> = (deps: Deps, ctx: CallCtx, input: z.infer<(typeof SCHEMAS)[N]>) => Promise<ToolOutcome>;
const ok = (result: Record<string, unknown>, action?: SystemAction): ToolOutcome => ({ status: 'ok', result: { ok: true, ...result }, action });
const q = <T extends object>(deps: Deps, sql: string, replacements: Repl = {}) => deps.db.sequelize.query<T>(sql, { replacements, type: QueryTypes.SELECT });
const exec = (deps: Deps, sql: string, replacements: Repl = {}) => deps.db.sequelize.query(sql, { replacements });
const firstName = (full: string) => full.trim().split(/\s+/)[0] ?? full;
const rupees = (paise: number | string | null) => (paise === null ? null : `₹${(Number(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const label = (iso: string | Date, tz: string) => DateTime.fromJSDate(new Date(iso), { zone: tz }).toFormat("ccc d LLL, h:mm a");

const callerHash = (deps: Deps, ctx: CallCtx) => (ctx.callerPhone ? patientPhoneHash(deps, ctx.callerPhone) : null);

async function callerPatients(deps: Deps, ctx: CallCtx) {
  const h = callerHash(deps, ctx);
  if (!h) return [];
  return q<{ profile_id: string; patient_id: string; full_name: string; date_of_birth: string | null }>(deps,
    `SELECT pp.id AS profile_id, p.id AS patient_id, p.full_name, p.date_of_birth::text FROM app.patient_profiles pp JOIN app.patients p ON p.id = pp.patient_id
      WHERE p.phone_hash = :h AND pp.deleted_at IS NULL ORDER BY pp.created_at`, { h });
}

async function callRow(deps: Deps, ctx: CallCtx) {
  const [c] = await q<{ safety_locked: boolean; patient_id: string | null; lead_id: string | null }>(deps, `SELECT safety_locked, patient_id, lead_id FROM app.calls WHERE id = :id`, { id: ctx.callId });
  return c ?? { safety_locked: false, patient_id: null, lead_id: null };
}

async function assertNotLocked(deps: Deps, ctx: CallCtx) {
  if ((await callRow(deps, ctx)).safety_locked) reject('safety_locked', 'An emergency or safety concern came up on this call, so nothing can be booked. Offer a call back from the clinic team.');
}

const setOutcome = (deps: Deps, ctx: CallCtx, outcome: string, extra: Repl = {}) =>
  exec(deps, `UPDATE app.calls SET outcome = CAST(:o AS app.call_outcome), patient_id = COALESCE(CAST(:p AS uuid), patient_id) WHERE id = :id`, { o: outcome, p: extra.patientId ?? null, id: ctx.callId });

async function activeHold(deps: Deps, ctx: CallCtx, holdId: string) {
  const [h] = await q<{ id: string; doctor_id: string; service_id: string; mode: Mode; branch_id: string | null; start: Date }>(deps,
    `SELECT id, doctor_id, service_id, mode, branch_id, lower(slot) AS start FROM app.slot_holds
      WHERE id = :id AND held_by_kind = 'call' AND held_by_ref = :call AND expires_at > now()`, { id: holdId, call: ctx.callId });
  if (!h) reject('no_active_hold', 'There is no active hold for this call. Use hold_slot first (holds last 10 minutes).');
  return h!;
}

const placeOf = async (deps: Deps, mode: Mode, branchId: string | null) => {
  if (mode !== 'clinic') return mode === 'video' ? 'video consultation' : 'phone consultation';
  const [b] = await q<{ name: string; address_line: string }>(deps, `SELECT name, address_line FROM app.branches WHERE id = :id`, { id: branchId });
  return b ? `${b.name}, ${b.address_line}` : 'the clinic';
};

/** Appointment of a patient on the caller's number, verified by date of birth. */
async function verifiedAppointment(deps: Deps, ctx: CallCtx, appointmentId: string, dob: string) {
  const h = callerHash(deps, ctx);
  const [a] = h ? await q<{ id: string; status: string; date_of_birth: string | null; profile_id: string; service_id: string; doctor_id: string; mode: Mode; branch_id: string | null; fee_paise: string | null; reason_text: string | null; start: Date }>(deps,
    `SELECT a.id, a.status, p.date_of_birth::text, a.patient_profile_id AS profile_id, a.service_id, a.doctor_id, a.mode, a.branch_id, a.fee_paise, a.reason_text, lower(a.slot) AS start
       FROM app.appointments a JOIN app.patient_profiles pp ON pp.id = a.patient_profile_id JOIN app.patients p ON p.id = pp.patient_id
      WHERE a.id = :id AND p.phone_hash = :h AND a.status IN ('booked','confirmed') AND lower(a.slot) > now()`, { id: appointmentId, h }) : [];
  if (!a) reject('not_found', 'No upcoming appointment with that reference for this phone number.');
  if (!a!.date_of_birth) reject('identity_not_verified', 'No date of birth is on file for this patient. Hand off to staff to make changes.');
  if (a!.date_of_birth !== dob) reject('identity_not_verified', 'The date of birth does not match. Do not change the appointment; offer a call back from staff.');
  return a!;
}

const IMPL: { [N in ToolName]: Impl<N> } = {
  async get_caller_context(deps, ctx) {
    if (!ctx.callerPhone) return ok({ known: false, phone_available: false });
    const patients = await callerPatients(deps, ctx);
    const [up] = patients.length ? await q<{ n: string }>(deps,
      `SELECT count(*) AS n FROM app.appointments WHERE patient_profile_id IN (:ids) AND status IN ${LIVE_SQL} AND lower(slot) > now()`, { ids: patients.map((p) => p.profile_id) }) : [{ n: '0' }];
    if (patients.length === 1) await exec(deps, `UPDATE app.calls SET patient_id = :p WHERE id = :id`, { p: patients[0]!.patient_id, id: ctx.callId });
    return ok({
      known: patients.length > 0, phone_available: true,
      patients: patients.map((p) => ({ patient_ref: p.profile_id, first_name: firstName(p.full_name) })),
      upcoming_appointments: Number(up?.n ?? 0),
    });
  },

  async list_services(deps) {
    const rows = await q<{ id: string; name: string; duration_minutes: number; fee_paise: string | null; ai_may_quote_fee: boolean; modes: string[]; doctors: { id: string; name: string }[] | null }>(deps,
      `SELECT s.id, s.name, s.duration_minutes, s.fee_paise, s.ai_may_quote_fee, s.modes::text[] AS modes,
              (SELECT json_agg(json_build_object('id', d.id, 'name', d.display_name) ORDER BY d.display_name) FROM app.doctors d
                WHERE d.is_active AND d.deleted_at IS NULL AND d.bookable_by_ai
                  AND (NOT EXISTS (SELECT 1 FROM app.doctor_services x WHERE x.doctor_id = d.id) OR EXISTS (SELECT 1 FROM app.doctor_services x WHERE x.doctor_id = d.id AND x.service_id = s.id))) AS doctors
         FROM app.services s WHERE s.is_active ORDER BY s.duration_minutes, s.name`);
    return ok({
      services: rows.map((s) => ({
        service_id: s.id, name: s.name, duration_minutes: s.duration_minutes, modes: s.modes,
        fee: s.ai_may_quote_fee && s.fee_paise !== null ? rupees(s.fee_paise) : 'the clinic will confirm the fee',
        doctors: s.doctors ?? [],
      })),
    });
  },

  async get_availability(deps, ctx, input) {
    const doctors = await q<{ id: string }>(deps,
      `SELECT d.id FROM app.doctors d WHERE d.is_active AND d.deleted_at IS NULL AND d.bookable_by_ai AND (CAST(:doc AS uuid) IS NULL OR d.id = CAST(:doc AS uuid))
          AND (NOT EXISTS (SELECT 1 FROM app.doctor_services x WHERE x.doctor_id = d.id) OR EXISTS (SELECT 1 FROM app.doctor_services x WHERE x.doctor_id = d.id AND x.service_id = :svc))`,
      { doc: input.doctor_id ?? null, svc: input.service_id });
    if (!doctors.length) reject('no_doctor', 'No doctor the AI may book offers this service. Offer a call back.');
    const from = input.from_date ?? DateTime.now().setZone(ctx.timeZone).toISODate()!;
    const all: { doctor_id: string; doctor_name: string; start: string; branch_id: string | null; when: string }[] = [];
    for (const d of doctors) {
      const { doctor, service } = await loadTarget(d.id, input.service_id, input.mode);
      const days = await freeSlots(deps, ctx.timeZone, { doctor, service, mode: input.mode, branchId: input.branch_id ?? null, fromDate: from, days: 7, minLeadMinutes: AI_LEAD_MINUTES });
      for (const day of days) for (const s of day.slots) all.push({ doctor_id: doctor.id, doctor_name: doctor.displayName, start: s.start, branch_id: s.branchId, when: label(s.start, ctx.timeZone) });
    }
    all.sort((a, b) => +new Date(a.start) - +new Date(b.start));
    // Spread the offer: the first free time of each of the next few days rather than six slots on one morning.
    const picked: typeof all = [];
    const seenDay = new Set<string>();
    for (const s of all) { const k = `${s.doctor_id}|${s.when.slice(0, 10)}`; if (!seenDay.has(k)) { seenDay.add(k); picked.push(s); } if (picked.length >= 6) break; }
    for (const s of all) { if (picked.length >= 6) break; if (!picked.includes(s)) picked.push(s); }
    picked.sort((a, b) => +new Date(a.start) - +new Date(b.start));
    return ok({ slots: picked, note: picked.length ? 'Offer at most three of these.' : 'No free times in the next 7 days. Offer a later date or a call back.' });
  },

  async hold_slot(deps, ctx, input) {
    await assertNotLocked(deps, ctx);
    await lockDoctor(deps, input.doctor_id);
    const { doctor, service, fee } = await loadTarget(input.doctor_id, input.service_id, input.mode);
    if (!doctor.bookableByAi) reject('not_allowed', `${doctor.displayName} is not booked by the AI. Offer a call back.`);
    const [mine] = await q<{ id: string }>(deps, `SELECT id FROM app.slot_holds WHERE held_by_kind = 'call' AND held_by_ref = :call`, { call: ctx.callId });
    const slot = await assertFree(deps, ctx.timeZone, { doctor, service, mode: input.mode, branchId: input.branch_id ?? null, excludeHoldId: mine?.id, minLeadMinutes: AI_LEAD_MINUTES }, input.start);
    await exec(deps, `DELETE FROM app.slot_holds WHERE (held_by_kind = 'call' AND held_by_ref = :call) OR (doctor_id = :d AND expires_at <= now())`, { call: ctx.callId, d: doctor.id });
    const [h] = await q<{ id: string }>(deps,
      `INSERT INTO app.slot_holds (organization_id, doctor_id, service_id, mode, branch_id, slot, held_by_kind, held_by_ref, expires_at)
       VALUES (:org, :d, :s, CAST(:m AS app.consult_mode), :b, tstzrange(:a, :z, '[)'), 'call', :call, now() + make_interval(mins => :mins)) RETURNING id`,
      { org: ctx.orgId, d: doctor.id, s: service.id, m: input.mode, b: slot.branchId, a: slot.start, z: slot.end, call: ctx.callId, mins: HOLD_MINUTES });
    const quotable = service.aiMayQuoteFee && fee !== null;
    return ok({
      hold_id: h!.id, doctor: doctor.displayName, service: service.name, when: label(slot.start, ctx.timeZone), place: await placeOf(deps, input.mode, slot.branchId),
      fee: quotable ? rupees(fee) : 'the clinic will confirm the fee', held_minutes: HOLD_MINUTES,
      next: 'Read back doctor, day, time, place and fee, and ask the caller to confirm.',
    });
  },

  async book_appointment(deps, ctx, input) {
    await assertNotLocked(deps, ctx);
    if (input.confirmed_by_caller !== true) reject('needs_confirmation', 'Read back the details and get the caller\'s clear yes before booking.');
    const hold = await activeHold(deps, ctx, input.hold_id);
    if (!ctx.callerPhone) reject('caller_number_unknown', 'The caller\'s number is not available, so the booking cannot be registered. Offer a call back.');
    const key = `ai:${ctx.callId}:${hold.id}`;
    const [already] = await q<{ id: string }>(deps, `SELECT id FROM app.appointments WHERE idempotency_key = :k`, { k: key });
    if (already) return ok({ appointment_id: already.id, already_booked: true });

    // Who is the patient? A registered patient on this number, or register them now.
    const patients = await callerPatients(deps, ctx);
    let profile = input.patient_ref ? patients.find((p) => p.profile_id === input.patient_ref) : undefined;
    if (input.patient_ref && !profile) reject('not_found', 'That patient is not registered with this phone number.');
    if (!profile && input.full_name) profile = patients.find((p) => p.full_name.toLowerCase() === input.full_name!.toLowerCase());
    let profileId = profile?.profile_id;
    if (!profileId) {
      if (!input.full_name) reject('need_name', 'Ask for the patient\'s full name to register them.');
      profileId = await createPatient(deps, { orgId: ctx.orgId, aiVersionId: ctx.versionId }, {
        fullName: input.full_name!, phone: ctx.callerPhone!, dateOfBirth: input.date_of_birth ?? null, preferredLanguage: ctx.config.languages[0] === 'en' ? 'en' : 'hi', acquisitionSource: 'phone_call',
      }, hold.branch_id);
    }

    await lockDoctor(deps, hold.doctor_id);
    const { doctor, service, fee } = await loadTarget(hold.doctor_id, hold.service_id, hold.mode);
    const slot = await assertFree(deps, ctx.timeZone, { doctor, service, mode: hold.mode, branchId: hold.branch_id, excludeHoldId: hold.id }, new Date(hold.start).toISOString());
    const [a] = await q<{ id: string }>(deps,
      `INSERT INTO app.appointments (organization_id, branch_id, doctor_id, service_id, patient_profile_id, mode, slot, status, booked_by_kind, booked_by_id, fee_paise, reason_text, idempotency_key, source_call_id)
       VALUES (:org, :b, :d, :s, :p, CAST(:m AS app.consult_mode), tstzrange(:a, :z, '[)'), 'booked', 'ai_agent', :v, :fee, :reason, :k, :call) RETURNING id`,
      { org: ctx.orgId, b: slot.branchId, d: doctor.id, s: service.id, p: profileId, m: hold.mode, a: slot.start, z: slot.end, v: ctx.versionId, fee, reason: input.reason ?? null, k: key, call: ctx.callId });
    await exec(deps, `DELETE FROM app.slot_holds WHERE id = :id`, { id: hold.id });
    const [pp] = await q<{ patient_id: string }>(deps, `SELECT patient_id FROM app.patient_profiles WHERE id = :id`, { id: profileId });
    await setOutcome(deps, ctx, 'booked', { patientId: pp?.patient_id });
    await audit({ action: 'appointment.book', organizationId: ctx.orgId, actorKind: 'ai_agent', actorId: ctx.versionId, targetType: 'appointment', targetId: a!.id, details: { doctorId: doctor.id, start: slot.start, mode: hold.mode, callId: ctx.callId } });
    // Link the caller's open enquiry to the patient, then move it to "booked".
    await exec(deps, `UPDATE app.leads SET patient_id = :pid, updated_at = now() WHERE phone_hash = :h AND patient_id IS NULL AND stage IN ('enquiry','qualified')`, { pid: pp?.patient_id, h: callerHash(deps, ctx) });
    await advanceLeadsForPatient(deps, null, profileId!, ['enquiry', 'qualified'], 'booked', a!.id);
    return ok({ appointment_id: a!.id, doctor: doctor.displayName, when: label(slot.start, ctx.timeZone), place: await placeOf(deps, hold.mode, slot.branchId), patient_first_name: firstName(profile?.full_name ?? input.full_name!) });
  },

  async find_my_appointments(deps, ctx) {
    const h = callerHash(deps, ctx);
    if (!h) return ok({ appointments: [], note: 'Caller number not available.' });
    const rows = await q<{ id: string; full_name: string; doctor: string; service: string; start: Date; mode: Mode; branch_id: string | null }>(deps,
      `SELECT a.id, p.full_name, d.display_name AS doctor, s.name AS service, lower(a.slot) AS start, a.mode, a.branch_id
         FROM app.appointments a JOIN app.patient_profiles pp ON pp.id = a.patient_profile_id JOIN app.patients p ON p.id = pp.patient_id
         JOIN app.doctors d ON d.id = a.doctor_id JOIN app.services s ON s.id = a.service_id
        WHERE p.phone_hash = :h AND a.status IN ('booked','confirmed') AND lower(a.slot) > now() ORDER BY lower(a.slot) LIMIT 5`, { h });
    const out = [];
    for (const r of rows) out.push({ appointment_id: r.id, patient_first_name: firstName(r.full_name), doctor: r.doctor, service: r.service, when: label(r.start, ctx.timeZone), place: await placeOf(deps, r.mode, r.branch_id) });
    return ok({ appointments: out });
  },

  async cancel_appointment(deps, ctx, input) {
    const a = await verifiedAppointment(deps, ctx, input.appointment_id, input.date_of_birth);
    await exec(deps, `UPDATE app.appointments SET status = 'cancelled', cancelled_reason = :r, status_changed_at = now(), status_changed_by = NULL WHERE id = :id`,
      { id: a.id, r: `Cancelled by the caller on a call with the AI receptionist${input.reason ? `: ${input.reason}` : ''}` });
    await setOutcome(deps, ctx, 'cancelled');
    await audit({ action: 'appointment.cancel', organizationId: ctx.orgId, actorKind: 'ai_agent', actorId: ctx.versionId, targetType: 'appointment', targetId: a.id, details: { from: a.status, callId: ctx.callId } });
    return ok({ cancelled: true, was: label(a.start, ctx.timeZone) });
  },

  async reschedule_appointment(deps, ctx, input) {
    await assertNotLocked(deps, ctx);
    if (input.confirmed_by_caller !== true) reject('needs_confirmation', 'Read back the new time and get the caller\'s clear yes first.');
    const a = await verifiedAppointment(deps, ctx, input.appointment_id, input.date_of_birth);
    const hold = await activeHold(deps, ctx, input.hold_id);
    if (hold.service_id !== a.service_id) reject('invalid_input', 'Hold a slot for the same service as the appointment being moved.');
    await lockDoctor(deps, hold.doctor_id);
    const { doctor, service, fee } = await loadTarget(hold.doctor_id, hold.service_id, hold.mode);
    const slot = await assertFree(deps, ctx.timeZone, { doctor, service, mode: hold.mode, branchId: hold.branch_id, excludeHoldId: hold.id, excludeAppointmentId: a.id }, new Date(hold.start).toISOString());
    await exec(deps, `UPDATE app.appointments SET status = 'rescheduled', status_changed_at = now(), status_changed_by = NULL WHERE id = :id`, { id: a.id });
    const [n] = await q<{ id: string }>(deps,
      `INSERT INTO app.appointments (organization_id, branch_id, doctor_id, service_id, patient_profile_id, mode, slot, status, booked_by_kind, booked_by_id, fee_paise, reason_text, rescheduled_from, source_call_id)
       VALUES (:org, :b, :d, :s, :p, CAST(:m AS app.consult_mode), tstzrange(:x, :z, '[)'), 'booked', 'ai_agent', :v, :fee, :reason, :from, :call) RETURNING id`,
      { org: ctx.orgId, b: slot.branchId, d: doctor.id, s: service.id, p: a.profile_id, m: hold.mode, x: slot.start, z: slot.end, v: ctx.versionId, fee: doctor.id === a.doctor_id ? a.fee_paise : fee, reason: a.reason_text, from: a.id, call: ctx.callId });
    await exec(deps, `DELETE FROM app.slot_holds WHERE id = :id`, { id: hold.id });
    await setOutcome(deps, ctx, 'rescheduled');
    await audit({ action: 'appointment.reschedule', organizationId: ctx.orgId, actorKind: 'ai_agent', actorId: ctx.versionId, targetType: 'appointment', targetId: n!.id, details: { from: a.id, start: slot.start, callId: ctx.callId } });
    return ok({ appointment_id: n!.id, when: label(slot.start, ctx.timeZone), place: await placeOf(deps, hold.mode, slot.branchId), doctor: doctor.displayName });
  },

  async create_or_update_lead(deps, ctx, input) {
    const h = callerHash(deps, ctx);
    if (!h && !input.name) reject('need_name', 'Ask for the caller\'s name: their number is not available.');
    const [open] = h ? await q<{ id: string }>(deps, `SELECT id FROM app.leads WHERE phone_hash = :h AND stage NOT IN ('retained','lost') ORDER BY created_at DESC LIMIT 1`, { h }) : [];
    let leadId = open?.id;
    if (leadId) {
      await exec(deps, `UPDATE app.leads SET interest = COALESCE(:i, interest), display_name = COALESCE(display_name, :n), wants_visit_by = COALESCE(CAST(:w AS date), wants_visit_by), updated_at = now() WHERE id = :id`,
        { id: leadId, i: input.interest ?? null, n: input.name ?? null, w: input.wants_visit_by ?? null });
      await exec(deps, `INSERT INTO app.lead_events (organization_id, lead_id, kind, actor_kind, actor_id, ref_type, ref_id, note) VALUES (:org, :id, 'call', 'ai', :v, 'call', :call, :note)`,
        { org: ctx.orgId, id: leadId, v: ctx.versionId, call: ctx.callId, note: [input.interest, input.notes].filter(Boolean).join(' — ') || 'Called again' });
    } else {
      const [l] = await q<{ id: string }>(deps,
        `INSERT INTO app.leads (organization_id, display_name, phone_hash, phone_e164_enc, interest, source, source_detail, owner_kind, wants_visit_by)
         VALUES (:org, :n, :h, :enc, :i, 'phone_call', CAST(:detail AS jsonb), 'unassigned', CAST(:w AS date)) RETURNING id`,
        { org: ctx.orgId, n: input.name ?? null, h, enc: ctx.callerPhone ? encrypt(deps.config.dataKey, ctx.callerPhone) : null, i: input.interest ?? null, detail: JSON.stringify({ channel: 'ai_call', callId: ctx.callId }), w: input.wants_visit_by ?? null });
      leadId = l!.id;
      await exec(deps, `INSERT INTO app.lead_events (organization_id, lead_id, kind, to_stage, actor_kind, actor_id, ref_type, ref_id, note) VALUES (:org, :id, 'created', 'enquiry', 'ai', :v, 'call', :call, :note)`,
        { org: ctx.orgId, id: leadId, v: ctx.versionId, call: ctx.callId, note: [input.interest, input.notes].filter(Boolean).join(' — ') || null });
    }
    await exec(deps, `UPDATE app.calls SET lead_id = :l, outcome = COALESCE(outcome, 'follow_up') WHERE id = :id`, { l: leadId, id: ctx.callId });
    return ok({ lead_saved: true });
  },

  async record_consent(deps, ctx, input) {
    const c = await callRow(deps, ctx);
    const patients = await callerPatients(deps, ctx);
    const patientId = c.patient_id ?? (patients.length === 1 ? patients[0]!.patient_id : null);
    if (!patientId) reject('register_first', 'Consent can only be recorded for a registered patient. Book or register them first, or leave it to staff.');
    const at = new Date().toISOString();
    await exec(deps,
      `INSERT INTO app.consents (organization_id, patient_id, purpose, state, captured_via, evidence_ref, notice_version)
       VALUES (:org, :p, CAST(:purpose AS app.consent_purpose), CAST(:state AS app.consent_state), 'voice_call', :ev, :nv)`,
      { org: ctx.orgId, p: patientId, purpose: input.purpose, state: input.given ? 'given' : 'withdrawn', ev: `call:${ctx.callId}@${at}`, nv: NOTICE_VERSION });
    return ok({ recorded: input.given ? 'given' : 'withdrawn', purpose: input.purpose });
  },

  async request_handoff(deps, ctx, input) {
    const number = ctx.config.handoff.transferNumber;
    let taskId: string | null = null;
    if (!number) {
      const [t] = await q<{ id: string }>(deps,
        `INSERT INTO app.tasks (organization_id, kind, title, priority, assignee_kind, assignee_ref, due_at, related_type, related_id, created_by_kind, notes)
         VALUES (:org, 'callback', :title, CAST(:pr AS app.priority), 'role', 'receptionist', now() + interval '1 hour', 'call', :call, 'ai_agent', :note) RETURNING id`,
        { org: ctx.orgId, title: `Call back: ${input.reason.replace(/_/g, ' ')}`, pr: input.reason === 'complaint' ? 'high' : 'normal', call: ctx.callId, note: input.note ?? null });
      taskId = t!.id;
    }
    await exec(deps,
      `INSERT INTO app.handoffs (organization_id, call_id, reason, note_for_staff, requested_at, fallback_task_id, outcome) VALUES (:org, :call, :r, :note, now(), :task, :o)`,
      { org: ctx.orgId, call: ctx.callId, r: input.reason, note: input.note ?? null, task: taskId, o: number ? 'transferred' : 'callback_task' });
    await setOutcome(deps, ctx, 'handed_off');
    if (number) return ok({ transferring: true }, { kind: 'transfer', number, reason: input.reason });
    return ok({ transferring: false, callback_task: true, say: 'Tell the caller someone from the clinic will call them back soon.' });
  },

  async log_safety_event(deps, ctx, input) {
    await exec(deps, `INSERT INTO app.safety_events (organization_id, call_id, kind, trigger_text, detected_at, script_version) VALUES (:org, :call, :k, :t, now(), :sv)`,
      { org: ctx.orgId, call: ctx.callId, k: input.kind, t: input.note.slice(0, 500), sv: ctx.config.emergency.scriptVersion });
    return ok({ logged: true });
  },

  async end_call(_deps, _ctx, input) {
    return ok({ ending: true }, { kind: 'end_call', reason: input.reason ?? 'conversation finished' });
  },
};

export const decryptPhone = (deps: Deps, enc: Buffer | null) => (enc ? decrypt(deps.config.dataKey, enc) : null);
