import type { patientBody } from '@dr/contracts';
import { OrganizationSettings, Patient, PatientProfile, QueryTypes } from '@dr/db';
import type { Request } from 'express';
import type { z } from 'zod';
import type { Deps } from '../context.js';
import { HttpError, notFound } from '../errors.js';
import { audit, auditFromReq, type AuditEntry } from './audit.js';
import { encrypt, hmac } from './crypto.js';

export const patientPhoneHash = (deps: Deps, phone: string) => hmac(deps.config.pepper, 'patient-phone', phone);

/**
 * Registers a person in the current clinic and gives them a clinic patient ID (e.g. LHS-1001).
 * Must run inside withContext. Families often share one number, so the same number is fine;
 * the same number AND name is refused as a duplicate (details carry the existing profile id).
 */
/** Who is registering the patient: a signed-in staff member (their request) or the AI receptionist. */
export type Registrar = Request | { orgId: string; aiVersionId: string };

export async function createPatient(deps: Deps, by: Registrar, body: z.infer<typeof patientBody>, homeBranchId: string | null): Promise<string> {
  const { db, config } = deps;
  const orgId = 'aiVersionId' in by ? by.orgId : by.ctx!.org!.id;
  const log = (e: Omit<AuditEntry, 'organizationId' | 'actorId' | 'ipHash'>) =>
    'aiVersionId' in by ? audit({ ...e, organizationId: orgId, actorKind: 'ai_agent', actorId: by.aiVersionId }) : auditFromReq(by, e);
  const q = <T extends object>(sql: string, replacements: Record<string, unknown>) => db.sequelize.query<T>(sql, { replacements, type: QueryTypes.SELECT });
  const hash = patientPhoneHash(deps, body.phone);
  const [dup] = await q<{ id: string; mrn: string }>(
    `SELECT pp.id, pp.mrn FROM app.patient_profiles pp JOIN app.patients p ON p.id = pp.patient_id
      WHERE pp.deleted_at IS NULL AND p.phone_hash = :hash AND lower(p.full_name) = lower(:name)`, { hash, name: body.fullName });
  if (dup) throw new HttpError(409, 'conflict', `${body.fullName} is already registered (${dup.mrn})`, { patientProfileId: dup.id });

  const [counter] = await q<{ n: number; prefix: string | null; name: string }>(
    `UPDATE app.organization_settings s SET next_mrn = next_mrn + 1 FROM app.organizations o
      WHERE s.organization_id = :org AND o.id = s.organization_id RETURNING s.next_mrn - 1 AS n, s.mrn_prefix AS prefix, o.name`, { org: orgId });
  if (!counter) throw notFound();
  let prefix = counter.prefix;
  if (!prefix) {
    prefix = counter.name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).map((w) => w[0]!.toUpperCase()).join('').slice(0, 3) || 'PT';
    await OrganizationSettings.update({ mrnPrefix: prefix }, { where: { organizationId: orgId } });
  }
  const person = await Patient.create({
    phoneE164Enc: encrypt(config.dataKey, body.phone), phoneHash: hash, fullName: body.fullName,
    dateOfBirth: body.dateOfBirth ?? null, sex: body.sex ?? null, preferredLanguage: body.preferredLanguage, createdByOrg: orgId,
  });
  const profile = await PatientProfile.create({
    organizationId: orgId, patientId: person.id, mrn: `${prefix}-${counter.n}`, homeBranchId,
    city: body.city ?? null, acquisitionSource: body.acquisitionSource ?? null,
  });
  await log({ action: 'patient.create', targetType: 'patient_profile', targetId: profile.id, details: { mrn: profile.mrn } });
  return profile.id;
}
