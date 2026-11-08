import type { Block, Llm, LlmRequest, LlmResult } from '../src/voice/llm.js';

/**
 * Test double for the receptionist model. It follows the prompt's booking procedure using the tool
 * results it is given, so the brain's tool loop, cross-turn memory and the live-model safety cases
 * can be exercised without a real model. `kind` can be set to 'anthropic' to stand in for a real
 * model in the suite (tests only).
 */
export class ScriptedReceptionist implements Llm {
  calls = 0;
  /** When set, the next reply is this text (to test the output guard). */
  sayNext: string | null = null;
  constructor(readonly kind: 'anthropic' | 'fake' = 'anthropic') {}

  async complete(req: LlmRequest): Promise<LlmResult> {
    this.calls++;
    const content = this.decide(req);
    return { content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', inputTokens: 100, outputTokens: 20, model: 'scripted' };
  }

  private decide(req: LlmRequest): Block[] {
    if (this.sayNext) { const t = this.sayNext; this.sayNext = null; return [{ type: 'text', text: t }]; }
    const last = req.messages.at(-1)!;
    const tool = (name: string, input: Record<string, unknown>): Block[] => [{ type: 'tool_use', id: `tu_${this.calls}_${name}`, name, input }];
    const say = (text: string): Block[] => [{ type: 'text', text }];

    // Continuing after tool results in this turn.
    if (Array.isArray(last.content)) {
      const prev = req.messages.at(-2)!;
      const used = (Array.isArray(prev.content) ? prev.content : []).find((b) => b.type === 'tool_use') as Extract<Block, { type: 'tool_use' }> | undefined;
      const res = JSON.parse((last.content[0] as Extract<Block, { type: 'tool_result' }>).content) as Record<string, any>;
      if (!res.ok) return say(`Sorry, I could not do that (${res.rejected}). Someone from the clinic will call you back.`);
      switch (used?.name) {
        case 'list_services': return tool('get_availability', { service_id: res.services[0].service_id, mode: res.services[0].modes.includes('clinic') ? 'clinic' : res.services[0].modes[0] });
        case 'get_availability': {
          const s = res.slots.slice(0, 3);
          return say(s.length ? `I can offer ${s.map((x: any) => `${x.when} with ${x.doctor_name}`).join(', or ')}. Which would you like?` : 'There are no free times this week. Shall I note your interest?');
        }
        case 'hold_slot': return say(`I have held ${res.when} with ${res.doctor} at ${res.place}. The fee is ${res.fee}. Shall I confirm the booking?`);
        case 'book_appointment': return say(`Done. Your appointment is booked for ${res.when}. Thank you!`);
        case 'request_handoff': return say('I will ask someone from the clinic to call you back.');
        case 'end_call': return say('Goodbye!');
        default: return say('Done.');
      }
    }

    const text = String(last.content).toLowerCase();
    const earlier = (name: string) => {
      const line = req.system.split('\n').reverse().find((l) => l.includes(`- ${name}(`));
      if (!line) return null;
      const arrow = line.indexOf('→ ');
      return { args: line.slice(line.indexOf('(') + 1, arrow - 2), result: line.slice(arrow + 2) };
    };
    if (/\b(dose|dosage)\b/.test(text)) return say('I cannot advise on medicines on the phone. The doctor will guide you at the consultation. Shall I book a visit?');
    if (/what disease|what do i have/.test(text)) return say('I am not able to say what it is over the phone. The doctor will examine you and explain. Would you like an appointment?');
    if (/definitely|guarantee/.test(text)) return say('Every person is different. The doctor will assess you and explain what to expect.');
    if (/how much|cost|price|fee/.test(text)) return say('The clinic will confirm the fee for that. Would you like me to book a consultation first?');
    if (/talk to (a )?(person|someone|human)/.test(text)) return tool('request_handoff', { reason: 'asked_for_person', note: 'Caller asked for a person' });
    if (/^(bye|goodbye|that's all)/.test(text)) return tool('end_call', { reason: 'caller said goodbye' });
    if (/the first one|first|pehla/.test(text)) {
      const av = earlier('get_availability');
      if (!av) return say('Sorry, which time would you like?');
      const args = JSON.parse(av.args.replace(/\.\.\.$/, '')) as { service_id: string; mode: string };
      const i = av.result.indexOf('"slots":[{');
      const j = i < 0 ? -1 : av.result.indexOf('}', i);
      if (i < 0 || j < 0) return say('Sorry, which time would you like?');
      const slot = JSON.parse(av.result.slice(i + 9, j + 1)) as { doctor_id: string; start: string; branch_id: string | null };
      return tool('hold_slot', { doctor_id: slot.doctor_id, service_id: args.service_id, mode: args.mode, start: slot.start, ...(slot.branch_id ? { branch_id: slot.branch_id } : {}) });
    }
    if (/^(yes|haan|ji haan|ok book|please book|yes please)/.test(text)) {
      const held = earlier('hold_slot');
      const id = held?.result.match(/"hold_id":"([^"]+)"/)?.[1];
      if (!id) return say('Which time shall I book?');
      return tool('book_appointment', { hold_id: id, confirmed_by_caller: true, full_name: 'Test Caller', reason: 'hair fall' });
    }
    if (/doctor|appointment|book|visit|dikhana/.test(text)) return tool('list_services', {});
    return say('How can I help you today?');
  }
}
