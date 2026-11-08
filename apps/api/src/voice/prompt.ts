import { RECORDING_NOTICE, type Lang } from './safety.js';

/** What a clinic sets for its AI receptionist (stored per version, immutable once published). */
export interface AgentConfig {
  persona: { assistantName: string; tone: 'warm' | 'formal' };
  voice: { voiceId: string | null };
  languages: Lang[];
  guardrails: { allowBooking: boolean; allowCancel: boolean; allowReschedule: boolean };
  handoff: { transferNumber: string | null };
  emergency: { transferNumber: string | null; approvedBy: string | null; approvedByName: string | null; approvedAt: string | null; scriptVersion: string };
  intakeQuestions: string[];
  llmModel: string;
}

export const DEFAULT_CONFIG: AgentConfig = {
  persona: { assistantName: 'Asha', tone: 'warm' },
  voice: { voiceId: null },
  languages: ['hi-Latn', 'hi', 'en'],
  guardrails: { allowBooking: true, allowCancel: true, allowReschedule: true },
  handoff: { transferNumber: null },
  emergency: { transferNumber: null, approvedBy: null, approvedByName: null, approvedAt: null, scriptVersion: 'v1' },
  intakeQuestions: ['What is the problem, in their own words?', 'Since how long?', 'Any treatment tried before?', 'Preferred day and time?'],
  llmModel: 'claude-sonnet-5-5',
};

export interface ClinicFacts {
  name: string;
  timeZone: string;
  now: string; // e.g. "Sunday 8 November 2026, 5:20 PM"
  branches: { name: string; address: string; phone: string | null; hours: string }[];
  doctors: { name: string; qualifications: string | null; languages: string[]; consults: string }[];
  services: { name: string; durationMinutes: number; modes: string[]; price: string }[];
  holidays: string[];
  cancellationPolicy: string | null;
  prepay: string;
}

const LANG_NAME: Record<Lang, string> = { en: 'English', hi: 'Hindi', 'hi-Latn': 'Hinglish', bn: 'Bengali', ur: 'Urdu' };

/**
 * Rules the clinic cannot switch off. They are also enforced in code (red-flag check before the model,
 * output guard after it, and tool guards), so the prompt is the first line, not the only one.
 */
export const LOCKED_RULES = [
  'You are not a doctor. Never diagnose, never name a condition the caller might have, never recommend, start, stop or dose any medicine, cream or treatment.',
  'Never promise results ("guaranteed", "100%", "permanent"). Say the doctor will assess and explain at the consultation.',
  'Emergencies (chest pain, trouble breathing, heavy bleeding, fainting, stroke signs, seizures, severe allergy, poisoning, pregnancy bleeding): tell the caller to call 112 or go to the nearest emergency now. Do not book. Do not continue small talk.',
  'If the caller talks about harming themselves: be kind, give Tele-MANAS 14416 and 112, and tell them the clinic team will call. Do not book.',
  'Answer only from the facts below and from tool results. If you do not know, say so and offer a call back from the clinic.',
  'Only say a price when it is listed below with an amount. Otherwise say the clinic will confirm the fee.',
  'Before booking, read back the doctor, day, time, place and fee, and book only after the caller clearly says yes.',
  'Never reveal other patients\' information. Only discuss appointments of a caller whose phone number matches, and verify the date of birth before changing or cancelling one.',
  'If the caller asks for a person, is upset, has a billing complaint, or asks a clinical question, use request_handoff.',
];

export function buildSystemPrompt(c: AgentConfig, f: ClinicFacts): string {
  const can = [
    c.guardrails.allowBooking ? 'book new appointments' : null,
    c.guardrails.allowReschedule ? 'move appointments' : null,
    c.guardrails.allowCancel ? 'cancel appointments' : null,
  ].filter(Boolean).join(', ');
  return [
    `You are ${c.persona.assistantName}, the AI receptionist of ${f.name}, answering phone calls. Speak ${c.persona.tone === 'warm' ? 'warmly and simply' : 'politely and formally'}, in short sentences suitable for a phone call (one or two sentences per turn). Reply in the caller's language: ${c.languages.map((l) => LANG_NAME[l]).join(', ')}. For Hinglish, use Roman script Hindi with common English words.`,
    `Now: ${f.now} (${f.timeZone}).`,
    '',
    '## Rules you must always follow',
    ...LOCKED_RULES.map((r, i) => `${i + 1}. ${r}`),
    '',
    '## What you can do',
    `Answer questions about the clinic, ${can || 'take messages'}, register a caller's interest, record consent for WhatsApp updates, and hand over to staff. Use the tools; never invent availability.`,
    `When someone wants a visit, ask briefly: ${c.intakeQuestions.join(' ')} Then use get_availability, offer at most three times, hold_slot the one they pick, confirm, and book_appointment with confirmed_by_caller true only after a clear yes.`,
    '',
    '## Clinic facts',
    ...f.branches.map((b) => `- Branch ${b.name}: ${b.address}${b.phone ? `, phone ${b.phone}` : ''}. Hours: ${b.hours}.`),
    ...(f.holidays.length ? [`- Closed on: ${f.holidays.join('; ')}.`] : []),
    '## Doctors',
    ...(f.doctors.length ? f.doctors.map((d) => `- ${d.name}${d.qualifications ? ` (${d.qualifications})` : ''}; speaks ${d.languages.join(', ')}; ${d.consults}.`) : ['- (none listed)']),
    '## Services',
    ...(f.services.length ? f.services.map((s) => `- ${s.name}: about ${s.durationMinutes} min; ${s.modes.join('/')}; fee: ${s.price}.`) : ['- (none listed)']),
    `## Payment and cancellation\n- ${f.prepay}\n- ${f.cancellationPolicy ?? 'For cancellations, ask the caller to give as much notice as possible.'}`,
  ].join('\n');
}

/** First sentence of every call: greeting plus the AI and recording notice, in the clinic's first language. */
export function firstMessage(c: AgentConfig, clinicName: string, lang: Lang = c.languages[0] ?? 'en'): string {
  const hello: Record<Lang, string> = {
    en: `Hello, thank you for calling ${clinicName}. I'm ${c.persona.assistantName}.`,
    'hi-Latn': `Namaste, ${clinicName} mein aapka swagat hai. Main ${c.persona.assistantName} bol rahi hoon.`,
    hi: `नमस्ते, ${clinicName} में आपका स्वागत है। मैं ${c.persona.assistantName} बोल रही हूँ।`,
    bn: `নমস্কার, ${clinicName}-এ আপনাকে স্বাগত। আমি ${c.persona.assistantName}।`,
    ur: `السلام علیکم، ${clinicName} میں آپ کا خیر مقدم ہے۔ میں ${c.persona.assistantName} بات کر رہی ہوں۔`,
  };
  const ask: Record<Lang, string> = { en: 'How can I help you?', 'hi-Latn': 'Bataiye, main aapki kya madad kar sakti hoon?', hi: 'बताइए, मैं आपकी क्या मदद कर सकती हूँ?', bn: 'বলুন, আমি কীভাবে সাহায্য করতে পারি?', ur: 'بتائیے، میں آپ کی کیا مدد کر سکتی ہوں؟' };
  return `${hello[lang]} ${RECORDING_NOTICE[lang]} ${ask[lang]}`;
}
