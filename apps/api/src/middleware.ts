import { Membership, Role, RolePermission, Session } from '@dr/db';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';
import type { Deps, Grant, Scope } from './context.js';
import { HttpError, forbidden, unauthenticated } from './errors.js';
import { hmac } from './lib/crypto.js';
import { verifyAccess } from './lib/tokens.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new HttpError(400, 'validation_failed', 'Some fields need attention',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

/** Verifies the bearer access token and that its session is still live. */
export function requireUser(deps: Deps): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw unauthenticated();
    const v = await verifyAccess(deps.config.jwtKey, token);
    if (!v.ok) throw new HttpError(401, v.expired ? 'session_expired' : 'unauthenticated', v.expired ? 'Your session expired' : 'Sign in to continue');
    const session = await deps.db.withContext({ userId: v.claims.sub }, () => Session.findByPk(v.claims.sid));
    if (!session || session.userId !== v.claims.sub || session.revokedAt || session.expiresAt < new Date()) {
      throw new HttpError(401, 'session_expired', 'Your session ended. Sign in again.');
    }
    req.ctx = {
      userId: v.claims.sub,
      sessionId: session.id,
      mfaVerified: !!session.mfaVerifiedAt,
      ip: hmac(deps.config.pepper, req.ip ?? ''),
    };
    next();
  };
}

/**
 * Resolves the clinic named in X-Org-Id: the user must hold an active membership there.
 * Loads the role's grants. Roles that require MFA are refused until the session completed MFA.
 */
export function requireOrg(deps: Deps): RequestHandler {
  return async (req, _res, next) => {
    const ctx = req.ctx;
    if (!ctx) throw unauthenticated();
    const orgId = String(req.headers['x-org-id'] ?? '');
    if (!UUID.test(orgId)) throw new HttpError(400, 'organization_required', 'Choose a clinic first (X-Org-Id header)');

    const found = await deps.db.withContext({ orgId, userId: ctx.userId }, async () => {
      const m = await Membership.findOne({ where: { organizationId: orgId, userId: ctx.userId, status: 'active' } });
      if (!m) return null;
      const role = await Role.findByPk(m.roleId);
      const perms = await RolePermission.findAll({ where: { roleId: m.roleId } });
      await Session.update({ lastOrganizationId: orgId }, { where: { id: ctx.sessionId } });
      return { m, role, perms };
    });
    if (!found || !found.role) throw new HttpError(403, 'not_a_member', 'You are not a member of this clinic');
    if (found.role.requiresMfa && !ctx.mfaVerified) {
      throw new HttpError(403, 'mfa_enrollment_required', 'Your role needs two-step verification. Set up an authenticator app to continue.');
    }
    const grants = new Map<string, Grant>();
    for (const p of found.perms) {
      if (p.scope !== 'none') grants.set(p.permissionKey, { scope: p.scope as Scope, limit: p.limitValue === null ? null : Number(p.limitValue) });
    }
    ctx.org = {
      id: orgId,
      membershipId: found.m.id,
      roleId: found.role.id,
      roleKey: found.role.key,
      branchIds: found.m.branchIds ?? [],
      grants,
    };
    next();
  };
}

/** Allows the request only if the member's role grants the permission (at any scope). */
export function requirePermission(key: string): RequestHandler {
  return (req, _res, next) => {
    if (!req.ctx?.org?.grants.has(key)) throw forbidden();
    next();
  };
}

export function grant(req: Request, key: string): Grant {
  const g = req.ctx?.org?.grants.get(key);
  if (!g) throw forbidden();
  return g;
}

export function errorHandler(deps: Deps) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed' || e?.type === 'entity.too.large') {
      res.status(e.status ?? 400).json({ error: { code: 'validation_failed', message: 'Request body could not be read' } });
      return;
    }
    deps.log.error({ err, path: req.path }, 'unhandled error');
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong on our side' } });
  };
}
