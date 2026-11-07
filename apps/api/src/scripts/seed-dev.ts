/**
 * Development seed. Runs the real API in-process (no shortcuts around validation, RLS or
 * audit) to create: one owner with a clinic and MFA set up, and one receptionist.
 * Prints the sign-in details. Refuses to run in production.
 */
import { createDb } from '@dr/db';
import { authenticator } from 'otplib';
import { pino } from 'pino';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { MemorySms } from '../lib/sms.js';

const config = loadConfig();
if (config.NODE_ENV === 'production') throw new Error('seed-dev must not run in production');

const db = createDb(config.DATABASE_URL);
const sms = new MemorySms();
const app = createApp({ config, db, sms, log: pino({ level: 'silent' }) });
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

async function call(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const json = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json as Record<string, any>;
}

const owner = { fullName: 'Demo Owner', email: 'owner@demo.local', phone: '+919900000001', password: 'demo-owner-2026' };
const receptionist = { fullName: 'Meera (Reception)', phone: '+919900000002' };

try {
  const reg = await call('/auth/register', owner);
  const auth = { Authorization: `Bearer ${reg.accessToken}` };
  const org = await call('/organizations', { name: 'Lumen Hair & Skin (demo)', city: 'Patna', state: 'Bihar', addressLine: 'Boring Road', languages: ['en', 'hi'] }, auth);
  const start = await call('/auth/mfa/enroll/start', {}, auth);
  await call('/auth/mfa/enroll/confirm', { code: authenticator.generate(start.secret) }, auth);
  await call('/members', { fullName: receptionist.fullName, phone: receptionist.phone, roleId: '00000000-0000-4000-8000-000000000004', branchIds: [org.branch.id] }, { ...auth, 'X-Org-Id': org.organization.id });

  console.log(`
Demo data created.

Owner (needs an authenticator code at every sign-in)
  email:    ${owner.email}
  password: ${owner.password}
  TOTP secret (add it to Google Authenticator or any TOTP app): ${start.secret}
  otpauth:  ${start.otpauthUrl}

Receptionist (signs in with an SMS code; with SMS_PROVIDER=console the code is printed in the API log)
  mobile:   ${receptionist.phone}

Clinic id: ${org.organization.id}
`);
} catch (e) {
  console.error((e as Error).message.includes('already exists') ? 'Demo data already exists. Drop the database or change the seed emails.' : e);
  process.exitCode = 1;
} finally {
  server.close();
  await db.close();
}
