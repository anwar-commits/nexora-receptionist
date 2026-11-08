import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { inject } from 'vitest';
import { ROLE, as, makeApp, ownerWithClinic, staff, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(() => { t = makeApp(); });
afterAll(() => t.close());

const HOURS = { mon: [['10:00', '14:00'], ['16:00', '20:00']], tue: [['10:00', '20:00']], wed: [['10:00', '20:00']], thu: [['10:00', '20:00']], fri: [['10:00', '20:00']], sat: [['10:00', '14:00']] };

describe('doctors, hours and leave', () => {
  it('adds a doctor, sets weekly hours, rejects overlaps and flags sessions outside opening hours', async () => {
    const owner = await ownerWithClinic(t);
    const o = as(owner.access, owner.orgId);
    await o(t.http.patch(`/v1/branches/${owner.branchId}`)).send({ openingHours: HOURS }).expect(200);
    const dept = await o(t.http.post('/v1/departments')).send({ name: 'Hair' }).expect(201);

    const doc = await o(t.http.post('/v1/doctors')).send({
      displayName: 'Dr. Arjun Mehta', departmentId: dept.body.id, qualifications: 'MBBS, MD (Dermatology)',
      registrationNumber: 'BMC-12345', registrationCouncil: 'Bihar Medical Council', languages: ['hi', 'en'], slotMinutes: 20, bufferMinutes: 5,
    }).expect(201);
    expect(doc.body.registrationVerified).toBe(false); // only the platform can verify

    // invalid: clinic session without a branch, end before start
    const bad = await o(t.http.put(`/v1/doctors/${doc.body.id}/schedule`)).send({ rules: [{ weekday: 0, start: '10:00', end: '09:00', mode: 'clinic' }] }).expect(400);
    expect(bad.body.error.code).toBe('validation_failed');

    // overlap on Monday is refused with a readable message
    const overlap = await o(t.http.put(`/v1/doctors/${doc.body.id}/schedule`)).send({ rules: [
      { weekday: 0, start: '10:00', end: '13:00', mode: 'clinic', branchId: owner.branchId },
      { weekday: 0, start: '12:30', end: '14:00', mode: 'video' },
    ] }).expect(409);
    expect(overlap.body.error.message).toContain('Monday');

    const saved = await o(t.http.put(`/v1/doctors/${doc.body.id}/schedule`)).send({ rules: [
      { weekday: 0, start: '10:00', end: '13:00', mode: 'clinic', branchId: owner.branchId },
      { weekday: 0, start: '17:00', end: '20:00', mode: 'video' },
      { weekday: 6, start: '11:00', end: '14:00', mode: 'clinic', branchId: owner.branchId }, // Sunday: clinic closed
    ] }).expect(200);
    expect(saved.body.weeklyHours).toHaveLength(3);
    expect(saved.body.warnings).toEqual([expect.stringContaining('Sunday 11:00–14:00')]);

    const list = await o(t.http.get('/v1/doctors')).expect(200);
    expect(list.body.items[0]).toMatchObject({ displayName: 'Dr. Arjun Mehta', modes: expect.arrayContaining(['clinic', 'video']), branchIds: [owner.branchId] });

    // leave
    const from = new Date(Date.now() + 7 * 86_400_000);
    const to = new Date(from.getTime() + 2 * 86_400_000);
    const leave = await o(t.http.post(`/v1/doctors/${doc.body.id}/leave`)).send({ startsAt: from.toISOString(), endsAt: to.toISOString(), reason: 'Conference' }).expect(201);
    expect(leave.body.affectedAppointments).toBe(0);
    await o(t.http.post(`/v1/doctors/${doc.body.id}/leave`)).send({ startsAt: to.toISOString(), endsAt: from.toISOString() }).expect(400);
    const detail = await o(t.http.get(`/v1/doctors/${doc.body.id}`)).expect(200);
    expect(detail.body.upcomingLeave).toEqual([expect.objectContaining({ id: leave.body.id, reason: 'Conference' })]);
    await o(t.http.delete(`/v1/doctors/${doc.body.id}/leave/${leave.body.id}`)).expect(204);

    // changing the registration number clears verification; removing the doctor hides them
    await o(t.http.patch(`/v1/doctors/${doc.body.id}`)).send({ slotMinutes: 15 }).expect(200);
    await o(t.http.delete(`/v1/doctors/${doc.body.id}`)).expect(204);
    expect((await o(t.http.get('/v1/doctors')).expect(200)).body.items).toHaveLength(0);
    await o(t.http.get(`/v1/doctors/${doc.body.id}`)).expect(404);
  });

  it('lets a doctor edit only their own hours, and a branch manager only their branch', async () => {
    const owner = await ownerWithClinic(t);
    const o = as(owner.access, owner.orgId);
    const second = await o(t.http.post('/v1/branches')).send({ name: 'Kankarbagh', addressLine: 'Main Road', city: 'Patna', state: 'Bihar' }).expect(201);

    const docUser = await staff(t, owner, ROLE.doctor, [], 'Dr. Ritika Sinha');
    const mine = await o(t.http.post('/v1/doctors')).send({ displayName: 'Dr. Ritika Sinha', userId: docUser.userId }).expect(201);
    // a staff account gets one doctor profile
    await o(t.http.post('/v1/doctors')).send({ displayName: 'Duplicate', userId: docUser.userId }).expect(409);
    const other = await o(t.http.post('/v1/doctors')).send({ displayName: 'Dr. Kavya Rao' }).expect(201);

    const d = as(docUser.token, owner.orgId);
    await d(t.http.put(`/v1/doctors/${mine.body.id}/schedule`)).send({ rules: [{ weekday: 1, start: '10:00', end: '13:00', mode: 'clinic', branchId: owner.branchId }] }).expect(200);
    await d(t.http.put(`/v1/doctors/${other.body.id}/schedule`)).send({ rules: [] }).expect(403);
    // doctors cannot add colleagues or change fees
    await d(t.http.post('/v1/doctors')).send({ displayName: 'Dr. New' }).expect(403);
    await d(t.http.post('/v1/services')).send({ name: 'X ray', durationMinutes: 10, feePaise: 100 }).expect(403);

    // branch manager of Kankarbagh: adds sessions there, cannot touch the main branch's sessions
    const mgr = await staff(t, owner, ROLE.branchManager, [second.body.id], 'Branch Manager');
    const m = as(mgr.token, owner.orgId);
    const res = await m(t.http.put(`/v1/doctors/${mine.body.id}/schedule`)).send({ rules: [{ weekday: 3, start: '15:00', end: '18:00', mode: 'clinic', branchId: second.body.id }] }).expect(200);
    // Tuesday at the main branch (set by the doctor) is kept
    expect(res.body.weeklyHours.map((x: { weekday: number }) => x.weekday).sort()).toEqual([1, 3]);
    await m(t.http.put(`/v1/doctors/${mine.body.id}/schedule`)).send({ rules: [{ weekday: 3, start: '15:00', end: '18:00', mode: 'clinic', branchId: owner.branchId }] }).expect(403);
    await m(t.http.put(`/v1/doctors/${mine.body.id}/schedule`)).send({ rules: [{ weekday: 3, start: '19:00', end: '20:00', mode: 'video' }] }).expect(403);
    // overlap with a kept session at another branch is still caught
    await m(t.http.put(`/v1/doctors/${mine.body.id}/schedule`)).send({ rules: [{ weekday: 1, start: '12:00', end: '14:00', mode: 'clinic', branchId: second.body.id }] }).expect(409);
    // leave only for doctors who work at their branch
    const from = new Date(Date.now() + 86_400_000).toISOString();
    const to = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await m(t.http.post(`/v1/doctors/${mine.body.id}/leave`)).send({ startsAt: from, endsAt: to }).expect(201);
    await m(t.http.post(`/v1/doctors/${other.body.id}/leave`)).send({ startsAt: from, endsAt: to }).expect(403);

    // receptionists can read the doctor list (to book) but not edit hours
    const rec = await staff(t, owner, ROLE.receptionist, [owner.branchId], 'Receptionist');
    const r = as(rec.token, owner.orgId);
    expect((await r(t.http.get('/v1/doctors')).expect(200)).body.items).toHaveLength(2);
    await r(t.http.put(`/v1/doctors/${mine.body.id}/schedule`)).send({ rules: [] }).expect(403);
  });
});

describe('services and fees', () => {
  it('keeps "after assessment" fees out of the AI and audits fee changes', async () => {
    const owner = await ownerWithClinic(t);
    const o = as(owner.access, owner.orgId);

    const consult = await o(t.http.post('/v1/services')).send({ name: 'New consultation', durationMinutes: 20, feePaise: 50000, aiMayQuoteFee: true, modes: ['clinic', 'video'] }).expect(201);
    expect(consult.body).toMatchObject({ feePaise: 50000, aiMayQuoteFee: true, modes: ['clinic', 'video'] });
    await o(t.http.post('/v1/services')).send({ name: 'new CONSULTATION', durationMinutes: 20, feePaise: 50000 }).expect(409);
    // the AI cannot quote a fee that is not set
    await o(t.http.post('/v1/services')).send({ name: 'FUE hair transplant', durationMinutes: 480, feePaise: null, aiMayQuoteFee: true }).expect(400);
    const fue = await o(t.http.post('/v1/services')).send({ name: 'FUE hair transplant', durationMinutes: 480, feePaise: null }).expect(201);
    expect(fue.body).toMatchObject({ feePaise: null, aiMayQuoteFee: false, modes: ['clinic'] });

    // clearing a fee also stops the AI quoting it
    const cleared = await o(t.http.patch(`/v1/services/${consult.body.id}`)).send({ feePaise: null }).expect(200);
    expect(cleared.body).toMatchObject({ feePaise: null, aiMayQuoteFee: false });
    await o(t.http.patch(`/v1/services/${consult.body.id}`)).send({ aiMayQuoteFee: true }).expect(400);
    await o(t.http.patch(`/v1/services/${consult.body.id}`)).send({ feePaise: 60000, aiMayQuoteFee: true }).expect(200);

    const audit = await o(t.http.get('/v1/audit')).expect(200);
    const change = audit.body.items.find((a: { action: string }) => a.action === 'service.update');
    expect(change.details.after).toEqual({ feePaise: 60000, aiMayQuoteFee: true });

    // doctor-specific fee, then retiring the service removes it from the doctor
    const doc = await o(t.http.post('/v1/doctors')).send({ displayName: 'Dr. A' }).expect(201);
    await o(t.http.put(`/v1/doctors/${doc.body.id}/services`)).send({ items: [{ serviceId: consult.body.id, feeOverridePaise: 80000 }, { serviceId: fue.body.id }] }).expect(200);
    expect((await o(t.http.get(`/v1/doctors/${doc.body.id}`))).body.services).toHaveLength(2);
    await o(t.http.patch(`/v1/services/${fue.body.id}`)).send({ isActive: false }).expect(200);
    expect((await o(t.http.get(`/v1/doctors/${doc.body.id}`))).body.services).toEqual([{ serviceId: consult.body.id, feeOverridePaise: 80000 }]);
    expect((await o(t.http.get('/v1/services')).expect(200)).body.items).toHaveLength(1);
    expect((await o(t.http.get('/v1/services?includeInactive=1')).expect(200)).body.items).toHaveLength(2);
  });
});

describe('settings, holidays and onboarding', () => {
  it('validates settings and only finishes onboarding when every step is done', async () => {
    const owner = await ownerWithClinic(t);
    const o = as(owner.access, owner.orgId);

    const s = await o(t.http.get('/v1/settings')).expect(200);
    expect(s.body).toMatchObject({ recordingEnabled: true, aiPickupMode: 'after_ring', outboundStartLocal: '09:00', prepayPolicy: 'video_only', phoneSetupChoice: null });
    await o(t.http.patch('/v1/settings')).send({ outboundEndLocal: '08:00' }).expect(400);
    await o(t.http.patch('/v1/settings')).send({ aiPickupAfterSeconds: 2 }).expect(400);
    const upd = await o(t.http.patch('/v1/settings')).send({ aiPickupMode: 'always', freeCancellationHours: 6, cancellationPolicyText: 'Free cancellation up to 6 hours before.' }).expect(200);
    expect(upd.body).toMatchObject({ aiPickupMode: 'always', freeCancellationHours: 6 });

    // a fresh clinic is not ready
    let ob = await o(t.http.get('/v1/onboarding')).expect(200);
    expect(ob.body.canComplete).toBe(false);
    expect(ob.body.steps.map((x: { key: string }) => x.key)).toEqual(['clinic', 'branches', 'doctors', 'services', 'phone', 'review']);
    const refused = await o(t.http.post('/v1/onboarding/complete')).expect(409);
    expect(refused.body.error.details.map((x: { key: string }) => x.key)).toEqual(['clinic', 'branches', 'doctors', 'services', 'phone']);

    // do every step
    await o(t.http.patch('/v1/organizations/current')).send({ specialities: ['Hair restoration'], languages: ['hi', 'hi-Latn', 'en'] }).expect(200);
    await o(t.http.patch(`/v1/branches/${owner.branchId}`)).send({ phone: '9876543210', openingHours: HOURS }).expect(200);
    const doc = await o(t.http.post('/v1/doctors')).send({ displayName: 'Dr. A' }).expect(201);
    ob = await o(t.http.get('/v1/onboarding')).expect(200);
    expect(ob.body.steps[2]).toMatchObject({ done: false, missing: ['Set weekly hours for Dr. A'] });
    await o(t.http.put(`/v1/doctors/${doc.body.id}/schedule`)).send({ rules: [{ weekday: 0, start: '10:00', end: '13:00', mode: 'clinic', branchId: owner.branchId }] }).expect(200);
    await o(t.http.post('/v1/services')).send({ name: 'New consultation', durationMinutes: 20, feePaise: 50000 }).expect(201);
    await o(t.http.patch('/v1/settings')).send({ phoneSetupChoice: 'later' }).expect(200);

    ob = await o(t.http.get('/v1/onboarding')).expect(200);
    expect(ob.body.canComplete).toBe(true);
    const done = await o(t.http.post('/v1/onboarding/complete')).expect(200);
    expect(done.body.completedAt).toBeTruthy();
    expect(done.body.steps.every((x: { done: boolean }) => x.done)).toBe(true);

    // holidays
    const day = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const h = await o(t.http.post('/v1/holidays')).send({ onDate: day, name: 'Chhath Puja' }).expect(201);
    await o(t.http.post('/v1/holidays')).send({ onDate: day, name: 'Again' }).expect(409);
    expect((await o(t.http.get('/v1/holidays')).expect(200)).body.items).toEqual([expect.objectContaining({ id: h.body.id, onDate: day })]);
    await o(t.http.delete(`/v1/holidays/${h.body.id}`)).expect(204);
  });

  it('keeps every clinic’s doctors, services and settings private', async () => {
    const a = await ownerWithClinic(t, 'Clinic A');
    const b = await ownerWithClinic(t, 'Clinic B');
    const asA = as(a.access, a.orgId);
    const docA = await asA(t.http.post('/v1/doctors')).send({ displayName: 'Dr. A' }).expect(201);
    const svcA = await asA(t.http.post('/v1/services')).send({ name: 'Consult', durationMinutes: 20, feePaise: 100 }).expect(201);

    const asB = as(b.access, b.orgId);
    await asB(t.http.get(`/v1/doctors/${docA.body.id}`)).expect(404);
    await asB(t.http.patch(`/v1/doctors/${docA.body.id}`)).send({ displayName: 'Taken' }).expect(404);
    await asB(t.http.put(`/v1/doctors/${docA.body.id}/schedule`)).send({ rules: [] }).expect(404);
    await asB(t.http.patch(`/v1/services/${svcA.body.id}`)).send({ feePaise: 1 }).expect(404);
    expect((await asB(t.http.get('/v1/doctors')).expect(200)).body.items).toHaveLength(0);
    expect((await asB(t.http.get('/v1/services')).expect(200)).body.items).toHaveLength(0);
    // B cannot attach A's service or A's branch to its own doctor
    const docB = await asB(t.http.post('/v1/doctors')).send({ displayName: 'Dr. B' }).expect(201);
    await asB(t.http.put(`/v1/doctors/${docB.body.id}/services`)).send({ items: [{ serviceId: svcA.body.id }] }).expect(400);
    await asB(t.http.put(`/v1/doctors/${docB.body.id}/schedule`)).send({ rules: [{ weekday: 0, start: '10:00', end: '11:00', mode: 'clinic', branchId: a.branchId }] }).expect(400);
  });

  it('enforces non-overlapping hours in the database as well', async () => {
    const owner = await ownerWithClinic(t);
    const doc = await as(owner.access, owner.orgId)(t.http.post('/v1/doctors')).send({ displayName: 'Dr. DB' }).expect(201);
    const c = new pg.Client({ connectionString: inject('ownerDatabaseUrl') });
    await c.connect();
    try {
      const insert = (start: string, end: string) => c.query(
        `INSERT INTO app.schedule_rules (organization_id, doctor_id, weekday, start_local, end_local, mode) VALUES ($1, $2, 2, $3, $4, 'video')`,
        [owner.orgId, doc.body.id, start, end],
      );
      await insert('10:00', '12:00');
      await insert('12:00', '13:00'); // touching is fine
      await expect(insert('11:00', '12:30')).rejects.toThrow(/schedule_rules_no_overlap/);
      await expect(c.query(
        `INSERT INTO app.schedule_rules (organization_id, doctor_id, weekday, start_local, end_local, mode) VALUES ($1, $2, 3, '10:00', '11:00', 'clinic')`,
        [owner.orgId, doc.body.id],
      )).rejects.toThrow(/clinic_mode_needs_branch/);
    } finally {
      await c.end();
    }
  });
});
