import { DateTime } from 'luxon';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ROLE, as, makeApp, ownerWithClinic, staff, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(() => { t = makeApp(); });
afterAll(() => t.close());

const TZ = 'Asia/Kolkata';
/** A Monday at least a week ahead, as YYYY-MM-DD in India. */
const futureMonday = () => {
  const d = DateTime.now().setZone(TZ).plus({ days: 7 });
  return d.plus({ days: (8 - d.weekday) % 7 }).toISODate()!;
};
const ist = (date: string, time: string) => DateTime.fromISO(`${date}T${time}`, { zone: TZ }).toUTC().toISO()!;
const sameInstant = (a: string, b: string) => +new Date(a) === +new Date(b);

/** A clinic with one doctor (Mon–Sat 10:00–13:00 clinic, Mon 18:00–19:00 video), one service and one patient. */
async function clinic(name = 'Lumen Hair & Skin') {
  const owner = await ownerWithClinic(t, name);
  const o = as(owner.access, owner.orgId);
  const doctor = (await o(t.http.post('/v1/doctors')).send({ displayName: 'Dr. Arjun Mehta', slotMinutes: 20, bufferMinutes: 0 }).expect(201)).body;
  const rules = [0, 1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '10:00', end: '13:00', mode: 'clinic', branchId: owner.branchId }));
  await o(t.http.put(`/v1/doctors/${doctor.id}/schedule`)).send({ rules: [...rules, { weekday: 0, start: '18:00', end: '19:00', mode: 'video' }] }).expect(200);
  const service = (await o(t.http.post('/v1/services')).send({ name: 'New consultation', durationMinutes: 20, feePaise: 50000, modes: ['clinic', 'video'] }).expect(201)).body;
  const patient = (await o(t.http.post('/v1/patients')).send({ fullName: 'Ravi Kumar', phone: '9812345670', preferredLanguage: 'hi' }).expect(201)).body;
  return { owner, o, doctor, service, patient };
}

