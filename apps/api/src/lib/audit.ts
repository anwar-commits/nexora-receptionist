import { AuditLog } from '@dr/db';
import type { Request } from 'express';

export interface AuditEntry {
  action: string;
  organizationId?: string | null;
  actorId?: string | null;
  actorKind?: AuditLog['actorKind'];
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ipHash?: string | null;
}

/** Writes an audit row inside the current transaction (CLS), so it commits or rolls back with the change. */
export async function audit(e: AuditEntry): Promise<void> {
  await AuditLog.create({
    action: e.action,
    organizationId: e.organizationId ?? null,
    actorKind: e.actorKind ?? 'user',
    actorId: e.actorId ?? null,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    details: e.details ?? {},
    ipHash: e.ipHash ?? null,
  });
}

export function auditFromReq(req: Request, e: Omit<AuditEntry, 'organizationId' | 'actorId' | 'ipHash'>): Promise<void> {
  return audit({ ...e, organizationId: req.ctx?.org?.id ?? null, actorId: req.ctx?.userId ?? null, ipHash: req.ctx?.ip ?? null });
}
