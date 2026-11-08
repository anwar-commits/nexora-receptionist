import { describe, expect, it } from 'vitest';
import { parseWhatsAppWebhook, windowOpen } from '../src/lib/messaging.js';

describe('WhatsApp webhook parsing', () => {
  it('reads text, button and list replies, and ignores what it does not understand', () => {
    const out = parseWhatsAppWebhook({
      object: 'whatsapp_business_account',
      entry: [{ changes: [
        { field: 'messages', value: {
          contacts: [{ wa_id: '919800000001', profile: { name: 'Asha' } }],
          messages: [
            { id: 'w1', from: '919800000001', timestamp: '1762600000', type: 'text', text: { body: 'Hi' } },
            { id: 'w2', from: '919800000001', timestamp: '1762600001', type: 'button', button: { text: 'Confirm' } },
            { id: 'w3', from: '919800000001', timestamp: '1762600002', type: 'interactive', interactive: { list_reply: { title: 'Tomorrow 11 AM' } } },
            { id: 'w4', from: '919800000001', timestamp: '1762600003', type: 'image' },
            { id: 'bad', from: 'not-a-number', type: 'text', text: { body: 'x' } },
          ],
          statuses: [{ id: 'o1', status: 'delivered' }, { id: 'o2', status: 'weird' }, { id: 'o3', status: 'failed', errors: [{ title: 'Re-engagement message' }] }],
        } },
        { field: 'account_update', value: { anything: true } },
      ] }],
    });
    expect(out.messages.map((m) => [m.vendorMessageId, m.fromE164, m.text, m.profileName])).toEqual([
      ['w1', '+919800000001', 'Hi', 'Asha'], ['w2', '+919800000001', 'Confirm', 'Asha'], ['w3', '+919800000001', 'Tomorrow 11 AM', 'Asha'], ['w4', '+919800000001', null, 'Asha'],
    ]);
    expect(out.messages[0]!.at.toISOString()).toBe(new Date(1762600000 * 1000).toISOString());
    expect(out.statuses).toEqual([{ vendorMessageId: 'o1', status: 'delivered', error: null }, { vendorMessageId: 'o3', status: 'failed', error: 'Re-engagement message' }]);
    expect(parseWhatsAppWebhook({ object: 'page', entry: [] })).toEqual({ messages: [], statuses: [] });
    expect(parseWhatsAppWebhook(null)).toEqual({ messages: [], statuses: [] });
  });

  it('applies the 24-hour reply window', () => {
    const now = new Date('2026-11-08T12:00:00Z');
    expect(windowOpen(null, now)).toBe(false);
    expect(windowOpen(new Date('2026-11-07T12:00:01Z'), now)).toBe(true);
    expect(windowOpen(new Date('2026-11-07T12:00:00Z'), now)).toBe(false);
  });
});