describe('patients', () => {
  it('registers patients with clinic IDs, finds them by number, ID or name, and logs every record read', async () => {
    const { o, patient } = await clinic('Lumen Hair & Skin');
    expect(patient).toMatchObject({ mrn: 'LHS-1001', fullName: 'Ravi Kumar', phone: '+919812345670' });
    const second = await o(t.http.post('/v1/patients')).send({ fullName: 'Sunita Devi', phone: '+91 98123 45670' }).expect(201);
    expect(second.body.mrn).toBe('LHS-1002'); // same family number, different person: fine
    const dup = await o(t.http.post('/v1/patients')).send({ fullName: 'ravi kumar', phone: '98123-45670' }).expect(409);
    expect(dup.body.error.details.patientProfileId).toBe(patient.id);

    expect((await o(t.http.get('/v1/patients?q=9812345670')).expect(200)).body.items).toHaveLength(2);
    expect((await o(t.http.get('/v1/patients?q=lhs-1002')).expect(200)).body.items.map((p: { fullName: string }) => p.fullName)).toEqual(['Sunita Devi']);
    expect((await o(t.http.get('/v1/patients?q=sun')).expect(200)).body.items).toHaveLength(1);
    expect((await o(t.http.get('/v1/patients?q=%25')).expect(200)).body.items).toHaveLength(0); // wildcards are literal

    await o(t.http.patch(`/v1/patients/${patient.id}`)).send({ city: 'Patna', dateOfBirth: '1988-04-12' }).expect(200);
    const detail = await o(t.http.get(`/v1/patients/${patient.id}`)).expect(200);
    expect(detail.body).toMatchObject({ city: 'Patna', dateOfBirth: '1988-04-12', appointments: [] });

    const c = new pg.Client({ connectionString: inject('ownerDatabaseUrl') });
    await c.connect();
    try {
      const log = await c.query(`SELECT actor_id, purpose FROM app.data_access_logs WHERE resource_id = $1`, [patient.id]);
      const me = (await o(t.http.get('/v1/me')).expect(200)).body.user.id;
      expect(log.rows).toEqual([{ actor_id: me, purpose: 'care' }]);
      // phone numbers are stored encrypted, never in plain text
      const raw = await c.query(`SELECT encode(phone_e164_enc, 'escape') AS enc FROM app.patients WHERE full_name = 'Ravi Kumar'`);
      expect(raw.rows[0].enc).not.toContain('9812345670');
    } finally {
      await c.end();
    }
  });

  it('keeps patients private to their clinic, in the API and in the database', async () => {
    const a = await clinic('Clinic A');
    const b = await clinic('Clinic B');
    await b.o(t.http.get(`/v1/patients/${a.patient.id}`)).expect(404);
    await b.o(t.http.patch(`/v1/patients/${a.patient.id}`)).send({ city: 'X' }).expect(404);
    // B's search for A's patient's number finds only B's own patient
    const found = (await b.o(t.http.get('/v1/patients?q=9812345670')).expect(200)).body.items;
    expect(found.map((p: { id: string }) => p.id)).toEqual([b.patient.id]);
    // B cannot book A's patient
    const start = (await b.o(t.http.get(`/v1/availability?doctorId=${b.doctor.id}&serviceId=${b.service.id}&mode=clinic&from=${futureMonday()}&days=1`))).body.days[0].slots[0].start;
    await b.o(t.http.post('/v1/appointments')).send({ doctorId: b.doctor.id, serviceId: b.service.id, mode: 'clinic', branchId: b.owner.branchId, start, patientProfileId: a.patient.id }).expect(404);

    // the API database login cannot read another clinic's people even with raw SQL
    const c = new pg.Client({ connectionString: inject('apiDatabaseUrl') });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [b.owner.orgId]);
      const people = await c.query(`SELECT full_name FROM app.patients`);
      expect(people.rows).toHaveLength(1);
      await expect(c.query(`INSERT INTO app.patients (phone_e164_enc, phone_hash, full_name, created_by_org) VALUES ('\\x00', 'h', 'Spoof', $1)`, [a.owner.orgId]))
        .rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });
});

