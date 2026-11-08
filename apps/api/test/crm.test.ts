import { DateTime } from 'luxon';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ROLE, as, makeApp, ownerWithClinic, staff, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(() => { t = makeApp(); });
afterAll(() => t.close());

const TZ = 'Asia/Kolkata';
const inDays = (n: number) => DateTime.now().setZone(TZ).plus({ days: n }).toISODate()!;

/** Clinic whose doctor works every day 00:00–23:59, so "today" always has slots (except in the last minutes before midnight). */
async function clinic() {
  const owner = await ownerWithClinic(t, 'Lumen Hair & Skin');
  const o = as(owner.access, owner.orgId);
  const doctor = (await o(t.http.post('/v1/doctors')).send({ displayName: 'Dr. Arjun Mehta', slotMinutes: 20, bufferMinutes: 0 }).expect(201)).body;
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '00:00', end: '23:59', mode: 'clinic', branchId: owner.branchId }));
  await o(t.http.put(`/v1/doctors/${doctor.id}/schedule`)).send({ rules }).expect(200);
  const service = (await o(t.http.post('/v1/services')).send({ name: 'New consultation', durationMinutes: 20, feePaise: 50000 }).expect(201)).body;
  const slots = async (date: string) => (await o(t.http.get(`/v1/availability?doctorId=${doctor.id}&serviceId=${service.id}&mode=clinic&from=${date}&days=1`)).expect(200)).body.days[0].slots as { start: string }[];
  const book = (patientProfileId: string, start: string) => o(t.http.post('/v1/appointments')).send({ doctorId: doctor.id, serviceId: service.id, mode: 'clinic', branchId: owner.branchId, start, patientProfileId });
  return { owner, o, doctor, service, slots, book };
}

