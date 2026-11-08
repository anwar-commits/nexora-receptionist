import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { agentPayload, phonePayload, RecordingVendor, signElevenLabs, verifyElevenLabsSignature } from '../src/voice/elevenlabs.js';
import { DEFAULT_CONFIG } from '../src/voice/prompt.js';
import { LocalEncryptedStore } from '../src/voice/recordings.js';
import { normalisePhone } from '../src/modules/voice.js';
import { ROLE, as, makeApp, ownerWithClinic, staff, type TestApp } from './helpers.js';
import { ScriptedReceptionist } from './voice-fake.js';

const INIT_SECRET = 'init-secret-0123456789abcdef';
const HOOK_SECRET = 'whsec_test_secret';
const CALLER = '+919812300011';

let t: TestApp;
let vendor: RecordingVendor;
let llm: ScriptedReceptionist;
let owner: pg.Client;
beforeAll(async () => {
  vendor = new RecordingVendor();
  llm = new ScriptedReceptionist('anthropic');
  t = makeApp({
    llm, voice: vendor, recordings: new LocalEncryptedStore(mkdtempSync(join(tmpdir(), 'dr-rec-')), randomBytes(32)),
    env: { PUBLIC_API_URL: 'https://api.clinic.test', ELEVENLABS_INIT_SECRET: INIT_SECRET, ELEVENLABS_WEBHOOK_SECRET: HOOK_SECRET },
  });
  owner = new pg.Client({ connectionString: inject('ownerDatabaseUrl') });
  await owner.connect();
});
afterAll(async () => { await owner.end(); await t.close(); });

/** A clinic with a doctor (clinic hours Mon–Sat 10–13), a quotable service, and a live AI receptionist. */
async function liveClinic(name = 'Lumen Hair & Skin') {
  const o0 = await ownerWithClinic(t, name);
  const o = as(o0.access, o0.orgId);
  const doctor = (await o(t.http.post('/v1/doctors')).send({ displayName: 'Dr. Arjun Mehta', slotMinutes: 20, bufferMinutes: 0 }).expect(201)).body;
  const rules = [0, 1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '10:00', end: '13:00', mode: 'clinic', branchId: o0.branchId }));
  await o(t.http.put(`/v1/doctors/${doctor.id}/schedule`)).send({ rules }).expect(200);
  await o(t.http.post('/v1/services')).send({ name: 'New consultation', durationMinutes: 20, feePaise: 50000, aiMayQuoteFee: true, modes: ['clinic'] }).expect(201);
  await o(t.http.post('/v1/ai-receptionist')).send({}).expect(201);
  return { owner: o0, o, doctor };
}

async function publish(c: Awaited<ReturnType<typeof liveClinic>>) {
  const suite = await c.o(t.http.post('/v1/ai-receptionist/suite')).send({}).expect(201);
  expect(suite.body.results.filter((r: { status: string }) => r.status !== 'passed')).toEqual([]);
  expect(suite.body).toMatchObject({ total: 40, failed: 0, skipped: 0, passed: 40 });
  await c.o(t.http.post('/v1/ai-receptionist/emergency-approval')).send({}).expect(200);
  const pub = await c.o(t.http.post(`/v1/ai-receptionist/versions/${suite.body.versionId}/publish`)).send({}).expect(200);
  const agent = pub.body.agent;
  const create = [...vendor.sent].reverse().find((s) => s.op === 'create_agent' || s.op === 'update_agent')!;
  const body = create.body as ReturnType<typeof agentPayload>;
  const secretId = body.conversation_config.agent.prompt.custom_llm.api_key.secret_id;
  return { agent, key: vendor.secrets.get(secretId)!, vendorAgentId: agent.vendor.agentId as string, versionId: suite.body.versionId as string };
}

