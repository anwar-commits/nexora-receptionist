import { z } from 'zod';

/**
 * Request and response contracts shared by the API, web app and mobile app.
 * The API validates every body with these; clients use the inferred types.
 */

/** Indian mobile numbers normalised to E.164; other countries allowed with a leading +. */
export const phoneE164 = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .transform((v) => (/^[6-9]\d{9}$/.test(v) ? `+91${v}` : v))
  .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, 'Enter a valid mobile number'));

export const password = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200)
  .refine((v) => /[a-zA-Z]/.test(v) && /\d/.test(v), 'Use letters and numbers');

export const otpCode = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');
export const uuid = z.string().uuid();

// ---------- auth ----------
export const registerBody = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  phone: phoneE164,
  password,
});
export type RegisterBody = z.infer<typeof registerBody>;

export const loginBody = z.object({
  identifier: z.string().trim().min(3).max(200), // email or mobile number
  password: z.string().min(1).max(200),
  deviceLabel: z.string().max(80).optional(),
});
export type LoginBody = z.infer<typeof loginBody>;

export const otpRequestBody = z.object({ phone: phoneE164 });
export const otpVerifyBody = z.object({ phone: phoneE164, code: otpCode, deviceLabel: z.string().max(80).optional() });
export const mfaVerifyBody = z.object({ mfaToken: z.string().min(20), code: otpCode });
export const mfaEnrollBody = z.object({ mfaToken: z.string().min(20) });
export const refreshBody = z.object({ refreshToken: z.string().min(20) });

/** What a successful sign-in returns once MFA (if required) is done. */
export interface TokenPair {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
}
/** Sign-in step result: either tokens, or a short-lived token to finish MFA. */
export type LoginResult =
  | ({ status: 'ok' } & TokenPair)
  | { status: 'mfa_required'; mfaToken: string; enrolled: boolean };

// ---------- organizations ----------
export const createOrganizationBody = z.object({
  name: z.string().trim().min(2).max(120),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  addressLine: z.string().trim().min(3).max(200),
  pincode: z.string().regex(/^\d{6}$/).optional(),
  specialities: z.array(z.string().trim().min(2).max(60)).max(20).default([]),
  languages: z.array(z.enum(['en', 'hi', 'bn', 'ur', 'bho', 'mai'])).min(1).default(['en', 'hi']),
});
export type CreateOrganizationBody = z.infer<typeof createOrganizationBody>;

export const updateOrganizationBody = createOrganizationBody
  .pick({ name: true, specialities: true, languages: true })
  .extend({ legalName: z.string().max(200).nullable(), gstin: z.string().regex(/^[0-9A-Z]{15}$/).nullable() })
  .partial();

export const branchBody = z.object({
  name: z.string().trim().min(2).max(120),
  addressLine: z.string().trim().min(3).max(200),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  pincode: z.string().regex(/^\d{6}$/).nullable().optional(),
  phone: phoneE164.nullable().optional(),
  openingHours: z
    .record(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']), z.array(z.tuple([z.string().regex(/^\d\d:\d\d$/), z.string().regex(/^\d\d:\d\d$/)])))
    .optional(),
});
export const updateBranchBody = branchBody.partial().extend({ isActive: z.boolean().optional() });

export const departmentBody = z.object({ name: z.string().trim().min(2).max(80), code: z.string().max(20).nullable().optional() });

// ---------- members ----------
export const builtinRoleKey = z.enum(['owner', 'branch_manager', 'doctor', 'receptionist', 'counsellor', 'ai_ops', 'staff']);
export const inviteMemberBody = z
  .object({
    fullName: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email().optional(),
    phone: phoneE164.optional(),
    roleId: uuid,
    branchIds: z.array(uuid).max(50).default([]),
  })
  .refine((v) => v.email || v.phone, { message: 'Give an email or a mobile number', path: ['email'] });
export const updateMemberBody = z.object({
  roleId: uuid.optional(),
  branchIds: z.array(uuid).max(50).optional(),
  status: z.enum(['active', 'suspended', 'removed']).optional(),
});

// ---------- errors ----------
export type ErrorCode =
  | 'validation_failed'
  | 'invalid_credentials'
  | 'account_locked'
  | 'otp_invalid'
  | 'otp_rate_limited'
  | 'mfa_invalid'
  | 'mfa_enrollment_required'
  | 'unauthenticated'
  | 'session_expired'
  | 'organization_required'
  | 'not_a_member'
  | 'permission_denied'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'internal';
export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

// ---------- read models ----------
export interface MembershipSummary {
  organizationId: string;
  organizationName: string;
  roleKey: string;
  roleName: string;
  status: string;
}
export interface MeResponse {
  user: { id: string; fullName: string; email: string | null; phone: string | null; mfaEnrolled: boolean };
  memberships: MembershipSummary[];
}
