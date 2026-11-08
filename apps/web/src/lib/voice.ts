import type { AgentDraftBody, VoiceLang } from '@dr/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useClinic } from './clinic';

export interface AgentConfig extends AgentDraftBody {
  emergency: AgentDraftBody['emergency'] & { approvedBy: string | null; approvedByName: string | null; approvedAt: string | null; scriptVersion: string };
}
export interface SuiteResult { key: string; name: string; status: 'passed' | 'failed' | 'skipped'; detail: string; safetyCritical: boolean }
export interface SuiteSummary { passed: number; failed: number; skipped: number; total: number; runAt: string; model: string | null }
export interface AgentVersion { id: string; version: number; suite: SuiteSummary | null; suitePassedAt: string | null; publishedAt: string | null; publishedBy: string | null; createdAt: string; emergencyApproved: boolean; live: boolean }
export interface PhoneLine { id: string; number: string; provider: 'exotel' | 'plivo' | 'twilio'; label: string | null; branchId: string | null; connected: boolean }
export interface AgentView {
  setup: { model: boolean; voice: boolean; publicUrl: boolean; voiceBaseUrl: string; postCallWebhook: boolean; initiationWebhook: boolean };
  canApproveEmergency: boolean;
  canManage: boolean;
  scripts: { emergency: Record<VoiceLang, string>; selfHarm: Record<VoiceLang, string> };
  agent: null | {
    id: string; status: 'draft' | 'live' | 'paused'; draft: AgentConfig; liveVersionId: string | null; firstMessage: string;
    vendor: { agentId: string | null; syncedAt: string | null; error: string | null };
    versions: AgentVersion[]; numbers: PhoneLine[];
  };
}

export interface TestTurn { caller: string; reply: string; lang: string; tools: { name: string; status: string; result: Record<string, unknown> }[]; redFlag: { key: string; kind: string } | null; guardBlocked: string | null }

export interface CallSummary {
  id: string; startedAt: string; endedAt: string | null; durationSeconds: number | null; status: string; outcome: string | null; handledBy: string; isTest: boolean; safetyLocked: boolean;
  terminationReason: string | null;
  caller: { phone: string | null; name: string | null; patient: { profileId: string; mrn: string } | null; leadId: string | null };
  summary: string | null; nextAction: string | null; intake: Record<string, string | null> | null; safetyEvents: number; openHandoffs: number; hasRecording: boolean;
}
export interface CallDetail extends CallSummary {
  transcript: { seq: number; speaker: 'ai' | 'caller' | 'staff' | 'system'; atMs: number; text: string }[];
  tools: { tool: string; status: string; rejection: string | null; at: string }[];
  safety: { id: string; kind: string; redFlag: string | null; text: string | null; at: string; reviewedAt: string | null; reviewer: string | null }[];
  handoffs: { id: string; reason: string; note: string | null; at: string; outcome: string | null; acceptedBy: string | null; closedAt: string | null }[];
  appointments: { id: string; start: string; status: string; doctor: string }[];
  recording: { durationSeconds: number; deleteAfter: string } | null;
}
export interface Handoff { id: string; reason: string; note: string | null; requestedAt: string; outcome: string | null; acceptedAt: string | null; acceptedBy: string | null; callId: string; caller: { phone: string | null; name: string | null } }

export const LANG_LABEL: Record<VoiceLang, string> = { 'hi-Latn': 'Hinglish', hi: 'Hindi', en: 'English', bn: 'Bengali', ur: 'Urdu' };
export const OUTCOME_LABEL: Record<string, string> = {
  booked: 'Booked', rescheduled: 'Rescheduled', cancelled: 'Cancelled', info_only: 'Information', follow_up: 'Follow-up', handed_off: 'Handed to staff',
  emergency_redirect: 'Emergency', dropped: 'Dropped', spam: 'Spam', other: 'Other',
};
export const HANDOFF_LABEL: Record<string, string> = {
  asked_for_person: 'Asked for a person', complaint: 'Complaint', billing: 'Billing', ai_unsure: 'AI could not help', clinical_question: 'Clinical question', emergency: 'Emergency', vip: 'VIP',
};
export const TOOL_LABEL: Record<string, string> = {
  get_caller_context: 'Looked up caller', list_services: 'Checked services', get_availability: 'Checked free times', hold_slot: 'Held a slot', book_appointment: 'Booked',
  find_my_appointments: 'Found appointments', cancel_appointment: 'Cancelled', reschedule_appointment: 'Rescheduled', create_or_update_lead: 'Saved enquiry',
  record_consent: 'Recorded consent', request_handoff: 'Handed to staff', log_safety_event: 'Logged safety event', end_call: 'Ended call',
};

export function useAgent() {
  const { orgId, can, current } = useClinic();
  return useQuery({ queryKey: ['ai-receptionist', orgId], queryFn: () => api<AgentView>('/ai-receptionist'), enabled: !!orgId && (can('agent:manage') || current.data?.you.roleKey === 'doctor') });
}
export function useCalls(includeTests: boolean) {
  const { orgId, can } = useClinic();
  return useQuery({ queryKey: ['calls', orgId, includeTests], queryFn: () => api<{ items: CallSummary[] }>(`/calls?includeTests=${includeTests ? 1 : 0}`).then((r) => r.items), enabled: !!orgId && can('call:read'), refetchInterval: 20_000 });
}
export function useCall(id: string | null) {
  const { orgId } = useClinic();
  return useQuery({ queryKey: ['call', orgId, id], queryFn: () => api<CallDetail>(`/calls/${id}`), enabled: !!orgId && !!id });
}
export function useHandoffs() {
  const { orgId, can } = useClinic();
  return useQuery({ queryKey: ['handoffs', orgId], queryFn: () => api<{ items: Handoff[] }>('/handoffs').then((r) => r.items), enabled: !!orgId && can('call:read'), refetchInterval: 10_000 });
}
