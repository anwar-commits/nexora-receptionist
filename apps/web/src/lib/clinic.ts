import type { ConsultMode, OnboardingStatus } from '@dr/contracts';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { ApiRequestError, api, session } from './api';

/** Read models returned by the API for clinic setup screens. */
export interface Current {
  id: string; name: string; slug: string; legalName: string | null; gstin: string | null; status: string;
  specialities: string[]; languages: string[]; timezone: string; trialEndsAt: string | null;
  you: { roleKey: string; permissions: string[] };
}
export type Hours = Partial<Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', [string, string][]>>;
export interface Branch { id: string; name: string; addressLine: string; city: string; state: string; pincode: string | null; phone: string | null; openingHours: Hours; isActive: boolean }
export interface Department { id: string; name: string; code: string | null }
export interface Rule { id?: string; weekday: number; start: string; end: string; mode: ConsultMode; branchId: string | null }
export interface DoctorSummary {
  id: string; userId: string | null; departmentId: string | null; displayName: string; qualifications: string | null;
  registrationNumber: string | null; registrationCouncil: string | null; registrationVerified: boolean;
  yearsExperience: number | null; languages: string[]; bioApproved: string | null; slotMinutes: number; bufferMinutes: number;
  maxOnlinePerDay: number | null; bookableByAi: boolean; isActive: boolean;
  weeklyHours: Rule[]; modes: ConsultMode[]; branchIds: string[]; serviceIds: string[];
}
export interface Leave { id: string; kind: 'leave' | 'block'; startsAt: string; endsAt: string; reason: string | null }
export interface DoctorDetail extends Omit<DoctorSummary, 'modes' | 'branchIds' | 'serviceIds'> {
  services: { serviceId: string; feeOverridePaise: number | null }[];
  upcomingLeave: Leave[];
}
export interface Service { id: string; departmentId: string | null; name: string; durationMinutes: number; feePaise: number | null; aiMayQuoteFee: boolean; modes: ConsultMode[]; isActive: boolean }
export interface Settings {
  recordingEnabled: boolean; transcriptEnabled: boolean; recordingRetentionDays: number; transcriptRetentionDays: number;
  aiPickupMode: 'always' | 'after_ring' | 'after_hours'; aiPickupAfterSeconds: number;
  outboundStartLocal: string; outboundEndLocal: string; refundLimitReceptionistPaise: number;
  prepayPolicy: 'always' | 'video_only' | 'never'; cancellationPolicyText: string | null; freeCancellationHours: number;
  phoneSetupChoice: 'forward_existing' | 'new_number' | 'later' | null; onboardingCompletedAt: string | null;
}
export interface Holiday { id: string; onDate: string; name: string; branchId: string | null }
export interface Member { id: string; userId: string; fullName: string; email: string | null; phone: string | null; roleId: string; roleKey: string; roleName: string; branchIds: string[]; status: string }
export interface RoleInfo { id: string; key: string; name: string; isBuiltin: boolean; requiresMfa: boolean; permissions: { key: string; scope: string; limit: number | null }[] }

/** The selected clinic plus what the signed-in member may do there. */
export function useClinic() {
  const orgId = useSyncExternalStore(session.subscribe, () => session.orgId);
  const current = useQuery({ queryKey: ['org', orgId], queryFn: () => api<Current>('/organizations/current'), enabled: !!orgId, retry: false });
  const can = (p: string) => current.data?.you.permissions.includes(p) ?? false;
  return { orgId, current, can };
}

const list = <T,>(path: string) => () => api<{ items: T[] }>(path).then((r) => r.items);

export function useClinicData() {
  const { orgId, can } = useClinic();
  const ready = !!orgId && can('org:read');
  return {
    branches: useQuery({ queryKey: ['branches', orgId], queryFn: list<Branch>('/branches'), enabled: ready && can('branch:read') }),
    departments: useQuery({ queryKey: ['departments', orgId], queryFn: list<Department>('/departments'), enabled: ready }),
    doctors: useQuery({ queryKey: ['doctors', orgId], queryFn: list<DoctorSummary>('/doctors?includeInactive=1'), enabled: ready }),
    services: useQuery({ queryKey: ['services', orgId], queryFn: list<Service>('/services?includeInactive=1'), enabled: ready }),
    settings: useQuery({ queryKey: ['settings', orgId], queryFn: () => api<Settings>('/settings'), enabled: ready }),
    onboarding: useQuery({ queryKey: ['onboarding', orgId], queryFn: () => api<OnboardingStatus>('/onboarding'), enabled: ready }),
  };
}

/**
 * A mutation that refreshes the given queries (and the onboarding checklist) afterwards.
 * Errors stay on the mutation so the screen can show the server's message.
 */
export function useSave<V, R = unknown>(fn: (v: V) => Promise<R>, invalidate: string[]) {
  const qc = useQueryClient();
  return useMutation<R, ApiRequestError, V>({
    mutationFn: fn,
    onSuccess: async () => {
      await Promise.all([...invalidate, 'onboarding'].map((k) => qc.invalidateQueries({ queryKey: [k] as QueryKey })));
    },
  });
}

export const errorText = (e: unknown) => {
  if (e instanceof ApiRequestError) {
    const d = e.error.details as { path?: string; message?: string }[] | undefined;
    const first = Array.isArray(d) ? d.find((x) => x?.message)?.message : undefined;
    return first && e.error.code === 'validation_failed' ? `${e.message}: ${first}` : e.message;
  }
  return e ? 'Could not reach the server. Check your connection.' : null;
};