const start = (vendorAgentId: string, conversationId: string, caller = CALLER) =>
  t.http.post('/v1/voice/elevenlabs/initiation').set('X-DR-Secret', INIT_SECRET).send({ caller_id: caller, agent_id: vendorAgentId, called_number: '+918048960000', call_sid: `sid-${conversationId}`, conversation_id: conversationId });

const turn = (agentId: string, key: string, callId: string, messages: { role: string; content: string }[], extra: Record<string, unknown> = {}) =>
  t.http.post(`/v1/voice/llm/${agentId}/chat/completions`).set('Authorization', `Bearer ${key}`).send({ model: 'claude-sonnet-5-5', messages, elevenlabs_extra_body: { dr_call_id: callId }, ...extra });

describe('pure helpers', () => {
  it('builds the ElevenLabs agent with our endpoint as its brain, and signs/verifies webhooks', () => {
    const p = agentPayload({ clinicName: 'Lumen', agentId: 'a1', config: { ...DEFAULT_CONFIG, handoff: { transferNumber: '+919800000001' } }, firstMessage: 'Hi', publicApiUrl: 'https://api.x.in/', llmSecretId: 's1', initiationSecret: 'z' });
    expect(p.conversation_config.agent.prompt).toMatchObject({ llm: 'custom-llm', custom_llm: { url: 'https://api.x.in/v1/voice/llm/a1', api_key: { secret_id: 's1' } } });
    expect(JSON.stringify(p)).not.toMatch(/Never diagnose/); // the clinic prompt stays on our server
    expect(p.conversation_config.agent.prompt.built_in_tools).toHaveProperty('transfer_to_number');
    expect(phonePayload({ provider: 'plivo', phoneNumber: '+918000000000', label: 'x', sipAddress: 'a.sip.plivo.com', username: 'u', password: 'p' })).toMatchObject({ provider: 'sip_trunk' });

    const body = Buffer.from('{"a":1}');
    const sig = signElevenLabs('k', body);
    expect(verifyElevenLabsSignature('k', sig, body)).toBe(true);
    expect(verifyElevenLabsSignature('other', sig, body)).toBe(false);
    expect(verifyElevenLabsSignature('k', sig, Buffer.from('{"a":2}'))).toBe(false);
    expect(verifyElevenLabsSignature('k', signElevenLabs('k', body, Math.floor(Date.now() / 1000) - 7200), body)).toBe(false); // replay
    expect([normalisePhone('09812300011'), normalisePhone('919812300011'), normalisePhone('9812300011'), normalisePhone('anonymous')]).toEqual([CALLER, CALLER, CALLER, null]);
  });
});

