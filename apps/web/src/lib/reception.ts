import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useClinic } from './clinic';

export interface DueItem {
  kind: 'appointment' | 'walk_in'; id: string; patient: { profileId: string; mrn: string; fullName: string }; service: string; doctor: string; status: string;
  at: string; feePaise: number; paidPaise: number; duePaise: number; token: string | null;
}
export interface Payment {
  id: string; receiptNumber: string; amountPaise: number; refundedPaise: number; method: 'cash' | 'upi' | 'card'; status: string; purpose: string; reference: string | null;
  branchId: string | null; appointmentId: string | null; queueTokenId: string | null; patient: { profileId: string; mrn: string; fullName: string }; collectedBy: string | null; at: string;
}
export interface DayTotals { collectedPaise: number; refundedPaise: number; netPaise: number; byMethod: Record<string, { collectedPaise: number; refundedPaise: number; count: number }>; byPerson: Record<string, number> }
export interface Receipt extends Payment { clinic: { name: string; legalName: string | null; gstin: string | null; branch: string | null; address: string; phone: string | null }; patientPhone: string; timeZone: string }
export interface Conversation {
  id: string; channel: 'whatsapp' | 'sms'; account: { id: string; name: string | null; address: string; isTest: boolean }; status: 'open' | 'snoozed' | 'closed';
  assignee: { id: string; name: string } | null;
  party: { name: string | null; phone: string | null; patient: { profileId: string; mrn: string } | null; lead: { id: string; stage: string } | null };
  lastMessageAt: string | null; lastInboundAt: string | null; lastMessage: { body: string; direction: 'inbound' | 'outbound' } | null; unread: number; replyWindowOpen: boolean;
}
export interface Message { id: string; direction: 'inbound' | 'outbound'; author: string | null; body: string | null; status: string | null; error: string | null; at: string }
export interface Thread extends Conversation { messages: Message[] }
export interface ChannelAccount { id: string; kind: 'whatsapp' | 'sms'; provider: string; address: string; displayName: string | null; phoneNumberId: string | null; isActive: boolean; isTest: boolean; webhookPath: string | null }

export const METHOD_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card' } as const;

export function useDues(branchId?: string) {
  const { orgId, can } = useClinic();
  return useQuery({
    queryKey: ['dues', orgId, branchId ?? ''],
    queryFn: () => api<{ branchId: string; items: DueItem[]; totalDuePaise: number }>(`/payments/due${branchId ? `?branchId=${branchId}` : ''}`),
    enabled: !!orgId && can('payment:collect'),
    refetchInterval: 30_000,
  });
}

export function useConversations(filter: string) {
  const { orgId, can } = useClinic();
  return useQuery({
    queryKey: ['conversations', orgId, filter],
    queryFn: () => api<{ items: Conversation[] }>(`/conversations?${filter}`).then((r) => r.items),
    enabled: !!orgId && can('inbox:read'),
    refetchInterval: 15_000,
  });
}
