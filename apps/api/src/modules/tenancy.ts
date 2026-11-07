import {
  branchBody, createOrganizationBody, departmentBody, inviteMemberBody, updateBranchBody, updateMemberBody, updateOrganizationBody,
} from '@dr/contracts';
import {
  AuditLog, Branch, Department, Membership, Op, Organization, OrganizationSettings, Role, RolePermission, User,
} from '@dr/db';
import { Router, type Request } from 'express';
import type { Deps } from '../context.js';
import { HttpError, conflict, forbidden, notFound } from '../errors.js';
import { auditFromReq } from '../lib/audit.js';
import { grant, parse, requireOrg, requirePermission, requireUser } from '../middleware.js';

const OWNER_ROLE_ID = '00000000-0000-4000-8000-000000000001';
const BRANCH_MANAGER_ROLE_ID = '00000000-0000-4000-8000-000000000002';

function slugify(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'clinic';
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Members limited to some branches only touch those branches. */
function branchAllowed(req: Request, permission: string, branchId: string): boolean {
  const g = grant(req, permission);
  if (g.scope === 'org') return true;
  const mine = req.ctx!.org!.branchIds;
  return g.scope === 'branch' && (mine.length === 0 || mine.includes(branchId));
}

const branchJson = (b: Branch) => ({
  id: b.id, name: b.name, addressLine: b.addressLine, city: b.city, state: b.state, pincode: b.pincode,
  phone: b.phone, openingHours: b.openingHours, isActive: b.isActive,
});

export function tenancyRouter(deps: Deps): Router {
  const { db } = deps;
  const r = Router();
  const user = requireUser(deps);
  const org = requireOrg(deps);
  const inOrg = <T>(req: Request, fn: () => Promise<T>) => db.withContext({ orgId: req.ctx!.org!.id, userId: req.ctx!.userId }, fn);

  // ---------- organizations ----------
  /** Creates a clinic with its first branch; the creator becomes its owner. */
  r.post('/organizations', user, async (req, res) => {
    const body = parse(createOrganizationBody, req.body);
    const userId = req.ctx!.userId;
    const created = await db.withContext({ userId }, async () => {
      const o = await Organization.create({
        name: body.name, slug: slugify(body.name), specialities: body.specialities, languages: body.languages,
        legalName: null, gstin: null, logoUrl: null, deletedAt: null,
        trialEndsAt: new Date(Date.now() + 14 * 86_400_000),
      });
      // From here on this transaction acts inside the new clinic.
      await db.sequelize.query("SELECT set_config('app.org_id', :id, true)", { replacements: { id: o.id } });
      await OrganizationSettings.create({ organizationId: o.id });
      const b = await Branch.create({
        organizationId: o.id, name: `${body.city} (main)`, addressLine: body.addressLine, city: body.city,
        state: body.state, pincode: body.pincode ?? null, phone: null, deletedAt: null,
      });
      const m = await Membership.create({ organizationId: o.id, userId, roleId: OWNER_ROLE_ID, status: 'active', invitedBy: null });
      req.ctx!.org = { id: o.id, membershipId: m.id, roleId: OWNER_ROLE_ID, roleKey: 'owner', branchIds: [], grants: new Map() };
      await auditFromReq(req, { action: 'organization.create', targetType: 'organization', targetId: o.id, details: { name: o.name } });
      return { organization: { id: o.id, name: o.name, slug: o.slug, status: o.status }, branch: branchJson(b) };
    });
    // The owner role needs MFA, so the client should run enrolment if this session hasn't.
    res.status(201).json({ ...created, mfaRequiredForRole: !req.ctx!.mfaVerified });
  });

  r.get('/organizations/current', user, org, requirePermission('org:read'), async (req, res) => {
    const o = await inOrg(req, () => Organization.findByPk(req.ctx!.org!.id));
    if (!o) throw notFound();
    res.json({
      id: o.id, name: o.name, slug: o.slug, legalName: o.legalName, gstin: o.gstin, status: o.status,
      specialities: o.specialities, languages: o.languages, timezone: o.timezone, trialEndsAt: o.trialEndsAt,
      you: { roleKey: req.ctx!.org!.roleKey, permissions: [...req.ctx!.org!.grants.keys()].sort() },
    });
  });

  r.patch('/organizations/current', user, org, requirePermission('org:update'), async (req, res) => {
    const body = parse(updateOrganizationBody, req.body);
    const o = await inOrg(req, async () => {
      const found = await Organization.findByPk(req.ctx!.org!.id);
      if (!found) throw notFound();
      await found.update(body);
      await auditFromReq(req, { action: 'organization.update', targetType: 'organization', targetId: found.id, details: { fields: Object.keys(body) } });
      return found;
    });
    res.json({ id: o.id, name: o.name, legalName: o.legalName, gstin: o.gstin, specialities: o.specialities, languages: o.languages });
  });

  // ---------- branches ----------
  r.get('/branches', user, org, requirePermission('branch:read'), async (req, res) => {
    const g = grant(req, 'branch:read');
    const mine = req.ctx!.org!.branchIds;
    const where = g.scope === 'branch' && mine.length ? { id: mine, deletedAt: null } : { deletedAt: null };
    const rows = await inOrg(req, () => Branch.findAll({ where, order: [['createdAt', 'ASC']] }));
    res.json({ items: rows.map(branchJson) });
  });

  r.post('/branches', user, org, requirePermission('branch:manage'), async (req, res) => {
    if (grant(req, 'branch:manage').scope !== 'org') throw forbidden('Only clinic-wide managers can open new branches');
    const body = parse(branchBody, req.body);
    const b = await inOrg(req, async () => {
      const created = await Branch.create({ ...body, pincode: body.pincode ?? null, phone: body.phone ?? null, organizationId: req.ctx!.org!.id, deletedAt: null });
      await auditFromReq(req, { action: 'branch.create', targetType: 'branch', targetId: created.id, details: { name: created.name } });
      return created;
    });
    res.status(201).json(branchJson(b));
  });

  r.patch('/branches/:id', user, org, requirePermission('branch:manage'), async (req, res) => {
    const body = parse(updateBranchBody, req.body);
    const id = String(req.params.id);
    if (!branchAllowed(req, 'branch:manage', id)) throw forbidden('This branch is outside your branches');
    const b = await inOrg(req, async () => {
      const found = await Branch.findOne({ where: { id, deletedAt: null } });
      if (!found) throw notFound('Branch not found');
      await found.update(body);
      await auditFromReq(req, { action: 'branch.update', targetType: 'branch', targetId: id, details: { fields: Object.keys(body) } });
      return found;
    });
    res.json(branchJson(b));
  });

  // ---------- departments ----------
  r.get('/departments', user, org, requirePermission('org:read'), async (req, res) => {
    const rows = await inOrg(req, () => Department.findAll({ order: [['name', 'ASC']] }));
    res.json({ items: rows.map((d) => ({ id: d.id, name: d.name, code: d.code })) });
  });

  r.post('/departments', user, org, requirePermission('department:manage'), async (req, res) => {
    const body = parse(departmentBody, req.body);
    const d = await inOrg(req, async () => {
      if (await Department.findOne({ where: { name: body.name } })) throw conflict('A department with this name exists');
      const created = await Department.create({ organizationId: req.ctx!.org!.id, name: body.name, code: body.code ?? null });
      await auditFromReq(req, { action: 'department.create', targetType: 'department', targetId: created.id, details: { name: created.name } });
      return created;
    });
    res.status(201).json({ id: d.id, name: d.name, code: d.code });
  });

  // ---------- roles ----------
  r.get('/roles', user, org, requirePermission('role:read'), async (req, res) => {
    const rows = await inOrg(req, async () => {
      const roles = await Role.findAll({ where: { [Op.or]: [{ organizationId: null }, { organizationId: req.ctx!.org!.id }] }, order: [['key', 'ASC']] });
      const perms = await RolePermission.findAll({ where: { roleId: roles.map((x) => x.id) } });
      return roles.map((x) => ({
        id: x.id, key: x.key, name: x.name, isBuiltin: x.isBuiltin, requiresMfa: x.requiresMfa,
        permissions: perms.filter((p) => p.roleId === x.id).map((p) => ({ key: p.permissionKey, scope: p.scope, limit: p.limitValue === null ? null : Number(p.limitValue) })),
      }));
    });
    res.json({ items: rows });
  });

  // ---------- members ----------
  r.get('/members', user, org, requirePermission('member:read'), async (req, res) => {
    const g = grant(req, 'member:read');
    const mine = req.ctx!.org!.branchIds;
    // Always filter by clinic: the member_self_read policy also returns the caller's
    // memberships in their other clinics.
    const rows = await inOrg(req, () => Membership.findAll({
      where: { organizationId: req.ctx!.org!.id },
      include: [{ model: User, as: 'user' }, { model: Role, as: 'role' }],
      order: [['createdAt', 'ASC']],
    }));
    const visible = rows.filter((m) => g.scope === 'org' || mine.length === 0 || m.branchIds.length === 0 || m.branchIds.some((b) => mine.includes(b)));
    res.json({
      items: visible.map((m) => {
        const u = (m as unknown as { user: User }).user;
        const role = (m as unknown as { role: Role }).role;
        return { id: m.id, userId: m.userId, fullName: u.fullName, email: u.email, phone: u.phoneE164, roleId: m.roleId, roleKey: role.key, roleName: role.name, branchIds: m.branchIds, status: m.status };
      }),
    });
  });

  /** Checks a role can be handed out by this member. Only owners create owners and branch managers. */
  async function assertAssignable(req: Request, roleId: string, branchIds: string[]) {
    const role = await Role.findByPk(roleId);
    if (!role || (role.organizationId && role.organizationId !== req.ctx!.org!.id)) throw new HttpError(400, 'validation_failed', 'Unknown role');
    const g = grant(req, 'member:manage');
    if ((roleId === OWNER_ROLE_ID || roleId === BRANCH_MANAGER_ROLE_ID) && req.ctx!.org!.roleKey !== 'owner') {
      throw forbidden('Only an owner can give this role');
    }
    if (g.scope === 'branch') {
      const mine = req.ctx!.org!.branchIds;
      if (branchIds.length === 0 && mine.length) throw forbidden('Choose at least one of your branches');
      if (mine.length && branchIds.some((b) => !mine.includes(b))) throw forbidden('You can only add staff to your own branches');
    }
    if (branchIds.length) {
      const count = await Branch.count({ where: { id: branchIds } });
      if (count !== branchIds.length) throw new HttpError(400, 'validation_failed', 'Unknown branch');
    }
    return role;
  }

  r.post('/members', user, org, requirePermission('member:manage'), async (req, res) => {
    const body = parse(inviteMemberBody, req.body);
    const out = await inOrg(req, async () => {
      const role = await assertAssignable(req, body.roleId, body.branchIds);
      const or: Array<{ email: string } | { phoneE164: string }> = [];
      if (body.email) or.push({ email: body.email });
      if (body.phone) or.push({ phoneE164: body.phone });
      let u = await User.findOne({ where: { [Op.or]: or } });
      if (!u) {
        u = await User.create({ fullName: body.fullName, email: body.email ?? null, phoneE164: body.phone ?? null, passwordHash: null, lastLoginAt: null, lockedUntil: null, deletedAt: null });
      }
      if (await Membership.findOne({ where: { organizationId: req.ctx!.org!.id, userId: u.id } })) throw conflict('This person is already a member of this clinic');
      const m = await Membership.create({ organizationId: req.ctx!.org!.id, userId: u.id, roleId: role.id, branchIds: body.branchIds, status: 'invited', invitedBy: req.ctx!.userId });
      await auditFromReq(req, { action: 'member.invite', targetType: 'membership', targetId: m.id, details: { role: role.key } });
      // Delivering the invitation (SMS/WhatsApp/email) is added with messaging in Phase 7.
      return { id: m.id, userId: u.id, roleKey: role.key, status: m.status };
    });
    res.status(201).json(out);
  });

  r.patch('/members/:id', user, org, requirePermission('member:manage'), async (req, res) => {
    const body = parse(updateMemberBody, req.body);
    const id = String(req.params.id);
    const out = await inOrg(req, async () => {
      const m = await Membership.findOne({ where: { id, organizationId: req.ctx!.org!.id } });
      if (!m) throw notFound('Member not found');
      if (m.userId === req.ctx!.userId) throw forbidden('You cannot change your own access');
      if (m.roleId === OWNER_ROLE_ID && req.ctx!.org!.roleKey !== 'owner') throw forbidden('Only an owner can change another owner');
      const nextRole = body.roleId ?? m.roleId;
      const nextBranches = body.branchIds ?? m.branchIds;
      if (body.roleId || body.branchIds) await assertAssignable(req, nextRole, nextBranches);
      const losingOwner = m.roleId === OWNER_ROLE_ID && (nextRole !== OWNER_ROLE_ID || (body.status && body.status !== 'active'));
      if (losingOwner) {
        const owners = await Membership.count({ where: { organizationId: req.ctx!.org!.id, roleId: OWNER_ROLE_ID, status: 'active' } });
        if (owners <= 1) throw conflict('A clinic needs at least one active owner');
      }
      await m.update({ roleId: nextRole, branchIds: nextBranches, ...(body.status ? { status: body.status } : {}) });
      await auditFromReq(req, { action: 'member.update', targetType: 'membership', targetId: m.id, details: body });
      return { id: m.id, roleId: m.roleId, branchIds: m.branchIds, status: m.status };
    });
    res.json(out);
  });

  // ---------- audit ----------
  r.get('/audit', user, org, requirePermission('audit:read'), async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const rows = await inOrg(req, () => AuditLog.findAll({
      where: { organizationId: req.ctx!.org!.id },
      order: [['id', 'DESC']],
      limit,
    }));
    res.json({ items: rows.map((a) => ({ id: Number(a.id), action: a.action, actorKind: a.actorKind, actorId: a.actorId, targetType: a.targetType, targetId: a.targetId, details: a.details, occurredAt: a.occurredAt })) });
  });

  return r;
}
