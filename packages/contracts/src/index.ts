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
/** Languages the AI receptionist can be set up for. hi-Latn is Hinglish (Hindi in Roman script); bho (Bhojpuri) is beta. */
export const LANGUAGES = { en: 'English', hi: 'Hindi', 'hi-Latn': 'Hinglish', bn: 'Bengali', ur: 'Urdu', bho: 'Bhojpuri (beta)', mai: 'Maithili' } as const;
export const languageCode = z.enum(['en', 'hi', 'hi-Latn', 'bn', 'ur', 'bho', 'mai']);

export const createOrganizationBody = z.object({
  name: z.string().trim().min(2).max(120),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  addressLine: z.string().trim().min(3).max(200),
  pincode: z.string().regex(/^\d{6}$/).optional(),
  specialities: z.array(z.string().trim().min(2).max(60)).max(20).default([]),
  languages: z.array(languageCode).min(1).default(['en', 'hi']),
});
export type CreateOrganizationBody = z.infer<typeof createOrganizationBody>;

export const updateOrganizationBody = createOrganizationBody
  .pick({ name: true, specialities: true, languages: true })
  .extend({ legalName: z.string().max(200).nullable(), gstin: z.string().regex(/^[0-9A-Z]{15}$/).nullable() })
  .partial();

/** "HH:MM", 24-hour. */
export const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour time, e.g. 09:30');
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
/** Clinic opening hours per weekday; each day is a list of [open, close] periods. A missing day is closed. */
export const openingHours = z
  .record(z.enum(WEEKDAYS), z.array(z.tuple([clockTime, clockTime])).max(4))
  .superRefine((v, ctx) => {
    for (const [day, periods] of Object.entries(v)) {
      const sorted = [...(periods ?? [])].sort((a, b) => a[0].localeCompare(b[0]));
      sorted.forEach(([open, close], i) => {
        if (close <= open) ctx.addIssue({ code: 'custom', path: [day], message: `${day}: closing time must be after opening time` });
        const next = sorted[i + 1];
        if (next && next[0] < close) ctx.addIssue({ code: 'custom', path: [day], message: `${day}: periods overlap` });
      });
    }
  });

export const branchBody = z.object({
  name: z.string().trim().min(2).max(120),
  addressLine: z.string().trim().min(3).max(200),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  pincode: z.string().regex(/^\d{6}$/).nullable().optional(),
  phone: phoneE164.nullable().optional(),
  openingHours: openingHours.optional(),
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

// ---------- clinic setup (Phase 4) ----------
export const consultMode = z.enum(['clinic', 'video', 'phone']);
export type ConsultMode = z.infer<typeof consultMode>;
/** Money is always integer paise on the wire. */
export const paise = z.number().int().min(0).max(100_000_000_00);

export const doctorBody = z.object({
  displayName: z.string().trim().min(2).max(120),
  userId: uuid.nullable().optional(),
  departmentId: uuid.nullable().optional(),
  qualifications: z.string().trim().max(200).nullable().optional(),
  registrationNumber: z.string().trim().max(60).nullable().optional(),
  registrationCouncil: z.string().trim().max(120).nullable().optional(),
  yearsExperience: z.number().int().min(0).max(70).nullable().optional(),
  languages: z.array(languageCode).min(1).default(['en', 'hi']),
  bioApproved: z.string().trim().max(1500).nullable().optional(),
  slotMinutes: z.number().int().min(5).max(240).default(20),
  bufferMinutes: z.number().int().min(0).max(120).default(5),
  maxOnlinePerDay: z.number().int().min(0).max(200).nullable().optional(),
  bookableByAi: z.boolean().default(true),
});
export const updateDoctorBody = doctorBody.partial().extend({ isActive: z.boolean().optional() });

export const scheduleRuleInput = z
  .object({
    weekday: z.number().int().min(0).max(6), // 0 = Monday
    start: clockTime,
    end: clockTime,
    mode: consultMode,
    branchId: uuid.nullable().default(null),
  })
  .refine((r) => r.end > r.start, { message: 'End time must be after start time', path: ['end'] })
  .refine((r) => (r.mode === 'clinic') === (r.branchId !== null), { message: 'Clinic sessions need a branch; video and phone sessions have none', path: ['branchId'] });
export const scheduleBody = z.object({ rules: z.array(scheduleRuleInput).max(60) });
export type ScheduleRuleInput = z.infer<typeof scheduleRuleInput>;

export const leaveBody = z
  .object({
    kind: z.enum(['leave', 'block']).default('leave'),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    reason: z.string().trim().max(200).nullable().optional(),
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), { message: 'End must be after start', path: ['endsAt'] });

export const serviceBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    departmentId: uuid.nullable().optional(),
    durationMinutes: z.number().int().min(5).max(720),
    /** null = "after assessment": the AI never says a number. */
    feePaise: paise.nullable(),
    aiMayQuoteFee: z.boolean().default(false),
    modes: z.array(consultMode).min(1).max(3).default(['clinic']),
  })
  .refine((v) => !v.aiMayQuoteFee || v.feePaise !== null, { message: 'The AI can only quote a fee that is set', path: ['aiMayQuoteFee'] });
