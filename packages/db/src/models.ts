import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

/**
 * Sequelize models for identity, tenancy and audit (Phase 3) and clinic setup (Phase 4).
 * The schema itself is owned by the SQL migrations; models never sync().
 * Other domains get their models in the phase that builds them.
 */
const common = { schema: 'app', underscored: true, freezeTableName: true } as const;
const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

export class Organization extends Model<InferAttributes<Organization>, InferCreationAttributes<Organization>> {
  declare id: CreationOptional<string>;
  declare name: string;
  declare slug: string;
  declare legalName: string | null;
  declare gstin: string | null;
  declare status: CreationOptional<'trial' | 'active' | 'past_due' | 'paused' | 'closed'>;
  declare specialities: CreationOptional<string[]>;
  declare languages: CreationOptional<string[]>;
  declare timezone: CreationOptional<string>;
  declare dataRegion: CreationOptional<string>;
  declare logoUrl: string | null;
  declare trialEndsAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;
}

export class OrganizationSettings extends Model<InferAttributes<OrganizationSettings>, InferCreationAttributes<OrganizationSettings>> {
  declare organizationId: string;
  declare recordingEnabled: CreationOptional<boolean>;
  declare transcriptEnabled: CreationOptional<boolean>;
  declare recordingRetentionDays: CreationOptional<number>;
  declare aiPickupMode: CreationOptional<'always' | 'after_ring' | 'after_hours'>;
  declare aiPickupAfterSeconds: CreationOptional<number>;
  declare transcriptRetentionDays: CreationOptional<number>;
  declare outboundStartLocal: CreationOptional<string>;
  declare outboundEndLocal: CreationOptional<string>;
  declare refundLimitReceptionistPaise: CreationOptional<string>;
  declare prepayPolicy: CreationOptional<'always' | 'video_only' | 'never'>;
  declare cancellationPolicyText: CreationOptional<string | null>;
  declare freeCancellationHours: CreationOptional<number>;
  declare phoneSetupChoice: CreationOptional<'forward_existing' | 'new_number' | 'later' | null>;
  declare onboardingCompletedAt: CreationOptional<Date | null>;
  declare onboardingCompletedBy: CreationOptional<string | null>;
  declare mrnPrefix: CreationOptional<string | null>;
  declare nextMrn: CreationOptional<number>;
  declare updatedAt: CreationOptional<Date>;
}

type Range = [{ value: Date; inclusive: boolean }, { value: Date; inclusive: boolean }];

export class Patient extends Model<InferAttributes<Patient>, InferCreationAttributes<Patient>> {
  declare id: CreationOptional<string>;
  declare phoneE164Enc: Buffer;
  declare phoneHash: string;
  declare fullName: string;
  declare dateOfBirth: string | null;
  declare sex: 'female' | 'male' | 'other' | 'unknown' | null;
  declare preferredLanguage: CreationOptional<string>;
  declare createdByOrg: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date | null>;
}

export class PatientProfile extends Model<InferAttributes<PatientProfile>, InferCreationAttributes<PatientProfile>> {
  declare id: CreationOptional<string>;
  declare organizationId: string;
  declare patientId: string;
  declare mrn: string;
  declare homeBranchId: string | null;
  declare city: string | null;
  declare acquisitionSource: string | null;
  declare tags: CreationOptional<string[]>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date | null>;
}

export type AppointmentStatus = 'held' | 'booked' | 'confirmed' | 'checked_in' | 'in_consultation' | 'completed' | 'cancelled' | 'no_show' | 'rescheduled';