describe('patient pipeline', () => {
  it('takes an enquiry to booked and consulted, with a full timeline', async () => {
    const { o, slots, book } = await clinic();
    const lead = await o(t.http.post('/v1/leads')).send({
      displayName: 'Neha Kumari', phone: '9876500001', interest: 'Hair transplant cost', source: 'instagram', wantsVisitBy: inDays(3), ownerKind: 'ai', note: 'Asked on Instagram DM',
    }).expect(201);
    expect(lead.body).toMatchObject({ stage: 'enquiry', score: 35, phone: '+919876500001', patient: null });
    expect(lead.body.scoreBreakdown.map((b: { rule: string }) => b.rule)).toEqual(['named_service', 'visit_within_7_days']);
    // one open lead per number
    const dup = await o(t.http.post('/v1/leads')).send({ phone: '98765 00001', source: 'website' }).expect(409);
    expect(dup.body.error.details.leadId).toBe(lead.body.id);

    await o(t.http.post(`/v1/leads/${lead.body.id}/stage`)).send({ stage: 'qualified' }).expect(200);
    await o(t.http.post(`/v1/leads/${lead.body.id}/notes`)).send({ text: 'Wants Saturday morning' }).expect(201);
    const reg = await o(t.http.post(`/v1/leads/${lead.body.id}/patient`)).send({ fullName: 'Neha Kumari', phone: '9876500001' }).expect(201);
    expect(reg.body.patient).toMatchObject({ fullName: 'Neha Kumari', mrn: 'LHS-1001' });
    await o(t.http.post(`/v1/leads/${lead.body.id}/patient`)).send({ fullName: 'Neha K', phone: '9876500001' }).expect(409);

    // booking moves the lead to "booked" automatically
    const today = (await slots(DateTime.now().setZone(TZ).toISODate()!))[0];
    const start = today?.start ?? (await slots(inDays(1)))[0]!.start;
    const appt = (await book(reg.body.patient.profileId, start).expect(201)).body;
    const booked = await o(t.http.get(`/v1/leads/${lead.body.id}`)).expect(200);
    expect(booked.body).toMatchObject({ stage: 'booked', hasUpcomingAppointment: true, score: 60 });
    expect(booked.body.events.map((e: { kind: string; toStage: string | null; actor: string }) => `${e.kind}:${e.toStage ?? ''}:${e.actor}`)).toEqual([
      'stage_changed:booked:system', 'patient_linked::Clinic Owner', 'note::Clinic Owner', 'stage_changed:qualified:Clinic Owner', 'created:enquiry:Clinic Owner',
    ]);

    if (today) {
      for (const status of ['checked_in', 'in_consultation', 'completed']) await o(t.http.post(`/v1/appointments/${appt.id}/status`)).send({ status }).expect(200);
      expect((await o(t.http.get(`/v1/leads/${lead.body.id}`))).body.stage).toBe('consulted');
    }

    const timeline = (await o(t.http.get(`/v1/patients/${reg.body.patient.profileId}/timeline`)).expect(200)).body.items.map((i: { title: string }) => i.title);
    expect(timeline).toEqual(expect.arrayContaining(['Enquiry: Hair transplant cost', 'Note', 'Booked New consultation with Dr. Arjun Mehta', 'Pipeline: Qualified → Booked']));
    if (today) expect(timeline).toEqual(expect.arrayContaining(['Checked in', 'Visit completed', 'Pipeline: Booked → Consulted']));

    // lost needs a reason; the board hides closed leads after 30 days but shows them now
    await o(t.http.post(`/v1/leads/${lead.body.id}/stage`)).send({ stage: 'lost' }).expect(400);
    await o(t.http.post(`/v1/leads/${lead.body.id}/stage`)).send({ stage: 'lost', lostReason: 'Chose another clinic' }).expect(200);
    expect((await o(t.http.get('/v1/leads')).expect(200)).body.items[0]).toMatchObject({ stage: 'lost', lostReason: 'Chose another clinic' });
  });

  it('scores by the clinic’s own rules; only the owner changes them', async () => {
    const { owner, o } = await clinic();
    const lead = (await o(t.http.post('/v1/leads')).send({ displayName: 'Deepak Singh', interest: 'FUE', source: 'doctor_referral', ownerKind: 'unassigned' }).expect(201)).body;
    expect(lead.score).toBe(35);
    const rules = (await o(t.http.get('/v1/lead-scoring-rules')).expect(200)).body.items;
    const referred = rules.find((r: { key: string }) => r.key === 'referred');
    await o(t.http.patch(`/v1/lead-scoring-rules/${referred.id}`)).send({ points: 30 }).expect(200);
    expect((await o(t.http.get(`/v1/leads/${lead.id}`))).body.score).toBe(50);
    await o(t.http.patch(`/v1/lead-scoring-rules/${referred.id}`)).send({ isActive: false }).expect(200);
    expect((await o(t.http.get(`/v1/leads/${lead.id}`))).body.score).toBe(20);
    await o(t.http.post('/v1/lead-scoring-rules')).send({ key: 'ads', label: 'Came from Google Ads', points: 5, condition: { type: 'source_in', values: ['google_ads'] } }).expect(201);
    await o(t.http.post('/v1/lead-scoring-rules')).send({ key: 'bad', label: 'Bad rule', points: 5, condition: { type: 'sql', where: 'true' } }).expect(400);

    const rec = await staff(t, owner, ROLE.receptionist, [owner.branchId], 'Front Desk');
    await as(rec.token, owner.orgId)(t.http.patch(`/v1/lead-scoring-rules/${referred.id}`)).send({ points: 50 }).expect(403);
    expect((await as(rec.token, owner.orgId)(t.http.get('/v1/leads')).expect(200)).body.items).toHaveLength(1);
  });

  it('gives counsellors their own and unassigned leads, and the patients behind them', async () => {
    const { owner, o } = await clinic();
    const c1 = await staff(t, owner, ROLE.counsellor, [], 'Meera Counsellor');
    const c2 = await staff(t, owner, ROLE.counsellor, [], 'Other Counsellor');
    const mine = (await o(t.http.post('/v1/leads')).send({ displayName: 'Shalini Roy', phone: '9876500002', source: 'website', ownerKind: 'user', ownerUserId: c1.userId }).expect(201)).body;
    const open = (await o(t.http.post('/v1/leads')).send({ displayName: 'Visitor 4821', source: 'website', ownerKind: 'unassigned' }).expect(201)).body;
    const theirs = (await o(t.http.post('/v1/leads')).send({ displayName: 'Rahul Kumar', source: 'google_ads', ownerKind: 'user', ownerUserId: c2.userId }).expect(201)).body;
    const other = (await o(t.http.post('/v1/patients')).send({ fullName: 'Someone Else', phone: '9876500099' }).expect(201)).body;

    const c = as(c1.token, owner.orgId);
    expect((await c(t.http.get('/v1/leads')).expect(200)).body.items.map((l: { id: string }) => l.id).sort()).toEqual([mine.id, open.id].sort());
    await c(t.http.get(`/v1/leads/${theirs.id}`)).expect(404);
    await c(t.http.post(`/v1/leads/${theirs.id}/notes`)).send({ text: 'x' }).expect(404);
    // picking up the unassigned lead; cannot hand it to a colleague
    await c(t.http.patch(`/v1/leads/${open.id}`)).send({ ownerKind: 'user', ownerUserId: c1.userId }).expect(200);
    await c(t.http.patch(`/v1/leads/${open.id}`)).send({ ownerKind: 'user', ownerUserId: c2.userId }).expect(403);
    // registers their lead as a patient, then sees that patient and no one else
    const reg = (await c(t.http.post(`/v1/leads/${mine.id}/patient`)).send({ fullName: 'Shalini Roy', phone: '9876500002' }).expect(201)).body;
    await c(t.http.get(`/v1/patients/${reg.patient.profileId}`)).expect(200);
    await c(t.http.get(`/v1/patients/${other.id}`)).expect(404);
    await c(t.http.post('/v1/patients')).send({ fullName: 'Direct', phone: '9876500098' }).expect(403);
    // a lead the counsellor creates is theirs
    const created = (await c(t.http.post('/v1/leads')).send({ displayName: 'Walk In', source: 'walk_in', ownerKind: 'unassigned' }).expect(201)).body;
    expect(created).toMatchObject({ ownerKind: 'user', ownerUserId: c1.userId });
  });
});

