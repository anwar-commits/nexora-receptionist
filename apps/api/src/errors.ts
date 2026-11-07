import type { ErrorCode } from '@dr/contracts';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const unauthenticated = (msg = 'Sign in to continue') => new HttpError(401, 'unauthenticated', msg);
export const forbidden = (msg = 'You do not have permission to do this') => new HttpError(403, 'permission_denied', msg);
export const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);
