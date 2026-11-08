import type { ApiError, LoginResult, TokenPair } from '@dr/contracts';

/**
 * Small typed fetch client. The access token lives in memory only; the refresh token is
 * kept in localStorage so a reload keeps you signed in (see docs/decisions.md: moving
 * the web refresh token to an httpOnly cookie is planned for Phase 15).
 */
const REFRESH_KEY = 'dr.refresh';
const ORG_KEY = 'dr.org';

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

export class ApiRequestError extends Error {
  constructor(public status: number, public error: ApiError) {
    super(error.message);
  }
}

export const session = {
  get signedIn() { return !!accessToken; },
  get hasRefresh() { return !!localStorage.getItem(REFRESH_KEY); },
  get orgId() { return localStorage.getItem(ORG_KEY); },
  setOrg(id: string | null) {
    if (id) localStorage.setItem(ORG_KEY, id);
    else localStorage.removeItem(ORG_KEY);
    listeners.forEach((l) => l());
  },
  store(t: TokenPair) {
    accessToken = t.accessToken;
    localStorage.setItem(REFRESH_KEY, t.refreshToken);
    listeners.forEach((l) => l());
  },
  clear() {
    accessToken = null;
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(ORG_KEY);
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
};

async function refresh(): Promise<boolean> {
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return false;
  refreshing ??= (async () => {
    try {
      const res = await fetch('/v1/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken }) });
      if (!res.ok) { session.clear(); return false; }
      session.store(await res.json());
      return true;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; org?: boolean } = {}): Promise<T> {
  const doFetch = () => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (init.org !== false && session.orgId) headers['X-Org-Id'] = session.orgId;
    return fetch(`/v1${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  };
  let res = await doFetch();
  if (res.status === 401 && (await refresh())) res = await doFetch();
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({ error: { code: 'internal', message: 'Unexpected response' } }));
  if (!res.ok) throw new ApiRequestError(res.status, json.error);
  return json as T;
}

/** Binary download (e.g. a call recording) with the same auth headers. */
export async function apiBlob(path: string): Promise<Blob> {
  const doFetch = () => {
    const headers: Record<string, string> = {};
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (session.orgId) headers['X-Org-Id'] = session.orgId;
    return fetch(`/v1${path}`, { headers });
  };
  let res = await doFetch();
  if (res.status === 401 && (await refresh())) res = await doFetch();
  if (!res.ok) {
    const json = await res.json().catch(() => ({ error: { code: 'internal', message: 'Could not load the file' } }));
    throw new ApiRequestError(res.status, json.error);
  }
  return res.blob();
}

/** Restores a session after a page reload using the stored refresh token. */
export const restore = () => (accessToken ? Promise.resolve(true) : refresh());

export const auth = {
  login: (identifier: string, password: string) => api<LoginResult>('/auth/login', { method: 'POST', body: { identifier, password, deviceLabel: 'Web' }, org: false }),
  requestOtp: (phone: string) => api<{ status: string }>('/auth/otp', { method: 'POST', body: { phone }, org: false }),
  verifyOtp: (phone: string, code: string) => api<LoginResult>('/auth/otp/verify', { method: 'POST', body: { phone, code, deviceLabel: 'Web' }, org: false }),
  verifyMfa: (mfaToken: string, code: string) => api<TokenPair & { status: 'ok' }>('/auth/mfa/verify', { method: 'POST', body: { mfaToken, code }, org: false }),
  enrollStart: (mfaToken?: string) => api<{ secret: string; otpauthUrl: string }>('/auth/mfa/enroll/start', { method: 'POST', body: mfaToken ? { mfaToken } : {}, org: false }),
  enrollConfirm: (code: string, mfaToken?: string) => api<{ status: 'ok' } & Partial<TokenPair>>('/auth/mfa/enroll/confirm', { method: 'POST', body: mfaToken ? { mfaToken, code } : { code }, org: false }),
  register: (body: unknown) => api<LoginResult>('/auth/register', { method: 'POST', body, org: false }),
  logout: () => api<void>('/auth/logout', { method: 'POST', org: false }),
};