describe('tasks and consents', () => {
  it('routes tasks to a person or a role and closes them once', async () => {
    const { owner, o } = await clinic();
    const rec = await staff(t, owner, ROLE.receptionist, [owner.branchId], 'Front Desk');
    const doc = await staff(t, owner, ROLE.doctor, [], 'Dr. Doc');
    const lead = (await o(t.http.post('/v1/leads')).send({ displayName: 'Karan Gupta', source: 'google_ads' }).expect(201)).body;
    const due = DateTime.now().minus({ hours: 1 }).toISO()!;
    const toPerson = (await o(t.http.post('/v1/tasks')).send({ kind: 'callback', title: 'Call back about EMI options', assigneeUserId: rec.userId, dueAt: due, relatedType: 'lead', relatedId: lead.id, priority: 'high' }).expect(201)).body;
    expect(toPerson).toMatchObject({ overdue: true, related: { type: 'lead', label: 'Karan Gupta' }, assignee: { kind: 'user', name: 'Front Desk' } });
    const toRole = (await o(t.http.post('/v1/tasks')).send({ title: 'Confirm tomorrow’s video consults', assigneeRole: 'receptionist' }).expect(201)).body;
    await o(t.http.post('/v1/tasks')).send({ title: 'Nobody', assigneeRole: 'astronaut' }).expect(400);
    await o(t.http.post('/v1/tasks')).send({ title: 'Both', assigneeRole: 'receptionist', assigneeUserId: rec.userId }).expect(400);

    const r = as(rec.token, owner.orgId);
    expect((await r(t.http.get('/v1/tasks?mine=1')).expect(200)).body.items.map((x: { id: string }) => x.id).sort()).toEqual([toPerson.id, toRole.id].sort());
    expect((await as(doc.token, owner.orgId)(t.http.get('/v1/tasks')).expect(200)).body.items).toHaveLength(0);
    await as(doc.token, owner.orgId)(t.http.patch(`/v1/tasks/${toPerson.id}`)).send({ status: 'done' }).expect(404);
    const done = await r(t.http.patch(`/v1/tasks/${toPerson.id}`)).send({ status: 'done' }).expect(200);
    expect(done.body).toMatchObject({ status: 'done', overdue: false });
    await r(t.http.patch(`/v1/tasks/${toPerson.id}`)).send({ status: 'open' }).expect(409);
    // the lead's history shows the task
    expect((await o(t.http.get(`/v1/leads/${lead.id}`))).body.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['task_created', 'task_done']));
    expect((await o(t.http.get('/v1/tasks')).expect(200)).body.items.map((x: { id: string }) => x.id)).toEqual([toRole.id]); // closed tasks drop off the open list
  });

  it('keeps consent as an append-only record', async () => {
    const { owner, o } = await clinic();
    const p = (await o(t.http.post('/v1/patients')).send({ fullName: 'Sunita Devi', phone: '9876500003' }).expect(201)).body;
    await o(t.http.post(`/v1/patients/${p.id}/consents`)).send({ purpose: 'whatsapp_updates', state: 'given' }).expect(201);
    await o(t.http.post(`/v1/patients/${p.id}/consents`)).send({ purpose: 'marketing', state: 'given' }).expect(201);
    await o(t.http.post(`/v1/patients/${p.id}/consents`)).send({ purpose: 'marketing', state: 'withdrawn' }).expect(201);
    await o(t.http.post(`/v1/patients/${p.id}/consents`)).send({ purpose: 'call_recording_notice', state: 'given' }).expect(400);
    const c = (await o(t.http.get(`/v1/patients/${p.id}/consents`)).expect(200)).body;
    expect(c.current.whatsapp_updates.state).toBe('given');
    expect(c.current.marketing).toMatchObject({ state: 'withdrawn', recordedBy: 'Clinic Owner', capturedVia: 'in_clinic' });
    expect(c.history).toHaveLength(3);

    // the API's database login cannot rewrite or delete consent history
    const db = new pg.Client({ connectionString: inject('apiDatabaseUrl') });
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.org_id', $1, true)`, [owner.orgId]);
      await expect(db.query(`UPDATE app.consents SET state = 'given'`)).rejects.toThrow(/permission denied/);
      await db.query('ROLLBACK');
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.org_id', $1, true)`, [owner.orgId]);
      await expect(db.query(`DELETE FROM app.consents`)).rejects.toThrow(/permission denied/);
      await db.query('ROLLBACK');
    } finally {
      await db.end();
    }
  });
});

