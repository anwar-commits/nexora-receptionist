import { SignJWT, jwtVerify, errors } from 'jose';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const MFA_TTL_SECONDS = 5 * 60;
export const REFRESH_TTL_DAYS = 30;

const ISSUER = 'doc-receptionist';

export interface AccessClaims { sub: string; sid: string }
export interface MfaClaims { sub: string; amr: 'pwd' | 'otp'; deviceLabel?: string }

export async function signAccess(key: Uint8Array, c: AccessClaims): Promise<string> {
  return new SignJWT({ sid: c.sid, typ: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(key);
}

export async function signMfa(key: Uint8Array, c: MfaClaims): Promise<string> {
  return new SignJWT({ typ: 'mfa', amr: c.amr, dl: c.deviceLabel })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${MFA_TTL_SECONDS}s`)
    .sign(key);
}

export type VerifyResult<T> = { ok: true; claims: T } | { ok: false; expired: boolean };

async function verify(key: Uint8Array, token: string, typ: 'access' | 'mfa') {
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: ['HS256'] });
    if (payload.typ !== typ || typeof payload.sub !== 'string') return { ok: false as const, expired: false };
    return { ok: true as const, payload };
  } catch (e) {
    return { ok: false as const, expired: e instanceof errors.JWTExpired };
  }
}

export async function verifyAccess(key: Uint8Array, token: string): Promise<VerifyResult<AccessClaims>> {
  const r = await verify(key, token, 'access');
  if (!r.ok || typeof r.payload.sid !== 'string') return { ok: false, expired: r.ok ? false : r.expired };
  return { ok: true, claims: { sub: r.payload.sub!, sid: r.payload.sid } };
}

export async function verifyMfa(key: Uint8Array, token: string): Promise<VerifyResult<MfaClaims>> {
  const r = await verify(key, token, 'mfa');
  if (!r.ok) return r;
  const amr = r.payload.amr === 'otp' ? 'otp' : 'pwd';
  const dl = typeof r.payload.dl === 'string' ? r.payload.dl : undefined;
  return { ok: true, claims: { sub: r.payload.sub!, amr, deviceLabel: dl } };
}
