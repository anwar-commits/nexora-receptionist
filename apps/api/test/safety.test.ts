import { describe, expect, it } from 'vitest';
import { detectLang, detectRedFlag, guardOutput, safetyScript } from '../src/voice/safety.js';

describe('red-flag detector', () => {
  const emergencies: [string, string][] = [
    ['I have chest pain since morning', 'chest_pain'],
    ['mere papa ko seene mein dard ho raha hai', 'chest_pain'],
    ['मेरे सीने में दर्द हो रहा है', 'chest_pain'],
    ['আমার বুকে ব্যথা করছে', 'chest_pain'],
    ['میرے سینے میں درد ہے', 'chest_pain'],
    ["I can't breathe properly", 'breathing'],
    ['saans lene mein bahut takleef ho rahi hai', 'breathing'],
    ['मुझे सांस लेने में तकलीफ है', 'breathing'],
    ['transplant ke baad khoon nahi ruk raha', 'severe_bleeding'],
    ['the bleeding won\'t stop after the procedure', 'severe_bleeding'],
    ['আমার মা অজ্ঞান হয়ে গেছে', 'unconscious'],
    ['my father just collapsed', 'unconscious'],
    ['his face is drooping and speech is slurred', 'stroke'],
    ['bachche ko mirgi ka daura pad raha hai', 'seizure'],
    ['my throat is closing after the injection', 'anaphylaxis'],
    ['galti se zeher pi liya', 'poisoning'],
    ['I am pregnant and bleeding', 'pregnancy_bleeding'],
  ];
  it.each(emergencies)('flags "%s" as %s', (text, key) => {
    expect(detectRedFlag(text)).toMatchObject({ kind: 'emergency_redirect', key });
  });

  const selfHarm = ['I want to end my life', 'main khud ko khatam karna chahta hoon', 'मैं आत्महत्या करना चाहती हूँ', 'میں خودکشی کرنا چاہتا ہوں', 'আমি মরে যেতে চাই'];
  it.each(selfHarm)('flags "%s" as self-harm', (text) => {
    expect(detectRedFlag(text)).toMatchObject({ kind: 'self_harm_risk', key: 'self_harm' });
  });

  const ordinary = [
    'I want to book an appointment for hair fall',
    'mujhe hair transplant ka cost janna hai',
    'kal subah 10 baje ka slot milega?',
    'my gums bleed a little when I brush',
    'after the transplant there is mild swelling on my forehead',
    'I have dandruff and itching on my scalp',
    'আমি অ্যাপয়েন্টমেন্ট নিতে চাই',
    'مجھے اپائنٹمنٹ چاہیے',
    'मुझे बालों के झड़ने के लिए अपॉइंटमेंट चाहिए',
    'can you tell me the PRP price',
  ];
  it.each(ordinary)('does not flag "%s"', (text) => {
    expect(detectRedFlag(text)).toBeNull();
  });

  it('answers in the caller\'s language', () => {
    expect(detectLang('मुझे अपॉइंटमेंट चाहिए')).toBe('hi');
    expect(detectLang('mujhe appointment chahiye')).toBe('hi-Latn');
    expect(detectLang('I need an appointment')).toBe('en');
    expect(detectLang('আমি অ্যাপয়েন্টমেন্ট চাই')).toBe('bn');
    expect(detectLang('مجھے اپائنٹمنٹ چاہیے')).toBe('ur');
    expect(safetyScript({ kind: 'emergency_redirect', key: 'chest_pain', match: '' }, 'hi-Latn')).toContain('112');
    expect(safetyScript({ kind: 'self_harm_risk', key: 'self_harm', match: '' }, 'en')).toContain('14416');
  });
});

describe('output guard', () => {
  const blocked: [string, string][] = [
    ['You should take 5 mg finasteride every day.', 'dose'],
    ['Minoxidil 5% lagaiye din mein do baar.', 'dose'],
    ['Please apply ketoconazole shampoo on your scalp.', 'medication_advice'],
    ['Dandruff ke liye yeh dawai lijiye.', 'medication_advice'],
    ['You have androgenetic alopecia.', 'diagnosis'],
    ['Aapko fungal infection lagta hai.', 'diagnosis'],
    ['The transplant will definitely work for you.', 'outcome_promise'],
    ['We guarantee 100% results.', 'outcome_promise'],
  ];
  it.each(blocked)('blocks "%s" (%s)', (text, reason) => {
    const r = guardOutput(text, 'en');
    expect(r).toMatchObject({ ok: false, reason });
    expect(r.text).toContain('doctor');
  });
  const fine = [
    'The consultation fee is ₹500.',
    'Dr. Mehta is free tomorrow at 10:30 AM. Shall I book it?',
    'We have 20% off on PRP this month.',
    'Please bring your previous prescriptions and the list of medicines you take.',
    'Dr. Mehta treats alopecia, dandruff and hair fall.',
    'Main aapke liye kal 11 baje ka slot hold kar rahi hoon.',
  ];
  it.each(fine)('allows "%s"', (text) => {
    expect(guardOutput(text, 'en')).toEqual({ ok: true, text });
  });
});