describe('waiting room', () => {
  it('issues tokens at check-in and follows the visit', async () => {
    const { owner, o, slots, book } = await clinic();
    const today = DateTime.now().setZone(TZ).toISODate()!;
    const free = await slots(today);
    if (free.length < 2) return; // the last minutes before midnight: nothing left to book today
    const p1 = (await o(t.http.post('/v1/patients')).send({ fullName: 'Vikram Prasad', phone: '9876500004' }).expect(201)).body;
    const p2 = (await o(t.http.post('/v1/patients')).send({ fullName: 'Sneha Jha', phone: '9876500005' }).expect(201)).body;
    const a1 = (await book(p1.id, free[0]!.start).expect(201)).body;
    const a2 = (await book(p2.id, free[1]!.start).expect(201)).body;
    await o(t.http.post(`/v1/appointments/${a1.id}/status`)).send({ status: 'checked_in' }).expect(200);
    await o(t.http.post(`/v1/appointments/${a2.id}/status`)).send({ status: 'checked_in' }).expect(200);
    expect((await o(t.http.get(`/v1/appointments/${a2.id}`))).body.queueToken).toBe('M-02');

    let q = (await o(t.http.get('/v1/queue')).expect(200)).body;
    expect(q.items.map((x: { token: string; status: string }) => `${x.token}:${x.status}`)).toEqual(['M-01:waiting', 'M-02:waiting']);
    // Sneha goes first
    await o(t.http.post('/v1/queue/reorder')).send({ doctorId: a1.doctorId, tokenIds: [q.items[1].id, q.items[0].id] }).expect(200);
    await o(t.http.post(`/v1/queue/${q.items[1].id}/call`)).expect(200);
    await o(t.http.post(`/v1/queue/${q.items[1].id}/call`)).expect(409);
    await o(t.http.post(`/v1/appointments/${a2.id}/status`)).send({ status: 'in_consultation' }).expect(200);
    q = (await o(t.http.get('/v1/queue')).expect(200)).body;
    expect(q.items.map((x: { token: string; status: string }) => `${x.token}:${x.status}`)).toEqual(['M-02:in_room', 'M-01:waiting']);
    await o(t.http.post(`/v1/appointments/${a2.id}/status`)).send({ status: 'completed' }).expect(200);
    await o(t.http.post(`/v1/queue/${q.items[1].id}/left`)).expect(200);
    q = (await o(t.http.get('/v1/queue')).expect(200)).body;
    expect(q.items.map((x: { status: string }) => x.status)).toEqual(['done', 'left']);

    // staff of another branch cannot see or change this queue
    const second = (await o(t.http.post('/v1/branches')).send({ name: 'Kankarbagh', addressLine: 'Main Road', city: 'Patna', state: 'Bihar' }).expect(201)).body;
    const rec = await staff(t, owner, ROLE.receptionist, [second.id], 'Kankarbagh Desk');
    const r = as(rec.token, owner.orgId);
    await r(t.http.get(`/v1/queue?branchId=${owner.branchId}`)).expect(403);
    expect((await r(t.http.get('/v1/queue')).expect(200)).body).toMatchObject({ branchId: second.id, items: [] });
    await r(t.http.post(`/v1/queue/${q.items[0].id}/left`)).expect(403);
  });

  it('never double-books under mixed overlapping load', async () => {
    const { owner, o, doctor } = await clinic();
    const long = (await o(t.http.post('/v1/services')).send({ name: 'PRP session', durationMinutes: 60, feePaise: 450000 }).expect(201)).body;
    const short = (await o(t.http.get('/v1/services')).expect(200)).body.items.find((s: { name: string }) => s.name === 'New consultation');
    const date = inDays(10);
    const p = (await o(t.http.post('/v1/patients')).send({ fullName: 'Load Test', phone: '9876500006' }).expect(201)).body;
    // 50 requests over 10:00–12:00 with 20- and 60-minute services, many overlapping each other
    const reqs = Array.from({ length: 50 }, (_, i) => {
      const start = DateTime.fromISO(`${date}T10:00`, { zone: TZ }).plus({ minutes: 20 * (i % 6) }).toUTC().toISO()!;
      return o(t.http.post('/v1/appointments')).send({ doctorId: doctor.id, serviceId: i % 2 ? long.id : short.id, mode: 'clinic', branchId: owner.branchId, start, patientProfileId: p.id });
    });
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    const db = new pg.Client({ connectionString: inject('ownerDatabaseUrl') });
    await db.connect();
    try {
      const overlaps = await db.query(
        `SELECT count(*)::int AS n FROM app.appointments a JOIN app.appointments b ON a.doctor_id = b.doctor_id AND a.id < b.id AND a.slot && b.slot
          WHERE a.doctor_id = $1 AND a.status = 'booked' AND b.status = 'booked'`, [doctor.id]);
      expect(overlaps.rows[0].n).toBe(0);
      const booked = await db.query(`SELECT count(*)::int AS n FROM app.appointments WHERE doctor_id = $1`, [doctor.id]);
      expect(booked.rows[0].n).toBe(results.filter((r) => r.status === 201).length);
    } finally {
      await db.end();
    }
  });
});