export class Appointment extends Model<InferAttributes<Appointment>, InferCreationAttributes<Appointment>> {
  declare id: CreationOptional<string>;
  declare organizationId: string;
  declare branchId: string | null;
  declare doctorId: string;
  declare serviceId: string;
  declare patientProfileId: string;
  declare mode: ConsultMode;
  declare slot: Range;
  declare status: CreationOptional<AppointmentStatus>;
  declare bookedByKind: 'ai_agent' | 'staff' | 'patient_app' | 'partner' | 'import';
  declare bookedById: string | null;
  declare feePaise: string | null;
  declare reasonText: string | null;
  declare idempotencyKey: string | null;
  declare cancelledReason: CreationOptional<string | null>;
  declare rescheduledFrom: string | null;
  declare statusChangedAt: CreationOptional<Date>;
  declare statusChangedBy: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class SlotHold extends Model<InferAttributes<SlotHold>, InferCreationAttributes<SlotHold>> {
  declare id: CreationOptional<string>;
  declare organizationId: string;
  declare doctorId: string;
  declare serviceId: string;
  declare mode: ConsultMode;
  declare branchId: string | null;
  declare slot: Range;
  declare heldByKind: 'call' | 'staff' | 'app';
  declare heldByRef: string | null;
  declare createdBy: string | null;
  declare expiresAt: Date;
}

export type ConsultMode = 'clinic' | 'video' | 'phone';

export class Doctor extends Model<InferAttributes<Doctor>, InferCreationAttributes<Doctor>> {
  declare id: CreationOptional<string>;
  declare organizationId: string;
  declare userId: string | null;
  declare departmentId: string | null;
  declare displayName: string;
  declare qualifications: string | null;
  declare registrationNumber: string | null;
  declare registrationCouncil: string | null;
  declare registrationVerifiedAt: CreationOptional<Date | null>;
  declare yearsExperience: number | null;
  declare languages: CreationOptional<string[]>;
  declare bioApproved: string | null;
  declare photoUrl: CreationOptional<string | null>;
  declare slotMinutes: CreationOptional<number>;
  declare bufferMinutes: CreationOptional<number>;
  declare maxOnlinePerDay: number | null;
  declare bookableByAi: CreationOptional<boolean>;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date | null>;
}

export class Service extends Model<InferAttributes<Service>, InferCreationAttributes<Service>> {
  declare id: CreationOptional<string>;
  declare organizationId: string;
  declare departmentId: string | null;
  declare name: string;
  declare durationMinutes: number;
  declare feePaise: string | null; // bigint arrives as a string
  declare aiMayQuoteFee: CreationOptional<boolean>;
  declare modes: CreationOptional<ConsultMode[]>;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class DoctorService extends Model<InferAttributes<DoctorService>, InferCreationAttributes<DoctorService>> {
  declare doctorId: string;
  declare serviceId: string;
  declare organizationId: string;
  declare feeOverridePaise: string | null;
}

export class ScheduleRule extends Model<InferAttributes<ScheduleRule>, InferCreationAttributes<ScheduleRule>> {
  declare id: CreationOptional<string>;
  declare organizationId: string;
  declare doctorId: string;
  declare branchId: string | null;
  declare weekday: number;
  declare startLocal: string;
  declare endLocal: string;
  declare mode: ConsultMode;
  declare validFrom: CreationOptional<string>;
  declare validTo: CreationOptional<string | null>;
}

export class ScheduleException extends Model<InferAttributes<ScheduleException>, InferCreationAttributes<ScheduleException>> {
  declare id: CreationOptional<string>;
  declare organizationId: string;
  declare doctorId: string;
  declare kind: 'leave' | 'block' | 'extra';
  declare during: [{ value: Date; inclusive: boolean }, { value: Date; inclusive: boolean }];
  declare reason: string | null;
  declare createdBy: string | null;
  declare createdAt: CreationOptional<Date>;
}

export class Holiday extends Model<InferAttributes<Holiday>, InferCreationAttributes<Holiday>> {
  declare id: CreationOptional<string>;
  declare organizationId: string;
  declare branchId: string | null;
  declare onDate: string;
  declare name: string;
}

export class Branch extends Model<InferAttributes<Branch>, InferCreationAttributes<Branch>> {
  declare id: CreationOptional<string>;
  declare organizationId: string;
  declare name: string;
  declare addressLine: string;
  declare city: string;
  declare state: string;
  declare pincode: string | null;
  declare phone: string | null;
  declare openingHours: CreationOptional<Record<string, [string, string][]>>;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;
}

export class Department extends Model<InferAttributes<Department>, InferCreationAttributes<Department>> {
  declare id: CreationOptional<string>;
  declare organizationId: string;
  declare name: string;
  declare code: string | null;
  declare createdAt: CreationOptional<Date>;
}

export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<string>;
  declare fullName: string;
  declare email: string | null;
  declare phoneE164: string | null;
  declare passwordHash: string | null;
  declare isPlatformAdmin: CreationOptional<boolean>;
  declare preferredLanguage: CreationOptional<string>;
  declare lastLoginAt: Date | null;
  declare failedLoginCount: CreationOptional<number>;
  declare lockedUntil: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;
}

export class Role extends Model<InferAttributes<Role>, InferCreationAttributes<Role>> {
  declare id: CreationOptional<string>;
  declare organizationId: string | null;
  declare key: string;
  declare name: string;
  declare isBuiltin: CreationOptional<boolean>;
  declare requiresMfa: CreationOptional<boolean>;
}

export class RolePermission extends Model<InferAttributes<RolePermission>, InferCreationAttributes<RolePermission>> {
  declare roleId: string;
  declare permissionKey: string;
  declare scope: 'org' | 'branch' | 'own' | 'assigned' | 'none';
  declare limitValue: number | null;
}

export class Membership extends Model<InferAttributes<Membership>, InferCreationAttributes<Membership>> {
  declare id: CreationOptional<string>;
  declare organizationId: string;
  declare userId: string;
  declare roleId: string;
  declare branchIds: CreationOptional<string[]>;
  declare status: CreationOptional<'invited' | 'active' | 'suspended' | 'removed'>;
  declare invitedBy: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Session extends Model<InferAttributes<Session>, InferCreationAttributes<Session>> {
  declare id: CreationOptional<string>;
  declare userId: string | null;
  declare patientId: string | null;
  declare refreshTokenHash: string;
  declare deviceLabel: string | null;
  declare ipHash: string | null;
  declare trustedUntil: Date | null;
  declare expiresAt: Date;
  declare revokedAt: Date | null;
  declare lastOrganizationId: string | null;
  declare mfaVerifiedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
}

export class OtpChallenge extends Model<InferAttributes<OtpChallenge>, InferCreationAttributes<OtpChallenge>> {
  declare id: CreationOptional<string>;
  declare phoneE164: string;
  declare purpose: 'login' | 'verify_phone' | 'consent' | 'referral_consent' | 'data_share';
  declare codeHash: string;
  declare attempts: CreationOptional<number>;
  declare expiresAt: Date;
  declare consumedAt: Date | null;
  declare context: CreationOptional<Record<string, unknown>>;
  declare createdAt: CreationOptional<Date>;
}

export class MfaFactor extends Model<InferAttributes<MfaFactor>, InferCreationAttributes<MfaFactor>> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare kind: 'totp' | 'backup_codes';
  declare secretEnc: Buffer;
  declare verifiedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
}

export class AuditLog extends Model<InferAttributes<AuditLog>, InferCreationAttributes<AuditLog>> {
  declare id: CreationOptional<number>;
  declare organizationId: string | null;
  declare actorKind: 'user' | 'patient' | 'ai_agent' | 'system' | 'platform_admin' | 'partner' | 'external_doctor';
  declare actorId: string | null;
  declare action: string;
  declare targetType: string | null;
  declare targetId: string | null;
  declare details: CreationOptional<Record<string, unknown>>;
  declare ipHash: string | null;
  declare occurredAt: CreationOptional<Date>;
}

export function initModels(sequelize: Sequelize) {
  const ts = { createdAt: 'created_at', updatedAt: 'updated_at' } as const;

  Organization.init({
    id: uuidPk,
    name: { type: DataTypes.TEXT, allowNull: false },
    slug: { type: DataTypes.TEXT, allowNull: false },
    legalName: DataTypes.TEXT,
    gstin: DataTypes.TEXT,
    status: { type: DataTypes.TEXT, defaultValue: 'trial' },
    specialities: { type: DataTypes.ARRAY(DataTypes.TEXT), defaultValue: [] },
    languages: { type: DataTypes.ARRAY(DataTypes.TEXT), defaultValue: ['en', 'hi'] },
    timezone: { type: DataTypes.TEXT, defaultValue: 'Asia/Kolkata' },
    dataRegion: { type: DataTypes.TEXT, defaultValue: 'ap-south-1' },
    logoUrl: DataTypes.TEXT,
    trialEndsAt: DataTypes.DATE,
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
    deletedAt: DataTypes.DATE,
  }, { ...common, sequelize, tableName: 'organizations', ...ts });

  OrganizationSettings.init({
    organizationId: { type: DataTypes.UUID, primaryKey: true },
    recordingEnabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    transcriptEnabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    recordingRetentionDays: { type: DataTypes.INTEGER, defaultValue: 90 },
    aiPickupMode: { type: DataTypes.TEXT, defaultValue: 'after_ring' },
    aiPickupAfterSeconds: { type: DataTypes.INTEGER, defaultValue: 20 },
    transcriptRetentionDays: { type: DataTypes.INTEGER, defaultValue: 2555 },
    outboundStartLocal: { type: DataTypes.TIME, defaultValue: '09:00' },
    outboundEndLocal: { type: DataTypes.TIME, defaultValue: '20:00' },
    refundLimitReceptionistPaise: { type: DataTypes.BIGINT, defaultValue: 500000 },
    prepayPolicy: { type: DataTypes.TEXT, defaultValue: 'video_only' },
    cancellationPolicyText: DataTypes.TEXT,
    freeCancellationHours: { type: DataTypes.INTEGER, defaultValue: 4 },
    phoneSetupChoice: DataTypes.TEXT,
    onboardingCompletedAt: DataTypes.DATE,
    onboardingCompletedBy: DataTypes.UUID,
    mrnPrefix: DataTypes.TEXT,
    nextMrn: { type: DataTypes.INTEGER, defaultValue: 1001 },
    updatedAt: DataTypes.DATE,
  }, { ...common, sequelize, tableName: 'organization_settings', createdAt: false, updatedAt: 'updated_at' });

  Doctor.init({
    id: uuidPk,
    organizationId: { type: DataTypes.UUID, allowNull: false },
    userId: DataTypes.UUID,
    departmentId: DataTypes.UUID,
    displayName: { type: DataTypes.TEXT, allowNull: false },
    qualifications: DataTypes.TEXT,
    registrationNumber: DataTypes.TEXT,
    registrationCouncil: DataTypes.TEXT,
    registrationVerifiedAt: DataTypes.DATE,
    yearsExperience: DataTypes.INTEGER,
    languages: { type: DataTypes.ARRAY(DataTypes.TEXT), defaultValue: ['en', 'hi'] },
    bioApproved: DataTypes.TEXT,
    photoUrl: DataTypes.TEXT,
    slotMinutes: { type: DataTypes.INTEGER, defaultValue: 20 },
    bufferMinutes: { type: DataTypes.INTEGER, defaultValue: 5 },
    maxOnlinePerDay: DataTypes.INTEGER,
    bookableByAi: { type: DataTypes.BOOLEAN, defaultValue: true },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
    deletedAt: DataTypes.DATE,
  }, { ...common, sequelize, tableName: 'doctors', ...ts });

  Service.init({
    id: uuidPk,
    organizationId: { type: DataTypes.UUID, allowNull: false },
    departmentId: DataTypes.UUID,
    name: { type: DataTypes.TEXT, allowNull: false },
    durationMinutes: { type: DataTypes.INTEGER, allowNull: false },
    feePaise: DataTypes.BIGINT,
    aiMayQuoteFee: { type: DataTypes.BOOLEAN, defaultValue: false },
    // app.consult_mode[]: Sequelize sends a text[] literal; Postgres casts it on insert.
    modes: { type: DataTypes.ARRAY(DataTypes.ENUM('clinic', 'video', 'phone')), defaultValue: ['clinic'] },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  }, { ...common, sequelize, tableName: 'services', ...ts });

  DoctorService.init({
    doctorId: { type: DataTypes.UUID, primaryKey: true },
    serviceId: { type: DataTypes.UUID, primaryKey: true },
    organizationId: { type: DataTypes.UUID, allowNull: false },
    feeOverridePaise: DataTypes.BIGINT,
  }, { ...common, sequelize, tableName: 'doctor_services', timestamps: false });

  ScheduleRule.init({
    id: uuidPk,
    organizationId: { type: DataTypes.UUID, allowNull: false },
    doctorId: { type: DataTypes.UUID, allowNull: false },
    branchId: DataTypes.UUID,
    weekday: { type: DataTypes.SMALLINT, allowNull: false },
    startLocal: { type: DataTypes.TIME, allowNull: false },
    endLocal: { type: DataTypes.TIME, allowNull: false },
    mode: { type: DataTypes.TEXT, allowNull: false },
    validFrom: DataTypes.DATEONLY,
    validTo: DataTypes.DATEONLY,
  }, { ...common, sequelize, tableName: 'schedule_rules', timestamps: false });

  ScheduleException.init({
    id: uuidPk,
    organizationId: { type: DataTypes.UUID, allowNull: false },
    doctorId: { type: DataTypes.UUID, allowNull: false },
    kind: { type: DataTypes.TEXT, allowNull: false },
    during: { type: DataTypes.RANGE(DataTypes.DATE), allowNull: false },
    reason: DataTypes.TEXT,
    createdBy: DataTypes.UUID,
    createdAt: DataTypes.DATE,
  }, { ...common, sequelize, tableName: 'schedule_exceptions', createdAt: 'created_at', updatedAt: false });

  Patient.init({
    id: uuidPk,
    phoneE164Enc: { type: DataTypes.BLOB, allowNull: false },
    phoneHash: { type: DataTypes.TEXT, allowNull: false },
    fullName: { type: DataTypes.TEXT, allowNull: false },
    dateOfBirth: DataTypes.DATEONLY,
    sex: DataTypes.TEXT,
    preferredLanguage: { type: DataTypes.TEXT, defaultValue: 'hi' },
    createdByOrg: { type: DataTypes.UUID, allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
    deletedAt: DataTypes.DATE,
  }, { ...common, sequelize, tableName: 'patients', ...ts });

  PatientProfile.init({
    id: uuidPk,
    organizationId: { type: DataTypes.UUID, allowNull: false },
    patientId: { type: DataTypes.UUID, allowNull: false },
    mrn: { type: DataTypes.TEXT, allowNull: false },
    homeBranchId: DataTypes.UUID,
    city: DataTypes.TEXT,
    acquisitionSource: DataTypes.TEXT,
    tags: { type: DataTypes.ARRAY(DataTypes.TEXT), defaultValue: [] },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
    deletedAt: DataTypes.DATE,
  }, { ...common, sequelize, tableName: 'patient_profiles', ...ts });

  Appointment.init({
    id: uuidPk,
    organizationId: { type: DataTypes.UUID, allowNull: false },
    branchId: DataTypes.UUID,
    doctorId: { type: DataTypes.UUID, allowNull: false },
    serviceId: { type: DataTypes.UUID, allowNull: false },
    patientProfileId: { type: DataTypes.UUID, allowNull: false },
    mode: { type: DataTypes.TEXT, allowNull: false },
    slot: { type: DataTypes.RANGE(DataTypes.DATE), allowNull: false },
    status: { type: DataTypes.TEXT, defaultValue: 'booked' },
    bookedByKind: { type: DataTypes.TEXT, allowNull: false },
    bookedById: DataTypes.UUID,
    feePaise: DataTypes.BIGINT,
    reasonText: DataTypes.TEXT,
    idempotencyKey: DataTypes.TEXT,
    cancelledReason: DataTypes.TEXT,
    rescheduledFrom: DataTypes.UUID,
    statusChangedAt: DataTypes.DATE,
    statusChangedBy: DataTypes.UUID,
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  }, { ...common, sequelize, tableName: 'appointments', ...ts });

  SlotHold.init({
    id: uuidPk,
    organizationId: { type: DataTypes.UUID, allowNull: false },
    doctorId: { type: DataTypes.UUID, allowNull: false },
    serviceId: DataTypes.UUID,
    mode: DataTypes.TEXT,
    branchId: DataTypes.UUID,
    slot: { type: DataTypes.RANGE(DataTypes.DATE), allowNull: false },
    heldByKind: { type: DataTypes.TEXT, allowNull: false },
    heldByRef: DataTypes.UUID,
    createdBy: DataTypes.UUID,
    expiresAt: { type: DataTypes.DATE, allowNull: false },
  }, { ...common, sequelize, tableName: 'slot_holds', timestamps: false });

  Holiday.init({
    id: uuidPk,
    organizationId: { type: DataTypes.UUID, allowNull: false },
    branchId: DataTypes.UUID,
    onDate: { type: DataTypes.DATEONLY, allowNull: false },
    name: { type: DataTypes.TEXT, allowNull: false },
  }, { ...common, sequelize, tableName: 'holidays', timestamps: false });

  Branch.init({
    id: uuidPk,
    organizationId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.TEXT, allowNull: false },
    addressLine: { type: DataTypes.TEXT, allowNull: false },
    city: { type: DataTypes.TEXT, allowNull: false },
    state: { type: DataTypes.TEXT, allowNull: false },
    pincode: DataTypes.TEXT,
    phone: DataTypes.TEXT,
    openingHours: { type: DataTypes.JSONB, defaultValue: {} },
    isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
    deletedAt: DataTypes.DATE,
  }, { ...common, sequelize, tableName: 'branches', ...ts });

  Department.init({
    id: uuidPk,
    organizationId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.TEXT, allowNull: false },
    code: DataTypes.TEXT,
    createdAt: DataTypes.DATE,
  }, { ...common, sequelize, tableName: 'departments', createdAt: 'created_at', updatedAt: false });

