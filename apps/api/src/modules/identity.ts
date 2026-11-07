import {
  loginBody, mfaEnrollBody, mfaVerifyBody, otpRequestBody, otpVerifyBody, phoneE164, refreshBody, registerBody,
  type LoginResult, type MeResponse, type TokenPair,
} from '@dr/contracts';
import { MfaFactor, Membership, Op, OtpChallenge, Organization, Role, Session, User, UniqueConstraintError } from '@dr/db';
import { Router, type Request } from 'express';
import { authenticator } from 'otplib';
import type { Deps } from '../context.js';
import { HttpError, conflict, unauthenticated } from '../errors.js';
import { audit } from '../lib/audit.js';
import { decrypt, encrypt, hmac, randomToken, safeEqual, sha256, sixDigitCode } from '../lib/crypto.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { ACCESS_TTL_SECONDS, REFRESH_TTL_DAYS, signAccess, signMfa, verifyMfa } from '../lib/tokens.js';
import { parse, requireUser } from '../middleware.js';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const OTP_TTL_MS = 5 * 60_000;
const OTP_MAX_PER_15_MIN = 5;
const OTP_MAX_ATTEMPTS = 5;

authenticator.options = { window: 1 }; // accept the previous and next 30-second code

export function identityRouter(deps: Deps): Router {
  const { config, db, sms } = deps;
  const r = Router();
  const ipHash = (req: Request) => hmac(config.pepper, req.ip ?? '');

  /** Sets the row-level-security context inside the current transaction. */
  const setCtx = (orgId: string, userId: string) =>
    db.sequelize.query("SELECT set_config('app.org_id', :orgId, true), set_config('app.user_id', :userId, true)", { replacements: { orgId, userId } });

  /** Creates a session and returns the token pair. */
  async function issueSession(userId: string, req: Request, opts: { mfaVerified: boolean; deviceLabel?: string }): Promise<TokenPair> {
    const refreshToken = randomToken(32);
    const session = await Session.create({
      userId,
      patientId: null,
      refreshTokenHash: sha256(refreshToken),
      deviceLabel: opts.deviceLabel ?? null,
      ipHash: ipHash(req),
      trustedUntil: null,
      expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000),
      revokedAt: null,
      lastOrganizationId: null,
      mfaVerifiedAt: opts.mfaVerified ? new Date() : null,
    });
    // Invitations become active once the invited person has signed in themselves.
    // Each update runs with that clinic's context, because memberships are tenant-isolated.
    await setCtx('', userId);
    const invited = await Membership.findAll({ where: { userId, status: 'invited' } });
    for (const m of invited) {
      await setCtx(m.organizationId, userId);
      await Membership.update({ status: 'active' }, { where: { id: m.id } });
      await audit({ action: 'member.activated', organizationId: m.organizationId, actorId: userId, targetType: 'membership', targetId: m.id });
    }
    await setCtx('', userId);
    const accessToken = await signAccess(config.jwtKey, { sub: userId, sid: session.id });
    return { accessToken, accessTokenExpiresIn: ACCESS_TTL_SECONDS, refreshToken };
  }

  /** After the first factor: either issue a session, or ask for the authenticator code. */
  async function afterFirstFactor(user: User, req: Request, amr: 'pwd' | 'otp', deviceLabel?: string): Promise<LoginResult> {
    await setCtx('', user.id); // lets this transaction read the user's own memberships
    const memberships = await Membership.findAll({ where: { userId: user.id, status: { [Op.in]: ['active', 'invited'] } } });
    const roles = memberships.length ? await Role.findAll({ where: { id: memberships.map((m) => m.roleId) } }) : [];
    const needsMfa = user.isPlatformAdmin || roles.some((r) => r.requiresMfa);
    const factor = await MfaFactor.findOne({ where: { userId: user.id, kind: 'totp', verifiedAt: { [Op.ne]: null } } });
    if (needsMfa || factor) {
      return { status: 'mfa_required', mfaToken: await signMfa(config.jwtKey, { sub: user.id, amr, deviceLabel }), enrolled: !!factor };
    }
    return { status: 'ok', ...(await issueSession(user.id, req, { mfaVerified: false, deviceLabel })) };
  }

  // ---- register: a new staff account (it joins or creates a clinic afterwards) ----
  r.post('/register', async (req, res) => {
    const body = parse(registerBody, req.body);
    const result = await db.withContext({}, async () => {
      const existing = await User.findOne({ where: { [Op.or]: [{ email: body.email }, { phoneE164: body.phone }] } });
      if (existing) throw conflict('An account with this email or mobile number already exists. Sign in instead.');
      try {
        const user = await User.create({
          fullName: body.fullName, email: body.email, phoneE164: body.phone,
          passwordHash: await hashPassword(body.password), lastLoginAt: new Date(), lockedUntil: null, deletedAt: null,
        });
        await audit({ action: 'user.register', actorId: user.id, targetType: 'user', targetId: user.id, ipHash: ipHash(req) });
        await setCtx('', user.id);
        return { status: 'ok' as const, ...(await issueSession(user.id, req, { mfaVerified: false })) };
      } catch (e) {
        if (e instanceof UniqueConstraintError) throw conflict('An account with this email or mobile number already exists.');
        throw e;
      }
    });
    res.status(201).json(result);
  });

  // ---- password sign-in ----
  r.post('/login', async (req, res) => {
    const body = parse(loginBody, req.body);
    const id = body.identifier.includes('@') ? { email: body.identifier.toLowerCase() } : (() => {
      const p = phoneE164.safeParse(body.identifier);
      return p.success ? { phoneE164: p.data } : null;
    })();
    const result = await db.withContext({}, async () => {
      const user = id ? await User.findOne({ where: { ...id, deletedAt: null } }) : null;
      if (user?.lockedUntil && user.lockedUntil > new Date()) {
        throw new HttpError(423, 'account_locked', `Too many attempts. Try again after ${LOCK_MINUTES} minutes, or sign in with a one-time code.`);
      }
      const ok = await verifyPassword(user?.passwordHash ?? null, body.password);
      if (!user || !ok) {
        if (user) {
          const failed = user.failedLoginCount + 1;
          await user.update({
            failedLoginCount: failed >= MAX_FAILED_LOGINS ? 0 : failed,
            lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
          });
          await audit({ action: 'auth.login_failed', actorId: user.id, targetType: 'user', targetId: user.id, ipHash: ipHash(req) });
        }
        return null;
      }
      await user.update({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() });
      await audit({ action: 'auth.login', actorId: user.id, targetType: 'user', targetId: user.id, details: { method: 'password' }, ipHash: ipHash(req) });
      return afterFirstFactor(user, req, 'pwd', body.deviceLabel);
    });
    // Failed attempts are committed above; the error is thrown after the transaction.
    if (!result) throw new HttpError(401, 'invalid_credentials', 'Email, mobile number or password is wrong');
    res.json(result);
  });

  // ---- one-time code by SMS ----
  r.post('/otp', async (req, res) => {
    const { phone } = parse(otpRequestBody, req.body);
    await db.withContext({}, async () => {
      const recent = await OtpChallenge.count({ where: { phoneE164: phone, purpose: 'login', createdAt: { [Op.gt]: new Date(Date.now() - 15 * 60_000) } } });
      if (recent >= OTP_MAX_PER_15_MIN) throw new HttpError(429, 'otp_rate_limited', 'Too many codes requested. Wait 15 minutes.');
      const user = await User.findOne({ where: { phoneE164: phone, deletedAt: null } });
      if (!user) return; // same response either way, so numbers can't be probed
      const code = sixDigitCode();
      await OtpChallenge.create({ phoneE164: phone, purpose: 'login', codeHash: hmac(config.pepper, phone, code), expiresAt: new Date(Date.now() + OTP_TTL_MS), consumedAt: null });
      await sms.sendOtp(phone, code, 'login');
    });
    res.status(202).json({ status: 'sent_if_registered', expiresInSeconds: OTP_TTL_MS / 1000 });
  });

  r.post('/otp/verify', async (req, res) => {
    const body = parse(otpVerifyBody, req.body);
    const result = await db.withContext({}, async () => {
      const ch = await OtpChallenge.findOne({
        where: { phoneE164: body.phone, purpose: 'login', consumedAt: null, expiresAt: { [Op.gt]: new Date() } },
        order: [['createdAt', 'DESC']],
      });
      if (!ch || ch.attempts >= OTP_MAX_ATTEMPTS) return null;
      if (!safeEqual(ch.codeHash, hmac(config.pepper, body.phone, body.code))) {
        await ch.update({ attempts: ch.attempts + 1 });
        return null;
      }
      await ch.update({ consumedAt: new Date() });
      const user = await User.findOne({ where: { phoneE164: body.phone, deletedAt: null } });
      if (!user) return null;
      await user.update({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() });
      await audit({ action: 'auth.login', actorId: user.id, targetType: 'user', targetId: user.id, details: { method: 'otp' }, ipHash: ipHash(req) });
      return afterFirstFactor(user, req, 'otp', body.deviceLabel);
    });
    if (!result) throw new HttpError(401, 'otp_invalid', 'That code is wrong or has expired');
    res.json(result);
  });

  // ---- second factor: authenticator app (TOTP) ----
  async function userFromMfaToken(token: string): Promise<{ userId: string; deviceLabel?: string }> {
    const v = await verifyMfa(config.jwtKey, token);
    if (!v.ok) throw new HttpError(401, v.expired ? 'session_expired' : 'unauthenticated', 'Start signing in again');
    return { userId: v.claims.sub, deviceLabel: v.claims.deviceLabel };
  }

  r.post('/mfa/verify', async (req, res) => {
    const body = parse(mfaVerifyBody, req.body);
    const { userId, deviceLabel } = await userFromMfaToken(body.mfaToken);
    const tokens = await db.withContext({ userId }, async () => {
      const factor = await MfaFactor.findOne({ where: { userId, kind: 'totp', verifiedAt: { [Op.ne]: null } } });
      if (!factor) throw new HttpError(403, 'mfa_enrollment_required', 'Set up an authenticator app first');
      if (!authenticator.check(body.code, decrypt(config.dataKey, factor.secretEnc))) return null;
      await audit({ action: 'auth.mfa_verified', actorId: userId, targetType: 'user', targetId: userId, ipHash: ipHash(req) });
      return issueSession(userId, req, { mfaVerified: true, deviceLabel });
    });
    if (!tokens) throw new HttpError(401, 'mfa_invalid', 'That code is wrong. Use the current code from your app.');
    res.json({ status: 'ok', ...tokens });
  });

  /**
   * Enrolment works two ways: during sign-in (mfaToken from the first factor) or from a
   * signed-in session (for example after creating a clinic, which makes you an owner).
   */
  async function enrolmentUser(req: Request): Promise<{ userId: string; deviceLabel?: string; viaSession?: string }> {
    if (req.body?.mfaToken) return userFromMfaToken(parse(mfaEnrollBody, req.body).mfaToken);
    await new Promise<void>((resolve, reject) => requireUser(deps)(req, {} as never, (e?: unknown) => (e ? reject(e) : resolve())));
    return { userId: req.ctx!.userId, viaSession: req.ctx!.sessionId };
  }

  r.post('/mfa/enroll/start', async (req, res) => {
    const { userId } = await enrolmentUser(req);
    const out = await db.withContext({ userId }, async () => {
      const user = await User.findByPk(userId);
      if (!user) throw unauthenticated();
      const done = await MfaFactor.findOne({ where: { userId, kind: 'totp', verifiedAt: { [Op.ne]: null } } });
      if (done) throw conflict('An authenticator app is already set up');
      await MfaFactor.destroy({ where: { userId, kind: 'totp', verifiedAt: null } });
      const secret = authenticator.generateSecret(20);
      await MfaFactor.create({ userId, kind: 'totp', secretEnc: encrypt(config.dataKey, secret), verifiedAt: null });
      return { secret, otpauthUrl: authenticator.keyuri(user.email ?? user.phoneE164 ?? user.id, 'DocReceptionist', secret) };
    });
    res.json(out);
  });

  r.post('/mfa/enroll/confirm', async (req, res) => {
    const code = parse(mfaVerifyBody.shape.code, req.body?.code);
    const who = await enrolmentUser(req);
    const result = await db.withContext({ userId: who.userId }, async () => {
      const pending = await MfaFactor.findOne({ where: { userId: who.userId, kind: 'totp', verifiedAt: null }, order: [['createdAt', 'DESC']] });
      if (!pending) throw new HttpError(400, 'mfa_enrollment_required', 'Start setup again');
      if (!authenticator.check(code, decrypt(config.dataKey, pending.secretEnc))) return null;
      await pending.update({ verifiedAt: new Date() });
      await audit({ action: 'auth.mfa_enrolled', actorId: who.userId, targetType: 'user', targetId: who.userId, ipHash: ipHash(req) });
      if (who.viaSession) {
        await Session.update({ mfaVerifiedAt: new Date() }, { where: { id: who.viaSession } });
        return { status: 'ok' as const };
      }
      return { status: 'ok' as const, ...(await issueSession(who.userId, req, { mfaVerified: true, deviceLabel: who.deviceLabel })) };
    });
    if (!result) throw new HttpError(401, 'mfa_invalid', 'That code is wrong. Use the current code from your app.');
    res.json(result);
  });

  // ---- refresh (rotating) and sign-out ----
  r.post('/refresh', async (req, res) => {
    const { refreshToken } = parse(refreshBody, req.body);
    const tokens = await db.withContext({}, async () => {
      const s = await Session.findOne({ where: { refreshTokenHash: sha256(refreshToken), revokedAt: null } });
      if (!s || !s.userId || s.expiresAt < new Date()) return null;
      const next = randomToken(32);
      await s.update({ refreshTokenHash: sha256(next) });
      return { accessToken: await signAccess(config.jwtKey, { sub: s.userId, sid: s.id }), accessTokenExpiresIn: ACCESS_TTL_SECONDS, refreshToken: next };
    });
    if (!tokens) throw new HttpError(401, 'session_expired', 'Your session ended. Sign in again.');
    res.json(tokens);
  });

  r.post('/logout', requireUser(deps), async (req, res) => {
    await db.withContext({ userId: req.ctx!.userId }, async () => {
      await Session.update({ revokedAt: new Date() }, { where: { id: req.ctx!.sessionId } });
      await audit({ action: 'auth.logout', actorId: req.ctx!.userId, ipHash: req.ctx!.ip });
    });
    res.status(204).end();
  });

  return r;
}