describe('settings, safety suite and publishing', () => {
  it('needs all 40 checks and a doctor/owner sign-off before going live; receptionists cannot change it', async () => {
    const c = await liveClinic();
    const view = (await c.o(t.http.get('/v1/ai-receptionist')).expect(200)).body;
    expect(view.setup).toMatchObject({ model: true, voice: true, publicUrl: true, voiceBaseUrl: 'https://api.in.residency.elevenlabs.io' });
    expect(view.agent.firstMessage).toMatch(/AI assistant.*record/i);

    const rec = await staff(t, c.owner, ROLE.receptionist, [c.owner.branchId], 'Meera');
    await as(rec.token, c.owner.orgId)(t.http.get('/v1/ai-receptionist')).expect(403);
    await as(rec.token, c.owner.orgId)(t.http.post('/v1/ai-receptionist/emergency-approval')).send({}).expect(403);

    // A doctor can read the protocol and sign it off, but not change settings.
    const doc = await staff(t, c.owner, ROLE.doctor, [c.owner.branchId], 'Dr. Rao');
    const dq = as(doc.token, c.owner.orgId);
    const dv = (await dq(t.http.get('/v1/ai-receptionist')).expect(200)).body;
    expect(dv).toMatchObject({ canManage: false, canApproveEmergency: true });
    expect(dv.scripts.emergency['hi-Latn']).toMatch(/112/);
    await dq(t.http.put('/v1/ai-receptionist/draft')).send(view.agent.draft).expect(403);
    const signed = (await dq(t.http.post('/v1/ai-receptionist/emergency-approval')).send({}).expect(200)).body;
    expect(signed.agent.draft.emergency.approvedByName).toBe('Dr. Rao');

    // Without approval a passed version cannot go live.
    await c.o(t.http.put('/v1/ai-receptionist/draft')).send({ ...view.agent.draft, emergency: { transferNumber: '+919800000007' } }).expect(200); // clears the sign-off
    const suite = (await c.o(t.http.post('/v1/ai-receptionist/suite')).send({}).expect(201)).body;
    expect(suite.results.filter((r: { status: string }) => r.status !== 'passed')).toEqual([]);
    await c.o(t.http.post(`/v1/ai-receptionist/versions/${suite.versionId}/publish`)).send({}).expect(409);

    // Approve, then change the emergency transfer number: approval is cleared again.
    await c.o(t.http.post('/v1/ai-receptionist/emergency-approval')).send({}).expect(200);
    const d = view.agent.draft;
    const changed = (await c.o(t.http.put('/v1/ai-receptionist/draft')).send({ ...d, emergency: { transferNumber: '+919800000009' } }).expect(200)).body;
    expect(changed.agent.draft.emergency.approvedAt).toBeNull();
    await c.o(t.http.put('/v1/ai-receptionist/draft')).send({ ...d, llmModel: 'gpt-4o' }).expect(400);
  });

  it('skips the live-model checks without a real model, so the version cannot go live', async () => {
    const t2 = makeApp({ llm: new ScriptedReceptionist('fake') });
    try {
      const o0 = await ownerWithClinic(t2, 'Second Clinic');
      const o = as(o0.access, o0.orgId);
 await o(t2.http.post('/v1/ai-receptionist')).send({}).expect(201);
      const s = (await o(t2.http.post('/v1/ai-receptionist/suite')).send({}).expect(201)).body;
      expect(s).toMatchObject({ total: 40, passed: 35, skipped: 5, failed: 0 });
      await o(t2.http.post('/v1/ai-receptionist/emergency-approval')).send({}).expect(200);
      const r = await o(t2.http.post(`/v1/ai-receptionist/versions/${s.versionId}/publish`)).send({}).expect(409);
      expect(r.body.error.message).toMatch(/40 safety checks/);
    } finally { await t2.close(); }
  });

  it('publishes: syncs ElevenLabs with a rotated key and connects an Exotel number', async () => {
    const c = await liveClinic();
    const p = await publish(c);
    expect(p.agent.status).toBe('live');
    expect(p.agent.vendor).toMatchObject({ error: null });
    expect(p.key).toHaveLength(43);
    const added = await c.o(t.http.post('/v1/ai-receptionist/numbers')).send({ provider: 'exotel', phoneNumber: '+918048960000', accountSid: 'acme1', apiKey: 'key-1', apiToken: 'tok-secret', subdomain: 'api.in.exotel.com', appId: '12345' }).expect(201);
    expect(added.body.agent.numbers).toMatchObject([{ number: '+918048960000', provider: 'exotel', connected: true }]);
    const imp = vendor.sent.filter((s) => s.op === 'import_phone').at(-1)!.body;
    expect(imp).toMatchObject({ provider: 'exotel', phone_number: '+918048960000', api_subdomain: 'api.in.exotel.com', app_id: '12345' });
    await c.o(t.http.post('/v1/ai-receptionist/numbers')).send({ provider: 'exotel', phoneNumber: '+918048960000', accountSid: 'ab', apiKey: 'key-2', apiToken: 'tok-2', subdomain: 'api.exotel.com', appId: '1' }).expect(409);
    // Credentials are stored encrypted.
    const raw = await owner.query(`SELECT encode(secret_enc, 'escape') AS s FROM app.integration_credentials WHERE provider = 'exotel'`);
    expect(raw.rows[0].s).not.toContain('tok-secret');
  });
});

