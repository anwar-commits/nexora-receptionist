import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

/**
 * Sequelize models for the Phase 3 tables (identity, tenancy, audit).
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
  declare updatedAt: CreationOptional<Date>;
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
    updatedAt: DataTypes.DATE,
  }, { ...common, sequelize, tableName: 'organization_settings', createdAt: false, updatedAt: 'updated_at' });

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
}