  User.init({
    id: uuidPk,
    fullName: { type: DataTypes.TEXT, allowNull: false },
    email: DataTypes.TEXT,
    phoneE164: { type: DataTypes.TEXT, field: 'phone_e164' },
    passwordHash: DataTypes.TEXT,
    isPlatformAdmin: { type: DataTypes.BOOLEAN, defaultValue: false },
    preferredLanguage: { type: DataTypes.TEXT, defaultValue: 'en' },
    lastLoginAt: DataTypes.DATE,
    failedLoginCount: { type: DataTypes.INTEGER, defaultValue: 0 },
    lockedUntil: DataTypes.DATE,
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
    deletedAt: DataTypes.DATE,
  }, { ...common, sequelize, tableName: 'users', ...ts });

  Role.init({
    id: uuidPk,
    organizationId: DataTypes.UUID,
    key: { type: DataTypes.TEXT, allowNull: false },
    name: { type: DataTypes.TEXT, allowNull: false },
    isBuiltin: { type: DataTypes.BOOLEAN, defaultValue: false },
    requiresMfa: { type: DataTypes.BOOLEAN, defaultValue: false },
  }, { ...common, sequelize, tableName: 'roles', timestamps: false });

  RolePermission.init({
    roleId: { type: DataTypes.UUID, primaryKey: true },
    permissionKey: { type: DataTypes.TEXT, primaryKey: true },
    scope: { type: DataTypes.TEXT, allowNull: false },
    limitValue: DataTypes.BIGINT,
  }, { ...common, sequelize, tableName: 'role_permissions', timestamps: false });