/** GET /v1/me: who am I, and which clinics can I switch to. */
export function meRouter(deps: Deps): Router {
  const r = Router();
  r.get('/', requireUser(deps), async (req, res) => {
    const userId = req.ctx!.userId;
    const body = await deps.db.withContext({ userId }, async (): Promise<MeResponse> => {
      const user = await User.findByPk(userId);
      if (!user) throw unauthenticated();
      const memberships = await Membership.findAll({
        where: { userId, status: { [Op.in]: ['active', 'invited'] } },
        include: [{ model: Organization, as: 'organization' }, { model: Role, as: 'role' }],
        order: [['createdAt', 'ASC']],
      });
      const factor = await MfaFactor.findOne({ where: { userId, kind: 'totp', verifiedAt: { [Op.ne]: null } } });
      return {
        user: { id: user.id, fullName: user.fullName, email: user.email, phone: user.phoneE164, mfaEnrolled: !!factor },
        memberships: memberships.map((m) => {
          const org = (m as unknown as { organization: Organization }).organization;
          const role = (m as unknown as { role: Role | null }).role;
          return { organizationId: m.organizationId, organizationName: org.name, roleKey: role?.key ?? 'unknown', roleName: role?.name ?? 'Unknown', status: m.status };
        }),
      };
    });
    res.json({ ...body, session: { mfaVerified: req.ctx!.mfaVerified } });
  });
  return r;
}
