import { createHmac } from 'node:crypto';
import { DateTime } from 'luxon';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { sandboxOutbox } from '../src/lib/messaging.js';
import { ROLE, as, makeApp, ownerWithClinic, staff, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(() => { t = makeApp(); });
afterAll(() => t.close());

const key = () => `test-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const ownerDb = async <T>(fn: (c: pg.Client) => Promise<T>) => {
  const c = new pg.Client({ connectionString: inject('ownerDatabaseUrl') });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
};

async function clinic(name = 'Lumen Hair & Skin') {
  const owner = await ownerWithClinic(t, name);
  const o = as(owner.access, owner.orgId);
  const doctor = (await o(t.http.post('/v1/doctors')).send({ displayName: 'Dr. Arjun Mehta', slotMinutes: 20, bufferMinutes: 0 }).expect(201)).body;
  const service = (await o(t.http.post('/v1/services')).send({ name: 'New consultation', durationMinutes: 20, feePaise: 50000, modes: ['clinic', 'video'] }).expect(201)).body;
  const patient = (await o(t.http.post('/v1/patients')).send({ fullName: 'Ravi Kumar', phone: '9812345670', homeBranchId: owner.branchId }).expect(201)).body;
  return { owner, o, doctor, service, patient };
}

describe('front desk', () => {
  it('takes walk-ins, collects fees with receipts and closes the day', async () => {
    const { owner, o, doctor, service, patient } = await clinic();
    const walk = (await o(t.http.post('/v1/queue/walk-in')).send({ patientProfileId: patient.id, doctorId: doctor.id, serviceId: service.id }).expect(201)).body;
    expect(walk.token).toBe('M-01');
    const due = (await o(t.http.get('/v1/payments/due')).expect(200)).body;
    expect(due.items).toEqual([expect.objectContaining({ kind: 'walk_in', id: walk.id, feePaise: 50000, duePaise: 50000, token: 'M-01' })]);

    const base = { patientProfileId: patient.id, queueTokenId: walk.id };
    await o(t.http.post('/v1/payments')).send({ ...base, amountPaise: 20000, method: 'upi', idempotencyKey: key() }).expect(400); // UPI needs its reference
    const k1 = key();
    const p1 = (await o(t.http.post('/v1/payments')).send({ ...base, amountPaise: 30000, method: 'cash', idempotencyKey: k1 }).expect(201)).body;
    expect(p1).toMatchObject({ receiptNumber: 'LHS-R-00001', amountPaise: 30000, status: 'captured', collectedBy: 'Clinic Owner' });
    expect((await o(t.http.post('/v1/payments')).send({ ...base, amountPaise: 30000, method: 'cash', idempotencyKey: k1 }).expect(200)).body.id).toBe(p1.id); // retried tap
    const over = await o(t.http.post('/v1/payments')).send({ ...base, amountPaise: 30000, method: 'cash', idempotencyKey: key() }).expect(409);
    expect(over.body.error.message).toContain('₹200');
    const p2 = (await o(t.http.post('/v1/payments')).send({ ...base, amountPaise: 20000, method: 'upi', reference: 'UPI 4411 2233', idempotencyKey: key() }).expect(201)).body;
    expect(p2.receiptNumber).toBe('LHS-R-00002');
    expect((await o(t.http.get('/v1/payments/due'))).body.items[0].duePaise).toBe(0);
    await o(t.http.post('/v1/payments')).send({ ...base, amountPaise: 100, method: 'cash', idempotencyKey: key() }).expect(409);

    // two desks collecting the same fee at the same moment: only one succeeds
    const walk2 = (await o(t.http.post('/v1/queue/walk-in')).send({ patientProfileId: patient.id, doctorId: doctor.id, serviceId: service.id }).expect(201)).body;
    const both = await Promise.all([1, 2].map(() => o(t.http.post('/v1/payments')).send({ patientProfileId: patient.id, queueTokenId: walk2.id, amountPaise: 50000, method: 'cash', idempotencyKey: key() })));
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);

    // the walk-in moves through the room without an appointment
    await o(t.http.post(`/v1/queue/${walk.id}/in-room`)).expect(200);
    await o(t.http.post(`/v1/queue/${walk.id}/in-room`)).expect(409);
    await o(t.http.post(`/v1/queue/${walk.id}/done`)).expect(200);

    // refunds: within the receptionist's limit, above it only the owner
    const rec = await staff(t, owner, ROLE.receptionist, [owner.branchId], 'Front Desk');
    const r = as(rec.token, owner.orgId);
    await o(t.http.patch('/v1/settings')).send({ refundLimitReceptionistPaise: 10000 }).expect(200);
    await r(t.http.post(`/v1/payments/${p1.id}/refund`)).send({ amountPaise: 20000, reason: 'Charged twice' }).expect(403);
    const partial = (await r(t.http.post(`/v1/payments/${p1.id}/refund`)).send({ amountPaise: 10000, reason: 'Discount approved by doctor' }).expect(200)).body;
    expect(partial).toMatchObject({ status: 'partially_refunded', refundedPaise: 10000 });
    await o(t.http.post(`/v1/payments/${p1.id}/refund`)).send({ amountPaise: 30000, reason: 'Too much' }).expect(409);
    expect((await o(t.http.post(`/v1/payments/${p1.id}/refund`)).send({ amountPaise: 20000, reason: 'Visit cancelled' }).expect(200)).body.status).toBe('refunded');

    const day = (await r(t.http.get('/v1/payments')).expect(200)).body;
    expect(day.totals).toMatchObject({ collectedPaise: 100000, refundedPaise: 30000, netPaise: 70000 });
    expect(day.totals.byMethod.cash).toEqual({ collectedPaise: 80000, refundedPaise: 30000, count: 2 });
    expect(day.totals.byMethod.upi).toEqual({ collectedPaise: 20000, refundedPaise: 0, count: 1 });
    const receipt = (await r(t.http.get(`/v1/payments/${p2.id}/receipt`)).expect(200)).body;
    expect(receipt).toMatchObject({ receiptNumber: 'LHS-R-00002', clinic: { name: 'Lumen Hair & Skin' }, patientPhone: '+919812345670', reference: 'UPI 4411 2233' });

    // another branch's desk cannot see or refund this branch's money
    const second = (await o(t.http.post('/v1/branches')).send({ name: 'Kankarbagh', addressLine: 'Main Road', city: 'Patna', state: 'Bihar' }).expect(201)).body;
    const other = as((await staff(t, owner, ROLE.receptionist, [second.id], 'Kankarbagh Desk')).token, owner.orgId);
    await other(t.http.get(`/v1/payments?branchId=${owner.branchId}`)).expect(403);
    expect((await other(t.http.get('/v1/payments')).expect(200)).body.items).toHaveLength(0);
    await other(t.http.post(`/v1/payments/${p2.id}/refund`)).send({ amountPaise: 100, reason: 'Not mine' }).expect(404);

    // money records cannot be deleted by the application
    const api = new pg.Client({ connectionString: inject('apiDatabaseUrl') });
    await api.connect();
    try {
      await api.query('BEGIN');
      await api.query(`SELECT set_config('app.org_id', $1, true)`, [owner.orgId]);
      await expect(api.query('DELETE FROM app.payments')).rejects.toThrow(/permission denied/);
      await api.query('ROLLBACK');
    } finally {
      await api.end();
    }
  });

  it('collects an appointment fee only up to what is due', async () => {
    const { owner, o, doctor, service, patient } = await clinic();
    await o(t.http.put(`/v1/doctors/${doctor.id}/schedule`)).send({ rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '10:00', end: '13:00', mode: 'clinic', branchId: owner.branchId })) }).expect(200);
    const date = DateTime.now().setZone('Asia/Kolkata').plus({ days: 3 }).toISODate()!;
    const slot = (await o(t.http.get(`/v1/availability?doctorId=${doctor.id}&serviceId=${service.id}&mode=clinic&from=${date}&days=1`))).body.days[0].slots[0];
    const appt = (await o(t.http.post('/v1/appointments')).send({ doctorId: doctor.id, serviceId: service.id, mode: 'clinic', branchId: owner.branchId, start: slot.start, patientProfileId: patient.id }).expect(201)).body;
    const other = (await o(t.http.post('/v1/patients')).send({ fullName: 'Someone Else', phone: '9800000001' }).expect(201)).body;
    await o(t.http.post('/v1/payments')).send({ patientProfileId: other.id, appointmentId: appt.id, amountPaise: 50000, method: 'cash', idempotencyKey: key() }).expect(400);
    await o(t.http.post('/v1/payments')).send({ patientProfileId: patient.id, appointmentId: appt.id, amountPaise: 60000, method: 'cash', idempotencyKey: key() }).expect(409);
    await o(t.http.post('/v1/payments')).send({ patientProfileId: patient.id, appointmentId: appt.id, amountPaise: 50000, method: 'card', idempotencyKey: key() }).expect(201);
    await o(t.http.post(`/v1/appointments/${appt.id}/cancel`)).send({ reason: 'Travelling' }).expect(200);
    await o(t.http.post('/v1/payments')).send({ patientProfileId: patient.id, appointmentId: appt.id, amountPaise: 100, method: 'cash', idempotencyKey: key() }).expect(409);
    // advance payment without a visit is allowed
    await o(t.http.post('/v1/payments')).send({ patientProfileId: patient.id, amountPaise: 200000, method: 'card', purpose: 'Advance for FUE', idempotencyKey: key() }).expect(201);
    expect((await o(t.http.get(`/v1/payments?patientProfileId=${patient.id}`))).body.items).toHaveLength(2);
  });
});

describe('inbox', () => {
  it('turns a new WhatsApp number into a lead and lets staff reply within 24 hours', async () => {
    const { owner, o, patient } = await clinic();
    const account = (await o(t.http.post('/v1/channel-accounts')).send({ provider: 'sandbox', kind: 'whatsapp', displayName: 'Test WhatsApp', address: '9000000001' }).expect(201)).body;
    await o(t.http.post(`/v1/channel-accounts/${account.id}/simulate-inbound`)).send({ from: '9876500001', name: 'Neha', body: 'Hair transplant ka cost kitna hai?' }).expect(201);
    await o(t.http.post(`/v1/channel-accounts/${account.id}/simulate-inbound`)).send({ from: '9876500001', body: 'Aur recovery time?' }).expect(201);

    const list = (await o(t.http.get('/v1/conversations')).expect(200)).body.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ channel: 'whatsapp', unread: 2, replyWindowOpen: true, party: { name: 'Neha', phone: '98•• ••• 001' }, lastMessage: { body: 'Aur recovery time?' } });
    const lead = (await o(t.http.get('/v1/leads')).expect(200)).body.items[0];
    expect(lead).toMatchObject({ displayName: 'Neha', source: 'whatsapp', stage: 'enquiry', phone: '+919876500001' });

    const thread = (await o(t.http.get(`/v1/conversations/${list[0].id}`)).expect(200)).body;
    expect(thread).toMatchObject({ unread: 0, party: { phone: '+919876500001', lead: { id: lead.id } } });
    expect(thread.messages.map((m: { direction: string }) => m.direction)).toEqual(['inbound', 'inbound']);
    const sent = (await o(t.http.post(`/v1/conversations/${list[0].id}/messages`)).send({ body: 'Namaste Neha! Consultation ₹500 hai. Kal 11 baje aa sakti hain?' }).expect(201)).body;
    expect(sent.status).toBe('sent');
    expect(sandboxOutbox.at(-1)).toMatchObject({ to: '+919876500001', body: expect.stringContaining('Namaste Neha') });
    expect((await o(t.http.get(`/v1/conversations/${list[0].id}`))).body.assignee).toMatchObject({ name: 'Clinic Owner' });
    expect((await o(t.http.get(`/v1/leads/${lead.id}`))).body.events.map((e: { kind: string }) => e.kind)).toEqual(['message', 'message', 'created']);

    // after 24 hours of silence, free text is refused (WhatsApp rule)
    await ownerDb((c) => c.query(`UPDATE app.conversations SET last_inbound_at = now() - interval '25 hours' WHERE id = $1`, [list[0].id]));
    const late = await o(t.http.post(`/v1/conversations/${list[0].id}/messages`)).send({ body: 'Hello?' }).expect(409);
    expect(late.body.error.message).toContain('24 hours');

    // a registered patient writing in is linked, and no lead is created
    await o(t.http.post(`/v1/channel-accounts/${account.id}/simulate-inbound`)).send({ from: patient.phone, body: 'Kal ka appointment 30 min late kar sakte hain?' }).expect(201);
    const conv = (await o(t.http.get('/v1/conversations')).expect(200)).body.items.find((c: { party: { patient: unknown } }) => c.party.patient);
    expect(conv.party).toMatchObject({ name: 'Ravi Kumar', patient: { profileId: patient.id } });
    expect((await o(t.http.get('/v1/leads')).expect(200)).body.items).toHaveLength(1);

    // closing; the counsellor only sees conversations of their leads
    await o(t.http.patch(`/v1/conversations/${conv.id}`)).send({ status: 'closed' }).expect(200);
    await o(t.http.post(`/v1/conversations/${conv.id}/messages`)).send({ body: 'x' }).expect(409);
    const counsellor = await staff(t, owner, ROLE.counsellor, [], 'Meera');
    const c = as(counsellor.token, owner.orgId);
    expect((await c(t.http.get('/v1/conversations?status=all')).expect(200)).body.items).toHaveLength(0);
    await o(t.http.patch(`/v1/leads/${lead.id}`)).send({ ownerKind: 'user', ownerUserId: counsellor.userId }).expect(200);
    expect((await c(t.http.get('/v1/conversations?status=all')).expect(200)).body.items.map((x: { id: string }) => x.id)).toEqual([list[0].id]);
    await c(t.http.get(`/v1/conversations/${conv.id}`)).expect(404);

    // another clinic sees none of it
    const b = await ownerWithClinic(t, 'Other Clinic');
    await as(b.access, b.orgId)(t.http.get(`/v1/conversations/${list[0].id}`)).expect(404);
  });

  it('accepts only correctly signed WhatsApp Cloud webhooks, once each', async () => {
    const { owner, o } = await clinic();
    const appSecret = 'meta-app-secret-for-tests-0123456789';
    const created = (await o(t.http.post('/v1/channel-accounts')).send({
      provider: 'whatsapp_cloud', kind: 'whatsapp', displayName: 'Clinic WhatsApp', address: '9000000002', phoneNumberId: '1098765432101', accessToken: 'EAAG-test-access-token-not-real', appSecret,
    }).expect(201)).body;
    expect(created.verifyToken).toEqual(expect.any(String));
    const path = created.webhookPath as string;

    // Meta's subscription check
    await t.http.get(`${path}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123`).expect(403);
    expect((await t.http.get(`${path}?hub.mode=subscribe&hub.verify_token=${created.verifyToken}&hub.challenge=8675309`).expect(200)).text).toBe('8675309');

    const payload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp', metadata: { display_phone_number: '919000000002', phone_number_id: '1098765432101' },
        contacts: [{ wa_id: '919876500077', profile: { name: 'Imran Khan' } }],
        messages: [{ from: '919876500077', id: 'wamid.TEST1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Do you treat alopecia areata?' } }],
      } }] }],
    });
    const sign = (body: string, secret = appSecret) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const post = (body: string, sig: string) => t.http.post(path).set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig).send(body);

    await post(payload, sign(payload, 'wrong-secret')).expect(401);
    await post(payload.replace('alopecia', 'ALOPECIA'), sign(payload)).expect(401); // body changed after signing
    expect((await o(t.http.get('/v1/conversations')).expect(200)).body.items).toHaveLength(0);
    await post(payload, sign(payload)).expect(200);
    expect((await post(payload, sign(payload)).expect(200)).body.duplicate).toBe(true);
    const convs = (await o(t.http.get('/v1/conversations')).expect(200)).body.items;
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ party: { name: 'Imran Khan' }, lastMessage: { body: 'Do you treat alopecia areata?' }, account: { isTest: false } });

    // delivery receipts update our outbound messages
    await ownerDb((c) => c.query(
      `INSERT INTO app.messages (organization_id, conversation_id, direction, author_kind, body, vendor_message_id, delivery_status) VALUES ($1, $2, 'outbound', 'user', 'Yes, we do.', 'wamid.OUT1', 'sent')`,
      [owner.orgId, convs[0].id]));
    const status = (s: string) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.OUT1', status: s, recipient_id: '919876500077' }] } }] }] });
    await post(status('read'), sign(status('read'))).expect(200);
    await post(status('delivered'), sign(status('delivered'))).expect(200); // arrives late; must not go backwards
    const msgs = (await o(t.http.get(`/v1/conversations/${convs[0].id}`))).body.messages;
    expect(msgs.find((m: { body: string }) => m.body === 'Yes, we do.').status).toBe('read');

    // the stored credentials are encrypted
    const raw = await ownerDb((c) => c.query(`SELECT encode(secret_enc, 'escape') AS s FROM app.integration_credentials WHERE channel_account_id = $1`, [created.id]));
    expect(raw.rows[0].s).not.toContain(appSecret);
  });
});
