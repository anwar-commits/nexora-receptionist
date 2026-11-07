import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, makeApp, ownerWithClinic, person, totp, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(() => { t = makeApp(); });
afterAll(() => t.close());

describe('registration and password sign-in', () => {
  it('registers, rejects duplicates, and signs in', async () => {
    const p = person();
    const reg = await t.http.post('/v1/auth/register').send(p).expect(201);
    expect(reg.body.status).toBe('ok');
    expect(reg.body.accessToken).toBeTruthy();
    expect(reg.body.refreshToken).toBeTruthy();

    const dup = await t.http.post('/v1/auth/register').send(p).expect(409);
    expect(dup.body.error.code).toBe('conflict');

    const bad = await t.http.post('/v1/auth/login').send({ identifier: p.email, password: 'wrong-password-1' }).expect(401);
    expect(bad.body.error.code).toBe('invalid_credentials');

    const ok = await t.http.post('/v1/auth/login').send({ identifier: p.email, password: p.password }).expect(200);
    expect(ok.body.status).toBe('ok');

    // the mobile number works as the identifier too, with or without +91
    await t.http.post('/v1/auth/login').send({ identifier: p.phone.slice(3), password: p.password }).expect(200);
  });

  it('validates input with field-level messages', async () => {
    const res = await t.http.post('/v1/auth/register').send({ fullName: 'A', email: 'nope', phone: '123', password: 'short' }).expect(400);
    expect(res.body.error.code).toBe('validation_failed');
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['fullName', 'email', 'phone', 'password']));
  });

  it('locks the account after 5 wrong passwords', async () => {
    const p = person();
    await t.http.post('/v1/auth/register').send(p).expect(201);
    for (let i = 0; i < 5; i++) {
      await t.http.post('/v1/auth/login').send({ identifier: p.email, password: 'wrong-password-1' }).expect(401);
    }
    const locked = await t.http.post('/v1/auth/login').send({ identifier: p.email, password: p.password }).expect(423);
    expect(locked.body.error.code).toBe('account_locked');
  });

  it('gives the same answer for unknown accounts', async () => {
    const res = await t.http.post('/v1/auth/login').send({ identifier: 'nobody@example.test', password: 'whatever-123' }).expect(401);
    expect(res.body.error.code).toBe('invalid_credentials');
  });
});

describe('one-time code sign-in', () => {
  it('signs in with an SMS code and rejects a wrong one', async () => {
    const p = person();
    await t.http.post('/v1/auth/register').send(p).expect(201);
    await t.http.post('/v1/auth/otp').send({ phone: p.phone }).expect(202);
    const code = t.sms.sent.get(p.phone);
    expect(code).toMatch(/^\d{6}$/);

    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await t.http.post('/v1/auth/otp/verify').send({ phone: p.phone, code: wrong }).expect(401);
    expect(bad.body.error.code).toBe('otp_invalid');

    const ok = await t.http.post('/v1/auth/otp/verify').send({ phone: p.phone, code }).expect(200);
    expect(ok.body.status).toBe('ok');

    // a code works once
    await t.http.post('/v1/auth/otp/verify').send({ phone: p.phone, code }).expect(401);
  });

  it('does not reveal whether a number is registered', async () => {
    const phone = '+919000000001';
    const res = await t.http.post('/v1/auth/otp').send({ phone }).expect(202);
    expect(res.body.status).toBe('sent_if_registered');
    expect(t.sms.sent.has(phone)).toBe(false);
  });

  it('limits codes to 5 per 15 minutes per number', async () => {
    const p = person();
    await t.http.post('/v1/auth/register').send(p).expect(201);
    for (let i = 0; i < 5; i++) await t.http.post('/v1/auth/otp').send({ phone: p.phone }).expect(202);
    const res = await t.http.post('/v1/auth/otp').send({ phone: p.phone }).expect(429);
    expect(res.body.error.code).toBe('otp_rate_limited');
  });
});

describe('sessions', () => {
  it('rotates refresh tokens and ends sessions on sign-out', async () => {
    const p = person();
    const reg = await t.http.post('/v1/auth/register').send(p).expect(201);

    const r1 = await t.http.post('/v1/auth/refresh').send({ refreshToken: reg.body.refreshToken }).expect(200);
    expect(r1.body.refreshToken).not.toBe(reg.body.refreshToken);
    // the old refresh token no longer works
    await t.http.post('/v1/auth/refresh').send({ refreshToken: reg.body.refreshToken }).expect(401);

    await t.http.get('/v1/me').set(bearer(r1.body.accessToken)).expect(200);
    await t.http.post('/v1/auth/logout').set(bearer(r1.body.accessToken)).expect(204);
    const after = await t.http.get('/v1/me').set(bearer(r1.body.accessToken)).expect(401);
    expect(after.body.error.code).toBe('session_expired');
    await t.http.post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401);
  });

  it('rejects missing and forged tokens', async () => {
    await t.http.get('/v1/me').expect(401);
    await t.http.get('/v1/me').set(bearer('not-a-token')).expect(401);
  });
});

describe('two-step verification', () => {
  it('requires the authenticator code for owners on every new sign-in', async () => {
    const owner = await ownerWithClinic(t);
    const login = await t.http.post('/v1/auth/login').send({ identifier: owner.person.email, password: owner.person.password }).expect(200);
    expect(login.body).toMatchObject({ status: 'mfa_required', enrolled: true });
    expect(login.body.accessToken).toBeUndefined();

    const bad = await t.http.post('/v1/auth/mfa/verify').send({ mfaToken: login.body.mfaToken, code: '000000' });
    if (totp(owner.totpSecret) !== '000000') expect(bad.status).toBe(401);

    const ok = await t.http.post('/v1/auth/mfa/verify').send({ mfaToken: login.body.mfaToken, code: totp(owner.totpSecret) }).expect(200);
    await t.http.get('/v1/organizations/current').set(bearer(ok.body.accessToken)).set('X-Org-Id', owner.orgId).expect(200);
  });

  it('blocks a clinic role that needs MFA until enrolment is done', async () => {
    const p = person();
    const reg = await t.http.post('/v1/auth/register').send(p).expect(201);
    const org = await t.http.post('/v1/organizations').set(bearer(reg.body.accessToken))
      .send({ name: 'Second Clinic', city: 'Gaya', state: 'Bihar', addressLine: 'Station Road' }).expect(201);
    expect(org.body.mfaRequiredForRole).toBe(true);
    const res = await t.http.get('/v1/organizations/current').set(bearer(reg.body.accessToken)).set('X-Org-Id', org.body.organization.id).expect(403);
    expect(res.body.error.code).toBe('mfa_enrollment_required');
  });
});