describe('appointments', () => {
  it('books only free slots, never twice, and frees the slot when cancelled', async () => {
    const { owner, o, doctor, service, patient } = await clinic();
    const mon = futureMonday();
    const slots = (await o(t.http.get(`/v1/availability?doctorId=${doctor.id}&serviceId=${service.id}&mode=clinic&from=${mon}&days=1`)).expect(200)).body.days[0].slots;
    expect(slots).toHaveLength(9); // 10:00–13:00 in 20-minute slots
    expect(sameInstant(slots[0].start, ist(mon, '10:00'))).toBe(true);

    const body = { doctorId: doctor.id, serviceId: service.id, mode: 'clinic', branchId: owner.branchId, start: ist(mon, '10:20'), patientProfileId: patient.id, reasonText: 'Hair fall for 6 months' };
    const booked = await o(t.http.post('/v1/appointments')).send({ ...body, idempotencyKey: 'call-123-book-1' }).expect(201);
    expect(booked.body).toMatchObject({ status: 'booked', feePaise: 50000, doctorName: 'Dr. Arjun Mehta', patient: { mrn: patient.mrn } });
    // retrying the same request returns the same booking
    const again = await o(t.http.post('/v1/appointments')).send({ ...body, idempotencyKey: 'call-123-book-1' }).expect(200);
    expect(again.body.id).toBe(booked.body.id);
    // the slot is gone; off-grid and closed times are refused
    await o(t.http.post('/v1/appointments')).send(body).expect(409);
    await o(t.http.post('/v1/appointments')).send({ ...body, start: ist(mon, '10:10') }).expect(409);
    await o(t.http.post('/v1/appointments')).send({ ...body, start: ist(mon, '15:00') }).expect(409);
    // a service the doctor does not offer as video
    const procedure = (await o(t.http.post('/v1/services')).send({ name: 'PRP session', durationMinutes: 40, feePaise: 600000 }).expect(201)).body;
    await o(t.http.post('/v1/appointments')).send({ ...body, serviceId: procedure.id, mode: 'video', branchId: null, start: ist(mon, '18:00') }).expect(400);

    // 50 people try the same slot at once: exactly one gets it (the plan's concurrency bar)
    const results = await Promise.all(Array.from({ length: 50 }, () =>
      o(t.http.post('/v1/appointments')).send({ ...body, start: ist(mon, '11:00') })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(49);

    const left = (await o(t.http.get(`/v1/availability?doctorId=${doctor.id}&serviceId=${service.id}&mode=clinic&from=${mon}&days=1`))).body.days[0].slots;
    expect(left).toHaveLength(7);

    await o(t.http.post(`/v1/appointments/${booked.body.id}/cancel`)).send({ reason: 'x' }).expect(400);
    const cancelled = await o(t.http.post(`/v1/appointments/${booked.body.id}/cancel`)).send({ reason: 'Patient travelling' }).expect(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', cancelledReason: 'Patient travelling' });
    await o(t.http.post(`/v1/appointments/${booked.body.id}/cancel`)).send({ reason: 'Again' }).expect(409);
    expect((await o(t.http.get(`/v1/availability?doctorId=${doctor.id}&serviceId=${service.id}&mode=clinic&from=${mon}&days=1`))).body.days[0].slots).toHaveLength(8);

    const list = await o(t.http.get(`/v1/appointments?from=${ist(mon, '00:00')}&to=${ist(mon, '23:59')}`)).expect(200);
    expect(list.body.items.map((a: { status: string }) => a.status).sort()).toEqual(['booked', 'cancelled']);
  });

  it('holds a slot for a caller, then books it', async () => {
    const { owner, o, doctor, service, patient } = await clinic();
    const mon = futureMonday();
    const target = { doctorId: doctor.id, serviceId: service.id, mode: 'clinic', branchId: owner.branchId, start: ist(mon, '12:00') };
    const hold = await o(t.http.post('/v1/holds')).send(target).expect(201);
    await o(t.http.post('/v1/holds')).send(target).expect(409);
    await o(t.http.post('/v1/appointments')).send({ ...target, patientProfileId: patient.id }).expect(409); // held for someone else
    await o(t.http.post('/v1/appointments')).send({ ...target, patientProfileId: patient.id, holdId: hold.body.id }).expect(201);
  });

  it('reschedules, keeps the history, and moves through the day', async () => {
    const { owner, o, doctor, service, patient } = await clinic();
    const mon = futureMonday();
    const a = (await o(t.http.post('/v1/appointments')).send({ doctorId: doctor.id, serviceId: service.id, mode: 'clinic', branchId: owner.branchId, start: ist(mon, '10:00'), patientProfileId: patient.id }).expect(201)).body;
    // move it to the video session the same evening
    const moved = await o(t.http.post(`/v1/appointments/${a.id}/reschedule`)).send({ start: ist(mon, '18:20'), mode: 'video' }).expect(200);
    expect(moved.body).toMatchObject({ mode: 'video', branchId: null, rescheduledFrom: a.id, status: 'booked' });
    expect((await o(t.http.get(`/v1/appointments/${a.id}`))).body.status).toBe('rescheduled');
    await o(t.http.post(`/v1/appointments/${a.id}/reschedule`)).send({ start: ist(mon, '10:40') }).expect(409);

    // future appointments cannot be checked in, marked no-show or started early
    await o(t.http.post(`/v1/appointments/${moved.body.id}/status`)).send({ status: 'checked_in' }).expect(409);
    await o(t.http.post(`/v1/appointments/${moved.body.id}/status`)).send({ status: 'no_show' }).expect(409);
    await o(t.http.post(`/v1/appointments/${moved.body.id}/status`)).send({ status: 'completed' }).expect(409);
    await o(t.http.post(`/v1/appointments/${moved.body.id}/status`)).send({ status: 'confirmed' }).expect(200);

    // an appointment that already started (inserted directly) can be marked no-show, then nothing else
    const c = new pg.Client({ connectionString: inject('ownerDatabaseUrl') });
    await c.connect();
    let pastId: string;
    try {
      const r = await c.query(
        `INSERT INTO app.appointments (organization_id, branch_id, doctor_id, service_id, patient_profile_id, mode, slot, status, booked_by_kind)
         VALUES ($1, $2, $3, $4, $5, 'clinic', tstzrange(now() - interval '2 hours', now() - interval '100 minutes'), 'booked', 'staff') RETURNING id`,
        [owner.orgId, owner.branchId, doctor.id, service.id, patient.id]);
      pastId = r.rows[0].id;
    } finally {
      await c.end();
    }
    await o(t.http.post(`/v1/appointments/${pastId}/status`)).send({ status: 'no_show' }).expect(200);
    await o(t.http.post(`/v1/appointments/${pastId}/status`)).send({ status: 'checked_in' }).expect(409);

    // today's clinic visit: check in, consult, complete (skipped close to midnight when no slot is left today)
    const today = DateTime.now().setZone(TZ).toISODate()!;
    const weekday = DateTime.now().setZone(TZ).weekday - 1;
    await o(t.http.put(`/v1/doctors/${doctor.id}/schedule`)).send({ rules: [{ weekday, start: '00:00', end: '23:59', mode: 'clinic', branchId: owner.branchId }] }).expect(200);
    const todays = (await o(t.http.get(`/v1/availability?doctorId=${doctor.id}&serviceId=${service.id}&mode=clinic&from=${today}&days=1`))).body.days[0].slots;
    if (todays.length) {
      const v = (await o(t.http.post('/v1/appointments')).send({ doctorId: doctor.id, serviceId: service.id, mode: 'clinic', branchId: owner.branchId, start: todays[0].start, patientProfileId: patient.id }).expect(201)).body;
      for (const status of ['checked_in', 'in_consultation', 'completed']) {
        await o(t.http.post(`/v1/appointments/${v.id}/status`)).send({ status }).expect(200);
      }
      await o(t.http.post(`/v1/appointments/${v.id}/cancel`)).send({ reason: 'Too late' }).expect(409);
    }

    const audit = (await o(t.http.get('/v1/audit')).expect(200)).body.items.map((x: { action: string }) => x.action);
    expect(audit).toEqual(expect.arrayContaining(['appointment.book', 'appointment.reschedule', 'appointment.status', 'patient.create']));
  });

  it('shows appointments that clash with new leave', async () => {
    const { owner, o, doctor, service, patient } = await clinic();
    const mon = futureMonday();
    const a = (await o(t.http.post('/v1/appointments')).send({ doctorId: doctor.id, serviceId: service.id, mode: 'clinic', branchId: owner.branchId, start: ist(mon, '11:00'), patientProfileId: patient.id }).expect(201)).body;
    expect((await o(t.http.get('/v1/appointments/attention'))).body.items).toHaveLength(0);
    const leave = await o(t.http.post(`/v1/doctors/${doctor.id}/leave`)).send({ startsAt: ist(mon, '00:00'), endsAt: ist(mon, '23:59') }).expect(201);
    expect(leave.body.affectedAppointments).toBe(1);
    expect((await o(t.http.get('/v1/appointments/attention'))).body.items.map((x: { id: string }) => x.id)).toEqual([a.id]);
    // no new slots that day
    expect((await o(t.http.get(`/v1/availability?doctorId=${doctor.id}&serviceId=${service.id}&mode=clinic&from=${mon}&days=1`))).body.days[0].slots).toHaveLength(0);
  });

  it('limits branch staff and doctors to their own part of the clinic', async () => {
    const { owner, o, doctor, service, patient } = await clinic();
    const mon = futureMonday();
    const second = (await o(t.http.post('/v1/branches')).send({ name: 'Kankarbagh', addressLine: 'Main Road', city: 'Patna', state: 'Bihar' }).expect(201)).body;
    const other = (await o(t.http.post('/v1/doctors')).send({ displayName: 'Dr. Kavya Rao', slotMinutes: 20, bufferMinutes: 0 }).expect(201)).body;
    await o(t.http.put(`/v1/doctors/${other.id}/schedule`)).send({ rules: [{ weekday: 0, start: '10:00', end: '13:00', mode: 'clinic', branchId: second.id }] }).expect(200);
    const atMain = (await o(t.http.post('/v1/appointments')).send({ doctorId: doctor.id, serviceId: service.id, mode: 'clinic', branchId: owner.branchId, start: ist(mon, '10:00'), patientProfileId: patient.id }).expect(201)).body;
    const kPatient = (await o(t.http.post('/v1/patients')).send({ fullName: 'Kankarbagh Patient', phone: '9800000001', homeBranchId: second.id }).expect(201)).body;
    const atSecond = (await o(t.http.post('/v1/appointments')).send({ doctorId: other.id, serviceId: service.id, mode: 'clinic', branchId: second.id, start: ist(mon, '10:00'), patientProfileId: kPatient.id }).expect(201)).body;

    // receptionist at Kankarbagh
    const rec = await staff(t, owner, ROLE.receptionist, [second.id], 'Kankarbagh Reception');
    const r = as(rec.token, owner.orgId);
    const range = `from=${ist(mon, '00:00')}&to=${ist(mon, '23:59')}`;
    expect((await r(t.http.get(`/v1/appointments?${range}`)).expect(200)).body.items.map((x: { id: string }) => x.id)).toEqual([atSecond.id]);
    await r(t.http.get(`/v1/appointments/${atMain.id}`)).expect(404);
    await r(t.http.post(`/v1/appointments/${atMain.id}/cancel`)).send({ reason: 'Not mine' }).expect(404);
    await r(t.http.post('/v1/appointments')).send({ doctorId: doctor.id, serviceId: service.id, mode: 'clinic', branchId: owner.branchId, start: ist(mon, '10:40'), patientProfileId: kPatient.id }).expect(403);
    // patients registered by Kankarbagh staff belong to Kankarbagh
    const reg = (await r(t.http.post('/v1/patients')).send({ fullName: 'Walk In', phone: '9800000002' }).expect(201)).body;
    expect(reg.homeBranchId).toBe(second.id);
    const seen = (await r(t.http.get('/v1/patients')).expect(200)).body.items.map((x: { fullName: string }) => x.fullName).sort();
    // Ravi has no home branch (registered by the owner), so he is a clinic-wide patient; Main-branch-only patients stay hidden
    expect(seen).toEqual(['Kankarbagh Patient', 'Ravi Kumar', 'Walk In']);
    const mainOnly = (await o(t.http.post('/v1/patients')).send({ fullName: 'Main Branch Patient', phone: '9800000004', homeBranchId: owner.branchId }).expect(201)).body;
    await r(t.http.get(`/v1/patients/${mainOnly.id}`)).expect(404);

    // the doctor sees only their own appointments and patients
    const docUser = await staff(t, owner, ROLE.doctor, [], 'Dr. Kavya Rao');
    await o(t.http.patch(`/v1/doctors/${other.id}`)).send({ userId: docUser.userId }).expect(200);
    const d = as(docUser.token, owner.orgId);
    expect((await d(t.http.get(`/v1/appointments?${range}`)).expect(200)).body.items.map((x: { id: string }) => x.id)).toEqual([atSecond.id]);
    expect((await d(t.http.get('/v1/patients')).expect(200)).body.items.map((x: { id: string }) => x.id)).toEqual([kPatient.id]);
    await d(t.http.get(`/v1/patients/${patient.id}`)).expect(404);
    await d(t.http.post('/v1/patients')).send({ fullName: 'Nope', phone: '9800000003' }).expect(403);
  });
});
