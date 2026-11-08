import type { LeadStage } from '@dr/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useClinic } from './clinic';

export interface Lead {
  id: string; displayName: string | null; phone: string | null; interest: string | null; source: string; sourceDetail: Record<string, string>;
  stage: LeadStage; score: number; scoreBreakdown: { rule: string; label: string; points: number }[];
  ownerKind: 'ai' | 'user' | 'unassigned'; ownerUserId: string | null; ownerName: string | null;
  nextActionAt: string | null; wantsVisitBy: string | null; branchId: string | null;
  patient: { profileId: string; mrn: string; fullName: string } | null;
  lostReason: string | null; createdAt: string; updatedAt: string; hasUpcomingAppointment: boolean; overdue: boolean;
}
export interface LeadEvent { id: string; kind: string; fromStage: LeadStage | null; toStage: LeadStage | null; note: string | null; actor: string | null; at: string }
export interface LeadDetail extends Lead { events: LeadEvent[] }
export interface ScoringRule { id: string; key: string; label: string; points: number; isActive: boolean; condition: { type: string; days?: number; values?: string[] } }
export interface Task {
  id: string; kind: string; title: string; priority: 'low' | 'normal' | 'high' | 'urgent'; status: 'open' | 'in_progress' | 'done' | 'cancelled';
  assignee: { kind: string; ref: string; name: string | null }; dueAt: string | null;
  related: { type: 'lead' | 'patient' | 'appointment'; id: string; label: string | null } | null;
  notes: string | null; createdAt: string; completedAt: string | null; createdBy: string | null; overdue: boolean;
}
export interface Consent { id: string; purpose: string; state: string; capturedVia: string; evidenceRef: string | null; noticeVersion: string; recordedBy: string | null; recordedAt: string }
export interface TimelineItem { at: string; kind: 'appointment' | 'lead' | 'consent'; title: string; detail?: string | null; actor?: string | null }
export interface QueueItem {
  id: string; token: string; status: 'waiting' | 'called' | 'in_room' | 'done' | 'left'; position: number; doctorId: string; doctorName: string;
  appointmentId: string | null; appointmentStart: string | null; patient: { profileId: string; mrn: string; fullName: string };
  checkedInAt: string; calledAt: string | null; waitingMinutes: number | null; isWalkIn: boolean;
}

export const STAGES: { key: LeadStage; label: string }[] = [
  { key: 'enquiry', label: 'New enquiry' }, { key: 'qualified', label: 'Qualified' }, { key: 'booked', label: 'Booked' }, { key: 'consulted', label: 'Consulted' },
  { key: 'treatment_plan', label: 'Treatment plan' }, { key: 'follow_up', label: 'Follow-up' }, { key: 'retained', label: 'Retained' }, { key: 'lost', label: 'Lost' },
];
export const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.key, s.label])) as Record<LeadStage, string>;
export const SOURCE_LABEL: Record<string, string> = {
  phone_call: 'Phone call', walk_in: 'Walk-in', website: 'Website', google_ads: 'Google Ads', instagram: 'Instagram', facebook: 'Facebook',
  whatsapp: 'WhatsApp', referral_partner: 'Referral partner', doctor_referral: 'Doctor referral', returning: 'Returning', other: 'Other',
};
export const CONSENT_LABEL: Record<string, string> = {
  care_data_processing: 'Data processing for care', whatsapp_updates: 'WhatsApp updates', ai_followup_calls: 'AI follow-up calls', marketing: 'Marketing',
  call_recording_notice: 'Call recording', data_share: 'Data sharing', referral_contact: 'Referral contact',
};
export const ownerLabel = (l: Pick<Lead, 'ownerKind' | 'ownerName'>) => (l.ownerKind === 'ai' ? 'AI' : l.ownerKind === 'unassigned' ? 'Unassigned' : l.ownerName ?? 'Staff');

export function useLeads(params: { owner?: string; source?: string } = {}) {
  const { orgId, can } = useClinic();
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return useQuery({
    queryKey: ['leads', orgId, qs],
    queryFn: () => api<{ items: Lead[] }>(`/leads${qs ? `?${qs}` : ''}`).then((r) => r.items),
    enabled: !!orgId && can('lead:read'),
  });
}

export function useTasks(params: { mine?: boolean; relatedType?: string; relatedId?: string } = {}) {
  const { orgId } = useClinic();
  const qs = new URLSearchParams({ ...(params.mine ? { mine: '1' } : {}), ...(params.relatedType ? { relatedType: params.relatedType, relatedId: params.relatedId! } : {}) }).toString();
  return useQuery({
    queryKey: ['tasks', orgId, qs],
    queryFn: () => api<{ items: Task[] }>(`/tasks${qs ? `?${qs}` : ''}`).then((r) => r.items),
    enabled: !!orgId,
  });
}