export const updateServiceBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    departmentId: uuid.nullable(),
    durationMinutes: z.number().int().min(5).max(720),
    feePaise: paise.nullable(),
    aiMayQuoteFee: z.boolean(),
    modes: z.array(consultMode).min(1).max(3),
    isActive: z.boolean(),
  })
  .partial();

export const doctorServicesBody = z.object({
  items: z.array(z.object({ serviceId: uuid, feeOverridePaise: paise.nullable().default(null) })).max(100),
});

export const settingsBody = z
  .object({
    recordingEnabled: z.boolean(),
    transcriptEnabled: z.boolean(),
    recordingRetentionDays: z.number().int().min(0).max(3650),
    transcriptRetentionDays: z.number().int().min(30).max(3650),
    aiPickupMode: z.enum(['always', 'after_ring', 'after_hours']),
    aiPickupAfterSeconds: z.number().int().min(5).max(90),
    outboundStartLocal: clockTime,
    outboundEndLocal: clockTime,
    refundLimitReceptionistPaise: paise,
    prepayPolicy: z.enum(['always', 'video_only', 'never']),
    cancellationPolicyText: z.string().trim().max(1000).nullable(),
    freeCancellationHours: z.number().int().min(0).max(168),
    phoneSetupChoice: z.enum(['forward_existing', 'new_number', 'later']),
  })
  .partial()
  .refine((v) => !v.outboundStartLocal || !v.outboundEndLocal || v.outboundEndLocal > v.outboundStartLocal, {
    message: 'The calling window must end after it starts', path: ['outboundEndLocal'],
  });

export const holidayBody = z.object({
  onDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  name: z.string().trim().min(2).max(80),
  branchId: uuid.nullable().default(null),
});

export type OnboardingStepKey = 'clinic' | 'branches' | 'doctors' | 'services' | 'phone' | 'review';
export interface OnboardingStatus {
  steps: { key: OnboardingStepKey; title: string; done: boolean; missing: string[] }[];
  completedAt: string | null;
  canComplete: boolean;
}

// ---------- patients and appointments (Phase 5) ----------
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const patientBody = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: phoneE164,
  dateOfBirth: isoDate.nullable().optional(),
  sex: z.enum(['female', 'male', 'other', 'unknown']).nullable().optional(),
  preferredLanguage: languageCode.default('hi'),
  homeBranchId: uuid.nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  acquisitionSource: z.string().trim().max(80).nullable().optional(),
});
export const updatePatientBody = patientBody.partial();

export const availabilityQuery = z.object({
  doctorId: uuid,
  serviceId: uuid,
  mode: consultMode,
  branchId: uuid.optional(),
  from: isoDate,
  days: z.coerce.number().int().min(1).max(14).default(7),
});

const slotTarget = {
  doctorId: uuid,
  serviceId: uuid,
  mode: consultMode,
  branchId: uuid.nullable().default(null),
  start: z.string().datetime({ offset: true }),
};

export const holdBody = z.object(slotTarget);

export const bookBody = z.object({
  ...slotTarget,
  patientProfileId: uuid,
  reasonText: z.string().trim().max(500).nullable().optional(),
  holdId: uuid.optional(),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});

export const rescheduleBody = z.object({
  start: z.string().datetime({ offset: true }),
  doctorId: uuid.optional(),
  mode: consultMode.optional(),
  branchId: uuid.nullable().optional(),
  reason: z.string().trim().max(200).optional(),
});

export const cancelBody = z.object({ reason: z.string().trim().min(3).max(300) });

export const APPOINTMENT_STATUSES = ['booked', 'confirmed', 'checked_in', 'in_consultation', 'completed', 'cancelled', 'no_show', 'rescheduled'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
export const statusBody = z.object({ status: z.enum(['confirmed', 'checked_in', 'in_consultation', 'completed', 'no_show']) });

export const appointmentListQuery = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  doctorId: uuid.optional(),
  branchId: uuid.optional(),
  patientProfileId: uuid.optional(),
  includeInactive: z.enum(['0', '1']).default('1'),
});

export interface AppointmentView {
  id: string; start: string; end: string; status: AppointmentStatus; mode: ConsultMode; branchId: string | null;
  doctorId: string; doctorName: string; serviceId: string; serviceName: string; feePaise: number | null;
  patient: { profileId: string; mrn: string; fullName: string };
  reasonText: string | null; bookedByKind: string; cancelledReason: string | null; rescheduledFrom: string | null; createdAt: string;
}
export interface SlotView { start: string; end: string; branchId: string | null; mode: ConsultMode }

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