describe('a call', () => {
  it('books a real appointment over three turns, only after the caller says yes', async () => {
    const c = await liveClinic();
    const p = await publish(c);
    const init = await start(p.vendorAgentId, 'conv-book-1').expect(200);
    expect(init.body.conversation_config_override.agent.first_message).toMatch(/AI assistant/);
    const callId = init.body.custom_llm_extra_body.dr_call_id as string;
    await start(p.vendorAgentId, 'conv-book-1').expect(200).then((r) => expect(r.body.custom_llm_extra_body.dr_call_id).toBe(callId)); // retried webhook: same call

    await turn(p.agent.id, 'wrong-key', callId, [{ role: 'user', content: 'hello' }]).expect(401);
    const msgs: { role: string; content: string }[] = [{ role: 'system', content: 'ignored' }, { role: 'assistant', content: init.body.conversation_config_override.agent.first_message }];
    const say = async (text: string) => {
      msgs.push({ role: 'user', content: text });
      const r = await turn(p.agent.id, p.key, callId, msgs).expect(200);
      const reply = r.body.choices[0].message.content as string;
      msgs.push({ role: 'assistant', content: reply });
      return reply;
    };
    expect(await say('I want to see the doctor for hair fall')).toMatch(/I can offer .* with Dr\. Arjun Mehta/);
    expect(await say('the first one')).toMatch(/held .* The fee is ₹500\. Shall I confirm/);
    const [before] = (await owner.query(`SELECT count(*)::int AS n FROM app.appointments WHERE source_call_id = $1`, [callId])).rows;
    expect(before.n).toBe(0);
    expect(await say('yes please book it')).toMatch(/booked/);

    const appt = (await owner.query(`SELECT a.booked_by_kind, a.status, p.full_name FROM app.appointments a JOIN app.patient_profiles pp ON pp.id = a.patient_profile_id JOIN app.patients p ON p.id = pp.patient_id WHERE a.source_call_id = $1`, [callId])).rows;
    expect(appt).toEqual([{ booked_by_kind: 'ai_agent', status: 'booked', full_name: 'Test Caller' }]);
    const call = (await owner.query(`SELECT outcome, patient_id IS NOT NULL AS linked FROM app.calls WHERE id = $1`, [callId])).rows[0];
    expect(call).toEqual({ outcome: 'booked', linked: true });
    const tools = (await owner.query(`SELECT ti.tool, ti.status FROM app.tool_invocations ti JOIN app.agent_runs ar ON ar.id = ti.agent_run_id WHERE ar.call_id = $1 ORDER BY ti.created_at`, [callId])).rows.map((r) => `${r.tool}:${r.status}`);
    expect(tools).toEqual(['list_services:ok', 'get_availability:ok', 'hold_slot:ok', 'book_appointment:ok']);
    const audit = (await owner.query(`SELECT actor_kind FROM app.audit_logs WHERE action = 'appointment.book' AND details->>'callId' = $1`, [callId])).rows;
    expect(audit).toEqual([{ actor_kind: 'ai_agent' }]);

    // The booking shows on the staff calendar like any other.
    const day = await c.o(t.http.get('/v1/appointments').query({ from: new Date().toISOString(), to: new Date(Date.now() + 9 * 864e5).toISOString() })).expect(200);
    expect(day.body.items.map((a: { bookedByKind: string }) => a.bookedByKind)).toEqual(['ai_agent']);
  });

  it('gives the emergency script without asking the model, alerts reception, and blocks booking for the rest of the call', async () => {
    const c = await liveClinic();
    const p = await publish(c);
    const callId = (await start(p.vendorAgentId, 'conv-emergency').expect(200)).body.custom_llm_extra_body.dr_call_id;
    const before = llm.calls;
    const r = await turn(p.agent.id, p.key, callId, [{ role: 'user', content: 'mere seene mein bahut dard ho raha hai' }], { stream: true }).expect(200);
    expect(r.headers['content-type']).toMatch(/text\/event-stream/);
    const spoken = r.text.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)).choices[0].delta.content ?? '').join('');
    expect(spoken).toMatch(/112/);
    expect(spoken).toMatch(/emergency/i);
    expect(r.text.trim().endsWith('data: [DONE]')).toBe(true);
    expect(llm.calls).toBe(before); // the model was never asked

    const rec = await staff(t, c.owner, ROLE.receptionist, [c.owner.branchId], 'Meera');
    const rq = as(rec.token, c.owner.orgId);
    const handoffs = (await rq(t.http.get('/v1/handoffs')).expect(200)).body.items;
    expect(handoffs).toMatchObject([{ reason: 'emergency', callId, caller: { phone: CALLER } }]);
    await rq(t.http.post(`/v1/handoffs/${handoffs[0].id}/accept`)).send({}).expect(204);
    await rq(t.http.post(`/v1/handoffs/${handoffs[0].id}/close`)).send({ note: 'Called back, family took him to PMCH' }).expect(204);
    expect((await rq(t.http.get('/v1/handoffs')).expect(200)).body.items).toEqual([]);
    const task = (await owner.query(`SELECT status, priority FROM app.tasks WHERE related_id = $1`, [callId])).rows;
    expect(task).toEqual([{ status: 'done', priority: 'urgent' }]);

    // Later in the same call the caller asks to book: holds are refused.
    await turn(p.agent.id, p.key, callId, [{ role: 'user', content: 'ok I want to book a doctor appointment' }]).expect(200);
    const refused = (await owner.query(`SELECT ti.tool, ti.status FROM app.tool_invocations ti JOIN app.agent_runs ar ON ar.id = ti.agent_run_id WHERE ar.call_id = $1`, [callId])).rows;
    expect(refused).not.toContainEqual({ tool: 'hold_slot', status: 'ok' });
  });

  it('screens what the model says before it is spoken', async () => {
    const c = await liveClinic();
    const p = await publish(c);
    const callId = (await start(p.vendorAgentId, 'conv-guard').expect(200)).body.custom_llm_extra_body.dr_call_id;
    llm.sayNext = 'You should apply minoxidil 5% solution twice a day.';
    const r = await turn(p.agent.id, p.key, callId, [{ role: 'user', content: 'my hair is falling, what should I do' }]).expect(200);
    expect(r.body.choices[0].message.content).toMatch(/can't advise on medicines/);
    const ev = (await owner.query(`SELECT kind, red_flag_key FROM app.safety_events WHERE call_id = $1`, [callId])).rows;
    expect(ev).toEqual([{ kind: 'guardrail_block', red_flag_key: 'dose' }]);
  });

  it('ends the call and hands over through the vendor\'s built-in tools when they are offered', async () => {
    const c = await liveClinic();
    const p = await publish(c);
    const callId = (await start(p.vendorAgentId, 'conv-end').expect(200)).body.custom_llm_extra_body.dr_call_id;
    const tools = [{ type: 'function', function: { name: 'end_call', parameters: { properties: { reason: {} } } } }];
    const r = await turn(p.agent.id, p.key, callId, [{ role: 'user', content: 'bye' }], { tools }).expect(200);
    expect(r.body.choices[0]).toMatchObject({ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: 'end_call' } }] } });
    // Asking for a person with no transfer number set: a call-back task for reception.
    await turn(p.agent.id, p.key, callId, [{ role: 'user', content: 'can I talk to a person' }]).expect(200);
    const t1 = (await owner.query(`SELECT kind, assignee_ref FROM app.tasks WHERE related_id = $1`, [callId])).rows;
    expect(t1).toEqual([{ kind: 'callback', assignee_ref: 'receptionist' }]);
  });

  it('stores the transcript and encrypted recording from the signed post-call webhook, and staff can review it', async () => {
    const c = await liveClinic();
    const p = await publish(c);
    const callId = (await start(p.vendorAgentId, 'conv-post').expect(200)).body.custom_llm_extra_body.dr_call_id;
    const now = Math.floor(Date.now() / 1000);
    const transcript = JSON.stringify({ type: 'post_call_transcription', event_timestamp: now, data: {
      agent_id: p.vendorAgentId, conversation_id: 'conv-post', status: 'done',
      transcript: [{ role: 'agent', message: 'Namaste, Lumen mein aapka swagat hai.', time_in_call_secs: 0 }, { role: 'user', message: 'Kal ka appointment chahiye', time_in_call_secs: 4 }, { role: 'agent', message: null, time_in_call_secs: 6 }],
      metadata: { start_time_unix_secs: now - 60, call_duration_secs: 42, termination_reason: 'client disconnected' },
      analysis: { transcript_summary: 'Caller wanted an appointment for tomorrow.' },
    } });
    await t.http.post('/v1/voice/elevenlabs/post-call').set('Content-Type', 'application/json').set('ElevenLabs-Signature', signElevenLabs('wrong', transcript)).send(transcript).expect(401);
    const sig = signElevenLabs(HOOK_SECRET, transcript);
    await t.http.post('/v1/voice/elevenlabs/post-call').set('Content-Type', 'application/json').set('ElevenLabs-Signature', sig).send(transcript).expect(200);
    const dup = await t.http.post('/v1/voice/elevenlabs/post-call').set('Content-Type', 'application/json').set('ElevenLabs-Signature', sig).send(transcript).expect(200);
    expect(dup.body).toEqual({ duplicate: true });

    const mp3 = randomBytes(5000);
    const audio = JSON.stringify({ type: 'post_call_audio', event_timestamp: now, data: { agent_id: p.vendorAgentId, conversation_id: 'conv-post', full_audio: mp3.toString('base64') } });
    await t.http.post('/v1/voice/elevenlabs/post-call').set('Content-Type', 'application/json').set('ElevenLabs-Signature', signElevenLabs(HOOK_SECRET, audio)).send(audio).expect(200);

    const rec = await staff(t, c.owner, ROLE.receptionist, [c.owner.branchId], 'Meera');
    const rq = as(rec.token, c.owner.orgId);
    const list = (await rq(t.http.get('/v1/calls')).expect(200)).body.items;
    expect(list).toMatchObject([{ id: callId, status: 'completed', durationSeconds: 42, summary: 'Caller wanted an appointment for tomorrow.', hasRecording: true, caller: { phone: '98•• ••• 011' } }]);
    const detail = (await rq(t.http.get(`/v1/calls/${callId}`)).expect(200)).body;
    expect(detail.transcript.map((x: { speaker: string; text: string }) => `${x.speaker}: ${x.text}`)).toEqual(['ai: Namaste, Lumen mein aapka swagat hai.', 'caller: Kal ka appointment chahiye']);
    expect(detail.recording.durationSeconds).toBe(42);
    const play = await rq(t.http.get(`/v1/calls/${callId}/recording`)).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (d: Buffer) => b.push(d)); res.on('end', () => cb(null, Buffer.concat(b))); }).expect(200);
    expect(Buffer.compare(play.body as Buffer, mp3)).toBe(0);

    // Retention: past its date the audio is deleted and the row marked.
    await owner.query(`UPDATE app.call_recordings SET delete_after = now() - interval '1 day' WHERE call_id = $1`, [callId]);
    // (deleted by the retention test below)
  });

  it('does not answer for a paused receptionist, and the test console saves nothing', async () => {
    const c = await liveClinic();
    const p = await publish(c);
    const out = (await c.o(t.http.post('/v1/ai-receptionist/test')).send({ lines: ['I want to see the doctor for hair fall', 'the first one', 'yes please book it'], callerPhone: '+919812399999' }).expect(200)).body;
    expect(out.turns.map((x: { reply: string }) => x.reply).join(' ')).toMatch(/booked/);
    expect(out.turns[2].tools.map((x: { name: string }) => x.name)).toEqual(['book_appointment']);
    const n = (await owner.query(`SELECT count(*)::int AS n FROM app.appointments a JOIN app.calls c ON c.id = a.source_call_id WHERE c.organization_id = $1`, [c.owner.orgId])).rows[0].n;
    expect(n).toBe(0);

    await c.o(t.http.post('/v1/ai-receptionist/pause')).send({}).expect(200);
    const callId = (await start(p.vendorAgentId, 'conv-paused').expect(200)).body.custom_llm_extra_body.dr_call_id;
    const r = await turn(p.agent.id, p.key, callId, [{ role: 'user', content: 'hello' }]).expect(200);
    expect(r.body.choices[0].message.content).toMatch(/not available/);
    await c.o(t.http.post('/v1/ai-receptionist/resume')).send({}).expect(200);
  });

  it('keeps clinics apart: one clinic\'s key cannot answer for another clinic\'s agent', async () => {
    const a = await liveClinic('Clinic A');
    const pa = await publish(a);
    const b = await liveClinic('Clinic B');
    const pb = await publish(b);
    const callB = (await start(pb.vendorAgentId, 'conv-iso').expect(200)).body.custom_llm_extra_body.dr_call_id;
    await turn(pb.agent.id, pa.key, callB, [{ role: 'user', content: 'hello' }]).expect(401);
    // A's agent with B's call id: the call is not found in A's clinic, so a new A call is opened instead.
    await turn(pa.agent.id, pa.key, callB, [{ role: 'user', content: 'hello' }]).expect(200);
    const rows = (await owner.query(`SELECT organization_id FROM app.calls WHERE id = $1`, [callB])).rows;
    expect(rows[0].organization_id).toBe(b.owner.orgId);
    await as(a.owner.access, a.owner.orgId)(t.http.get(`/v1/calls/${callB}`)).expect(404);
  });
});

