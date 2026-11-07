import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, makeApp, ownerWithClinic, person, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(() => { t = makeApp(); });
afterAll(() => t.close());

const RECEPTIONIST = '00000000-0000-4000-8000-000000000004';
const OWNER = '00000000-0000-4000-8000-000000000001';

describe('clinic setup and staff roles', () => {
  it('runs the owner, receptionist and outsider paths end to end', async () => {
    const owner = await ownerWithClinic(t, 'Lumen Hair & Skin');
    const asOwner = (r: ReturnType<typeof t.http.get>) => r.set(bearer(owner.access)).set('X-Org-Id', owner.orgId);

    // owner sees full permissions
    const cur = await asOwner(t.http.get('/v1/organizations/current')).expect(200);
    expect(cur.body.you.roleKey).toBe('owner');
    expect(cur.body.you.permissions).toContain('member:manage');

    // branches and departments
    const kankarbagh = await asOwner(t.http.post('/v1/branches')).send({ name: 'Kankarbagh', addressLine: 'Main Road', city: 'Patna', state: 'Bihar', pincode: '800020' }).expect(201);
    const branches = await asOwner(t.http.get('/v1/branches')).expect(200);
    expect(branches.body.items).toHaveLength(2);
    await asOwner(t.http.post('/v1/departments')).send({ name: 'Hair restoration' }).expect(201);
    await asOwner(t.http.post('/v1/departments')).send({ name: 'Hair restoration' }).expect(409);

    // invite a receptionist to one branch, by mobile number
    const rec = person('Meera Receptionist');
    const invited = await asOwner(t.http.post('/v1/members')).send({ fullName: rec.fullName, phone: rec.phone, roleId: RECEPTIONIST, branchIds: [kankarbagh.body.id] }).expect(201);
    expect(invited.body.status).toBe('invited');
    await asOwner(t.http.post('/v1/members')).send({ fullName: rec.fullName, phone: rec.phone, roleId: RECEPTIONIST }).expect(409);

    // the receptionist signs in with an SMS code; the invitation becomes active
    await t.http.post('/v1/auth/otp').send({ phone: rec.phone }).expect(202);
    const recLogin = await t.http.post('/v1/auth/otp/verify').send({ phone: rec.phone, code: t.sms.sent.get(rec.phone) }).expect(200);
    expect(recLogin.body.status).toBe('ok'); // receptionist role does not require MFA
    const recToken = recLogin.body.accessToken as string;
    const me = await t.http.get('/v1/me').set(bearer(recToken)).expect(200);
    expect(me.body.memberships).toEqual([expect.objectContaining({ organizationId: owner.orgId, roleKey: 'receptionist', status: 'active' })]);

    const asRec = (r: ReturnType<typeof t.http.get>) => r.set(bearer(recToken)).set('X-Org-Id', owner.orgId);
    await asRec(t.http.get('/v1/organizations/current')).expect(200);
    // only their own branch is listed
    const recBranches = await asRec(t.http.get('/v1/branches')).expect(200);
    expect(recBranches.body.items.map((b: { id: string }) => b.id)).toEqual([kankarbagh.body.id]);
    // and they cannot open branches, invite staff, change settings or read the audit log
    expect((await asRec(t.http.post('/v1/branches')).send({ name: 'X', addressLine: 'Y road', city: 'Patna', state: 'Bihar' })).body.error.code).toBe('permission_denied');
    expect((await asRec(t.http.post('/v1/members')).send({ fullName: 'Someone', phone: '+919811111111', roleId: OWNER })).status).toBe(403);
    expect((await asRec(t.http.patch('/v1/organizations/current')).send({ name: 'Hacked' })).status).toBe(403);
    expect((await asRec(t.http.get('/v1/audit'))).status).toBe(403);

    // a second clinic: the receptionist is not a member there
    const other = await ownerWithClinic(t, 'Other Clinic');
    const out = await t.http.get('/v1/organizations/current').set(bearer(recToken)).set('X-Org-Id', other.orgId).expect(403);
    expect(out.body.error.code).toBe('not_a_member');
    // nor is the first owner
    await t.http.get('/v1/branches').set(bearer(owner.access)).set('X-Org-Id', other.orgId).expect(403);

    // owner safeguards
    const members = await asOwner(t.http.get('/v1/members')).expect(200);
    const ownMembership = members.body.items.find((m: { roleKey: string }) => m.roleKey === 'owner');
    expect((await asOwner(t.http.patch(`/v1/members/${ownMembership.id}`)).send({ status: 'suspended' })).status).toBe(403);

    // suspending the receptionist cuts access immediately
    const recMember = members.body.items.find((m: { roleKey: string }) => m.roleKey === 'receptionist');
    await asOwner(t.http.patch(`/v1/members/${recMember.id}`)).send({ status: 'suspended' }).expect(200);
    await asRec(t.http.get('/v1/organizations/current')).expect(403);

    // everything above is in the audit log
    const audit = await asOwner(t.http.get('/v1/audit?limit=100')).expect(200);
    const actions = audit.body.items.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['organization.create', 'branch.create', 'department.create', 'member.invite', 'member.activated', 'member.update']));
    // and the other clinic's events are not
    expect(audit.body.items.every((a: { details: { name?: string } }) => a.details.name !== 'Other Clinic')).toBe(true);
  });

  it('keeps an owner of two clinics from seeing one clinic\'s team in the other', async () => {
    const owner = await ownerWithClinic(t, 'First Clinic');
    const second = await t.http.post('/v1/organizations').set(bearer(owner.access))
      .send({ name: 'Second Clinic', city: 'Gaya', state: 'Bihar', addressLine: 'Station Road' }).expect(201);
    const secondId = second.body.organization.id as string;

    const me = await t.http.get('/v1/me').set(bearer(owner.access)).expect(200);
    expect(me.body.memberships.map((m: { organizationId: string }) => m.organizationId).sort()).toEqual([owner.orgId, secondId].sort());

    for (const orgId of [owner.orgId, secondId]) {
      const list = await t.http.get('/v1/members').set(bearer(owner.access)).set('X-Org-Id', orgId).expect(200);
      expect(list.body.items).toHaveLength(1);
      // patching a membership id from the other clinic is "not found", not a cross-clinic edit
      const otherOrg = orgId === owner.orgId ? secondId : owner.orgId;
      const otherList = await t.http.get('/v1/members').set(bearer(owner.access)).set('X-Org-Id', otherOrg).expect(200);
      const res = await t.http.patch(`/v1/members/${otherList.body.items[0].id}`).set(bearer(owner.access)).set('X-Org-Id', orgId).send({ status: 'suspended' });
      expect(res.status).toBe(404);
    }
  });

  it('never leaves a clinic without an active owner', async () => {
    const owner = await ownerWithClinic(t, 'Owner Clinic');
    // second owner: invite, sign in by SMS, enrol MFA
    const p = person('Second Owner');
    await t.http.post('/v1/members').set(bearer(owner.access)).set('X-Org-Id', owner.orgId)
      .send({ fullName: p.fullName, phone: p.phone, roleId: OWNER }).expect(201);
    await t.http.post('/v1/auth/otp').send({ phone: p.phone }).expect(202);
    const first = await t.http.post('/v1/auth/otp/verify').send({ phone: p.phone, code: t.sms.sent.get(p.phone) }).expect(200);
    expect(first.body).toMatchObject({ status: 'mfa_required', enrolled: false });
    const start = await t.http.post('/v1/auth/mfa/enroll/start').send({ mfaToken: first.body.mfaToken }).expect(200);
    const { totp } = await import('./helpers.js');
    const done = await t.http.post('/v1/auth/mfa/enroll/confirm').send({ mfaToken: first.body.mfaToken, code: totp(start.body.secret) }).expect(200);
    const second = done.body.accessToken as string;

    const members = await t.http.get('/v1/members').set(bearer(second)).set('X-Org-Id', owner.orgId).expect(200);
    const firstOwner = members.body.items.find((m: { fullName: string }) => m.fullName === 'Clinic Owner');
    // the second owner may suspend the first (two owners exist)...
    await t.http.patch(`/v1/members/${firstOwner.id}`).set(bearer(second)).set('X-Org-Id', owner.orgId).send({ status: 'suspended' }).expect(200);
    // ...and nobody can then remove the last one (it is their own membership, so also blocked)
    const secondMembership = members.body.items.find((m: { fullName: string }) => m.fullName === 'Second Owner');
    const self = await t.http.patch(`/v1/members/${secondMembership.id}`).set(bearer(second)).set('X-Org-Id', owner.orgId).send({ status: 'suspended' });
    expect(self.status).toBe(403);
  });

  it('requires X-Org-Id for clinic endpoints', async () => {
    const owner = await ownerWithClinic(t);
    const res = await t.http.get('/v1/branches').set(bearer(owner.access)).expect(400);
    expect(res.body.error.code).toBe('organization_required');
  });

  it('lists built-in roles with their permissions', async () => {
    const owner = await ownerWithClinic(t);
    const res = await t.http.get('/v1/roles').set(bearer(owner.access)).set('X-Org-Id', owner.orgId).expect(200);
    const keys = res.body.items.map((r: { key: string }) => r.key);
    expect(keys).toEqual(expect.arrayContaining(['owner', 'branch_manager', 'doctor', 'receptionist', 'counsellor', 'ai_ops', 'staff']));
    const rec = res.body.items.find((r: { key: string }) => r.key === 'receptionist');
    expect(rec.permissions).toEqual(expect.arrayContaining([{ key: 'payment:refund', scope: 'branch', limit: 500000 }]));
    expect(rec.permissions.map((p: { key: string }) => p.key)).not.toContain('clinical:read');
  });
});
