import { createDb, type Db } from '@dr/db';
import { randomBytes } from 'node:crypto';
import { authenticator } from 'otplib';
import { pino } from 'pino';
import request from 'supertest';
import { inject } from 'vitest';
import { createApp } from '../src/app.js';
import type { Deps } from '../src/context.js';
import { loadConfig } from '../src/config.js';
import { MemorySms } from '../src/lib/sms.js';

export interface TestApp {
  http: ReturnType<typeof request>;
  db: Db;
  sms: MemorySms;
  close(): Promise<void>;
}

export interface MakeAppOptions { llm?: Deps['llm']; voice?: Deps['voice']; recordings?: Deps['recordings']; env?: Record<string, string> }

export function makeApp(opts: MakeAppOptions = {}): TestApp {
  const key = () => randomBytes(32).toString('base64');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: inject('apiDatabaseUrl'),
    JWT_SECRET: key(),
    DATA_ENCRYPTION_KEY: key(),
    HASH_PEPPER: key(),
    SMS_PROVIDER: 'memory',
    AUTH_RATE_LIMIT_PER_MIN: '1000',
    ...opts.env,
  });
  const db = createDb(config.DATABASE_URL, { poolMax: 4 });
  const sms = new MemorySms();
  const app = createApp({ config, db, sms, log: pino({ level: process.env.TEST_LOG ?? 'silent' }), llm: opts.llm, voice: opts.voice, recordings: opts.recordings });
  return { http: request(app), db, sms, close: () => db.close() };
}

let counter = 0;
/** Unique test identity: email and an Indian mobile number. */
export function person(name = 'Test User') {
  counter += 1;
  const n = (Date.now() % 1_000_000).toString().padStart(6, '0');
  return {
    fullName: name,
    email: `user${n}${counter}@example.test`,
    phone: `+919${n}${counter.toString().padStart(3, '0')}`.slice(0, 13),
    password: 'correct-horse-42',
  };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
export const totp = (secret: string) => authenticator.generate(secret);

/** Registers a user, creates a clinic, and completes MFA enrolment as its owner. */
export async function ownerWithClinic(t: TestApp, clinicName = 'Lumen Hair & Skin') {
  const p = person('Clinic Owner');
  const reg = await t.http.post('/v1/auth/register').send(p).expect(201);
  let access: string = reg.body.accessToken;
  const org = await t.http.post('/v1/organizations').set(bearer(access)).send({
    name: clinicName, city: 'Patna', state: 'Bihar', addressLine: 'Boring Road', languages: ['en', 'hi'],
  }).expect(201);
  const start = await t.http.post('/v1/auth/mfa/enroll/start').set(bearer(access)).send({}).expect(200);
  await t.http.post('/v1/auth/mfa/enroll/confirm').set(bearer(access)).send({ code: totp(start.body.secret) }).expect(200);
  return { person: p, access, refresh: reg.body.refreshToken as string, orgId: org.body.organization.id as string, branchId: org.body.branch.id as string, totpSecret: start.body.secret as string };
}

export const ROLE = {
  branchManager: '00000000-0000-4000-8000-000000000002',
  doctor: '00000000-0000-4000-8000-000000000003',
  receptionist: '00000000-0000-4000-8000-000000000004',
  counsellor: '00000000-0000-4000-8000-000000000005',
};

export type Owner = Awaited<ReturnType<typeof ownerWithClinic>>;
type Req = ReturnType<TestApp['http']['get']>;
export const as = (token: string, orgId: string) => (r: Req) => r.set(bearer(token)).set('X-Org-Id', orgId);

/** Invites someone with a role, then signs them in by SMS code (and enrols MFA if the role needs it). */
export async function staff(t: TestApp, owner: Owner, roleId: string, branchIds: string[] = [], name = 'Staff Member') {
  const p = person(name);
  const inv = await as(owner.access, owner.orgId)(t.http.post('/v1/members')).send({ fullName: p.fullName, phone: p.phone, roleId, branchIds }).expect(201);
  await t.http.post('/v1/auth/otp').send({ phone: p.phone }).expect(202);
  const login = await t.http.post('/v1/auth/otp/verify').send({ phone: p.phone, code: t.sms.sent.get(p.phone) }).expect(200);
  if (login.body.status === 'ok') return { token: login.body.accessToken as string, userId: inv.body.userId as string };
  const start = await t.http.post('/v1/auth/mfa/enroll/start').send({ mfaToken: login.body.mfaToken }).expect(200);
  const done = await t.http.post('/v1/auth/mfa/enroll/confirm').send({ mfaToken: login.body.mfaToken, code: totp(start.body.secret) }).expect(200);
  return { token: done.body.accessToken as string, userId: inv.body.userId as string };
}