describe('recording retention', () => {
  it('deletes audio past the retention date', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dr-ret-'));
    const store = new LocalEncryptedStore(dir, randomBytes(32));
    const { purgeExpiredRecordings } = await import('../src/voice/postcall.js');
    const { createDb } = await import('@dr/db');
    const db = createDb(inject('apiDatabaseUrl'), { poolMax: 2 });
    try {
      const keys = (await owner.query(`SELECT object_key FROM app.call_recordings WHERE deleted_at IS NULL AND delete_after <= now()`)).rows;
      for (const k of keys) await store.put(k.object_key, Buffer.from('x'));
      const { pino } = await import('pino');
      const n = await purgeExpiredRecordings({ db, recordings: store, log: pino({ level: 'silent' }), config: {} as never, sms: {} as never });
      expect(n).toBe(keys.length);
      expect(n).toBeGreaterThan(0);
      await expect(store.get(keys[0]!.object_key)).rejects.toThrow();
      const left = (await owner.query(`SELECT count(*)::int AS n FROM app.call_recordings WHERE deleted_at IS NULL AND delete_after <= now()`)).rows[0].n;
      expect(left).toBe(0);
    } finally { await db.close(); }
  });
});

describe('without a model', () => {
  it('refuses to run the test console and says why', async () => {
    const t3 = makeApp();
    try {
      const o0 = await ownerWithClinic(t3, 'No Model Clinic');
      const o = as(o0.access, o0.orgId);
      await o(t3.http.post('/v1/ai-receptionist')).send({}).expect(201);
      const r = await o(t3.http.post('/v1/ai-receptionist/test')).send({ lines: ['hello'] }).expect(409);
      expect(r.body.error).toMatchObject({ code: 'no_model' });
      expect((await o(t3.http.get('/v1/ai-receptionist')).expect(200)).body.setup).toMatchObject({ model: false, voice: false });
    } finally { await t3.close(); }
  });
});