  Membership.init({
    id: uuidPk,
    organizationId: { type: DataTypes.UUID, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    roleId: { type: DataTypes.UUID, allowNull: false },
    branchIds: { type: DataTypes.ARRAY(DataTypes.UUID), defaultValue: [] },
    status: { type: DataTypes.TEXT, defaultValue: 'invited' },
    invitedBy: DataTypes.UUID,
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  }, { ...common, sequelize, tableName: 'memberships', ...ts });

  Session.init({
    id: uuidPk,
    userId: DataTypes.UUID,
    patientId: DataTypes.UUID,
    refreshTokenHash: { type: DataTypes.TEXT, allowNull: false },
    deviceLabel: DataTypes.TEXT,
    ipHash: DataTypes.TEXT,
    trustedUntil: DataTypes.DATE,
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    revokedAt: DataTypes.DATE,
    lastOrganizationId: DataTypes.UUID,
    mfaVerifiedAt: DataTypes.DATE,
    createdAt: DataTypes.DATE,
  }, { ...common, sequelize, tableName: 'sessions', createdAt: 'created_at', updatedAt: false });

  OtpChallenge.init({
    id: uuidPk,
    phoneE164: { type: DataTypes.TEXT, allowNull: false, field: 'phone_e164' },
    purpose: { type: DataTypes.TEXT, allowNull: false },
    codeHash: { type: DataTypes.TEXT, allowNull: false },
    attempts: { type: DataTypes.INTEGER, defaultValue: 0 },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    consumedAt: DataTypes.DATE,
    context: { type: DataTypes.JSONB, defaultValue: {} },
    createdAt: DataTypes.DATE,
  }, { ...common, sequelize, tableName: 'otp_challenges', createdAt: 'created_at', updatedAt: false });

  MfaFactor.init({
    id: uuidPk,
    userId: { type: DataTypes.UUID, allowNull: false },
    kind: { type: DataTypes.TEXT, allowNull: false },
    secretEnc: { type: DataTypes.BLOB, allowNull: false },
    verifiedAt: DataTypes.DATE,
    createdAt: DataTypes.DATE,
  }, { ...common, sequelize, tableName: 'mfa_factors', createdAt: 'created_at', updatedAt: false });

  AuditLog.init({
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    organizationId: DataTypes.UUID,
    actorKind: { type: DataTypes.TEXT, allowNull: false },
    actorId: DataTypes.UUID,
    action: { type: DataTypes.TEXT, allowNull: false },
    targetType: DataTypes.TEXT,
    targetId: DataTypes.UUID,
    details: { type: DataTypes.JSONB, defaultValue: {} },
    ipHash: DataTypes.TEXT,
    occurredAt: DataTypes.DATE,
  }, { ...common, sequelize, tableName: 'audit_logs', timestamps: false });

  Membership.belongsTo(Organization, { as: 'organization', foreignKey: 'organizationId' });
  Membership.belongsTo(Role, { as: 'role', foreignKey: 'roleId' });
  Membership.belongsTo(User, { as: 'user', foreignKey: 'userId' });
  Role.hasMany(RolePermission, { as: 'permissions', foreignKey: 'roleId' });
  Doctor.hasMany(ScheduleRule, { as: 'rules', foreignKey: 'doctorId' });
  Doctor.hasMany(DoctorService, { as: 'services', foreignKey: 'doctorId' });
}
