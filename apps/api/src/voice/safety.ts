/**
 * Server-side safety for the AI receptionist. Deterministic, so it holds whatever the model does:
 *  1. detectRedFlag(): runs on every caller turn BEFORE the model. An emergency or self-harm
 *     statement forces the scripted response; the model is not asked.
 *  2. guardOutput(): runs on every AI reply BEFORE it is spoken. Medicine advice, doses,
 *     diagnoses and promised results are replaced with a safe line.
 * Covers English, Hindi (Devanagari), Hinglish (Roman Hindi), Bengali and Urdu.
 * It errs towards triggering: a caller who says "no chest pain" still hears the emergency line once.
 */

export type Lang = 'en' | 'hi' | 'hi-Latn' | 'bn' | 'ur';
export type RedFlagKind = 'emergency_redirect' | 'self_harm_risk';
export interface RedFlag { kind: RedFlagKind; key: string; match: string }

interface Rule { key: string; kind: RedFlagKind; patterns: RegExp[] }

// Patterns are matched against lower-cased text with punctuation kept. \b does not work for
// Indic scripts, so those patterns are plain substrings.
const RULES: Rule[] = [
  // Self-harm first: it needs a different script.
  {
    key: 'self_harm', kind: 'self_harm_risk', patterns: [
      /\b(kill|hurt|harm) (myself|my self)|\bend (my|it all|my own) life|\bsuicid|\bwant to die|\bdon'?t want to live|\bself[- ]harm/,
      /\b(khud|apne aap|apne ko) ko (maar|mar|khatam|nuksan)|\b(marna|mar jana|mar jaana) chah(ta|ti)|\baatma?hatya|\bjeena nahi chah/,
      /आत्महत्या|मरना चाहत|खुद को (मार|ख़त्म|खत्म)|जीना नहीं चाहत/, /আত্মহত্যা|মরে যেতে চাই|বাঁচতে চাই না/, /خودکشی|مرنا چاہت|خود کو مار/,
    ],
  },
  {
    key: 'chest_pain', kind: 'emergency_redirect', patterns: [
      /\bchest (pain|is (hurting|tight|heavy))|\bpain in (my |his |her )?chest|\bheart attack/,
      /\b(seene|sine|chhati|chaati) (me|mein|main) .{0,20}(dard|bhaari|jakdan)|\bdil ka daura|\bheart attack/,
      /सीने में.{0,15}दर्द|छाती में.{0,15}दर्द|दिल का दौरा/, /বুকে.{0,15}ব্যথা|হার্ট অ্যাটাক/, /سینے میں.{0,15}درد|دل کا دورہ/,
    ],
  },
  {
    key: 'breathing', kind: 'emergency_redirect', patterns: [
      /\b(can'?t|cannot|unable to|not able to) breathe|\b(difficulty|trouble) breathing|\bshort(ness)? of breath|\bchoking\b|\bgasping/,
      /\bsaa?ns (nahi|nahin|nai) (aa|le|lay)|\bsaa?ns lene (me|mein) .{0,20}(dikkat|takleef|taklif|pareshani)|\bdam ghut/,
      /सांस नहीं|साँस नहीं|सांस लेने में|साँस लेने में|दम घुट/, /শ্বাস নিতে কষ্ট|শ্বাসকষ্ট|দম বন্ধ/, /سانس نہیں|سانس لینے میں|دم گھٹ/,
    ],
  },
  {
    key: 'severe_bleeding', kind: 'emergency_redirect', patterns: [
      /\b(heavy|severe|lot of|lots of) bleeding|\bbleeding (heavily|a lot|badly|won'?t stop|will not stop|is not stopping|not stopping|doesn'?t stop)|\bwon'?t stop bleeding/,
      /\b(khoon|khun) (nahi|nahin|nai) ruk|\bbahut (khoon|khun) (beh|nikal|aa)/,
      /खून नहीं रुक|बहुत खून/, /রক্ত বন্ধ হচ্ছে না|অনেক রক্ত/, /خون نہیں رک|بہت خون/,
    ],
  },
  {
    key: 'unconscious', kind: 'emergency_redirect', patterns: [
      /\bunconscious|\bpassed out|\bfainted|\bnot responding|\bcollapsed|\bbehosh/,
      /बेहोश/, /অজ্ঞান|জ্ঞান হারিয়ে/, /بے ہوش|بیہوش/,
    ],
  },
  {
    key: 'stroke', kind: 'emergency_redirect', patterns: [
      /\bface (is )?(drooping|droopy)|\bslurred speech|\bspeech (is )?slurred|\bcan'?t move (my |his |her )?(arm|leg|one side)|\bhaving a stroke|\blakwa|\bparalysis attack/,
      /लकवा/, /স্ট্রোক|পক্ষাঘাত/, /فالج/,
    ],
  },
  {
    key: 'seizure', kind: 'emergency_redirect', patterns: [
      /\bseizure|\bconvulsion|\bhaving fits|\bmirgi|\bdaura (pad|pa)/,
      /मिर्गी|दौरा पड़/, /খিঁচুনি/, /مرگی|دورہ پڑ/,
    ],
  },
  {
    key: 'anaphylaxis', kind: 'emergency_redirect', patterns: [
      /\bthroat\b.{0,15}\b(closing|swelling|swollen)|\bswelling (in|of) (my |his |her )?(throat|tongue|lips)|\b(lips|tongue)\b.{0,20}\b(swell|swollen)|\bsevere allergic|\banaphyla/,
      /\bgala (sooj|band ho)|\bgale (me|mein) sujan/,
      /गला सूज|गला बंद/, /গলা ফুলে/, /گلا سوج|گلا بند/,
    ],
  },
  {
    key: 'poisoning', kind: 'emergency_redirect', patterns: [
      /\bpoison|\boverdose|\bswallowed .{0,15}\b(pills|tablets|medicines?|acid|bleach|phenyl)|\bzeh?e?r (pi|kha)|\bzah?e?r (pi|kha)/,
      /ज़हर|जहर/, /বিষ খে/, /زہر/,
    ],
  },
  {
    key: 'pregnancy_bleeding', kind: 'emergency_redirect', patterns: [
      /\bpregnan\w*.{0,40}\bbleed|\bbleed\w*.{0,40}\bpregnan|\bpregnant.{0,40}\b(khoon|khun)/,
      /गर्भ.{0,30}खून/, /গর্ভ.{0,30}রক্ত/, /حمل.{0,30}خون/,
    ],
  },
];

export function detectRedFlag(text: string): RedFlag | null {
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  for (const rule of RULES) {
    for (const p of rule.patterns) {
      const m = t.match(p);
      if (m) return { kind: rule.kind, key: rule.key, match: m[0] };
    }
  }
  return null;
}

/** Guess the caller's language from the script and common Hinglish words. */
export function detectLang(text: string, fallback: Lang = 'en'): Lang {
  if (/[ऀ-ॿ]/.test(text)) return 'hi';
  if (/[ঀ-৿]/.test(text)) return 'bn';
  if (/[؀-ۿ]/.test(text)) return 'ur';
  if (/\b(hai|hain|nahi|nahin|kya|mujhe|mera|meri|aap|kal|karna|chahiye|chahta|chahti|kitna|kaun|kyun|hoon|raha|rahi|bhai|ji)\b/i.test(text)) return 'hi-Latn';
  return /[a-z]/i.test(text) ? 'en' : fallback;
}

export const EMERGENCY_NUMBER = '112';
/** Tele-MANAS, India's national mental-health helpline (free, 24x7). */
export const MENTAL_HEALTH_HELPLINE = '14416';

const EMERGENCY_SCRIPT: Record<Lang, string> = {
  en: `This could be a medical emergency. Please call ${EMERGENCY_NUMBER} right now, or go to the nearest hospital emergency. I am alerting the clinic team. Is someone with you?`,
  'hi-Latn': `Yeh medical emergency ho sakti hai. Kripya abhi ${EMERGENCY_NUMBER} par call kijiye, ya sabse nazdeeki hospital emergency mein jaaiye. Main clinic team ko abhi bata rahi hoon. Kya aapke saath koi hai?`,
  hi: `यह मेडिकल इमरजेंसी हो सकती है। कृपया अभी ${EMERGENCY_NUMBER} पर कॉल करें, या सबसे नज़दीकी अस्पताल की इमरजेंसी में जाएँ। मैं क्लिनिक टीम को अभी बता रही हूँ। क्या आपके साथ कोई है?`,
  bn: `এটা জরুরি অবস্থা হতে পারে। এখনই ${EMERGENCY_NUMBER} নম্বরে ফোন করুন, বা নিকটতম হাসপাতালের জরুরি বিভাগে যান। আমি ক্লিনিক টিমকে জানাচ্ছি। আপনার সঙ্গে কেউ আছেন?`,
  ur: `یہ میڈیکل ایمرجنسی ہو سکتی ہے۔ براہِ کرم ابھی ${EMERGENCY_NUMBER} پر کال کریں، یا قریبی ہسپتال کی ایمرجنسی میں جائیں۔ میں کلینک ٹیم کو ابھی بتا رہی ہوں۔ کیا آپ کے ساتھ کوئی ہے؟`,
};
const SELF_HARM_SCRIPT: Record<Lang, string> = {
  en: `I'm really glad you told me. You don't have to go through this alone. Please call Tele-MANAS on ${MENTAL_HEALTH_HELPLINE}, free and any time, or ${EMERGENCY_NUMBER} if you are in danger right now. I am letting the clinic team know so someone can call you. Are you safe right now?`,
  'hi-Latn': `Aapne bataya, yeh bahut achha kiya. Aap akele nahi hain. Kripya Tele-MANAS ko ${MENTAL_HEALTH_HELPLINE} par call kijiye, yeh muft hai aur hamesha khula hai, ya agar abhi khatra hai to ${EMERGENCY_NUMBER} par. Main clinic team ko bata rahi hoon taaki koi aapko call kare. Kya aap abhi surakshit hain?`,
  hi: `आपने बताया, यह बहुत अच्छा किया। आप अकेले नहीं हैं। कृपया टेली-मानस को ${MENTAL_HEALTH_HELPLINE} पर कॉल करें, यह मुफ़्त है और हमेशा खुला है, या अगर अभी ख़तरा है तो ${EMERGENCY_NUMBER} पर। मैं क्लिनिक टीम को बता रही हूँ ताकि कोई आपको कॉल करे। क्या आप अभी सुरक्षित हैं?`,
  bn: `আপনি বলেছেন, খুব ভালো করেছেন। আপনি একা নন। দয়া করে টেলি-মানস ${MENTAL_HEALTH_HELPLINE} নম্বরে ফোন করুন, বিনামূল্যে এবং সবসময় খোলা, বা এখনই বিপদ হলে ${EMERGENCY_NUMBER}। আমি ক্লিনিক টিমকে জানাচ্ছি যাতে কেউ আপনাকে ফোন করে। আপনি কি এখন নিরাপদ?`,
  ur: `آپ نے بتایا، یہ بہت اچھا کیا۔ آپ اکیلے نہیں ہیں۔ براہِ کرم ٹیلی-مانس کو ${MENTAL_HEALTH_HELPLINE} پر کال کریں، یہ مفت ہے اور ہر وقت کھلا ہے، یا اگر ابھی خطرہ ہے تو ${EMERGENCY_NUMBER} پر۔ میں کلینک ٹیم کو بتا رہی ہوں تاکہ کوئی آپ کو کال کرے۔ کیا آپ ابھی محفوظ ہیں؟`,
};
/** The approved scripts, shown to the doctor or owner who signs off the emergency protocol. */
export const SAFETY_SCRIPTS = { emergency: EMERGENCY_SCRIPT, selfHarm: SELF_HARM_SCRIPT };
export const safetyScript = (flag: RedFlag, lang: Lang) => (flag.kind === 'self_harm_risk' ? SELF_HARM_SCRIPT : EMERGENCY_SCRIPT)[lang];

// ---------------------------------------------------------------------------
// Output guard
// ---------------------------------------------------------------------------
export interface GuardResult { ok: boolean; text: string; reason?: 'dose' | 'medication_advice' | 'diagnosis' | 'outcome_promise' }

const MEDS = 'tablet|tablets|capsule|capsules|syrup|ointment|lotion|serum|minoxidil|finasteride|dutasteride|biotin|antibiotic|antibiotics|steroid|steroids|paracetamol|ibuprofen|ketoconazole|isotretinoin|tretinoin|dawai|dawa|goli|golian|davai|medicine|medicines';
const OUT_RULES: { reason: GuardResult['reason']; re: RegExp }[] = [
  { reason: 'dose', re: /\b\d+(\.\d+)?\s?(mg|mcg|µg|ml)\b|\b\d+(\.\d+)?\s?%\s*(solution|lotion|cream|gel|serum|foam|minoxidil)/i },
  { reason: 'dose', re: /\b(once|twice|thrice|\d+ times) (a|per) (day|daily|week)\b|\b(din me|din mein) (do|teen|ek) baar\b/i },
  { reason: 'medication_advice', re: new RegExp(`\\b(take|apply|start|stop|continue|use|try|lijiye|lagaiye|khaiye|band kijiye|shuru kijiye|le lijiye)\\b.{0,40}\\b(${MEDS})\\b`, 'i') },
  { reason: 'medication_advice', re: new RegExp(`\\b(${MEDS})\\b.{0,30}\\b(lijiye|lagaiye|khaiye|band kar|le sakte|use kar|should take|should apply|you can take|you can use)\\b`, 'i') },
  { reason: 'diagnosis', re: /\b(you (have|probably have|might have|may have|are suffering from|seem to have)|it (is|sounds like|looks like) (a |an )?(case of )?)\s?(alopecia|androgenetic|telogen|infection|fungal|psoriasis|eczema|dermatitis|thyroid|pcos|cancer|diabetes|vitiligo|acne vulgaris)/i },
  { reason: 'diagnosis', re: /\baapko\b.{0,30}\b(alopecia|infection|fungal|psoriasis|eczema|thyroid|pcos|bimari)\b.{0,15}\b(hai|ho sakta|ho sakti|lagta)/i },
  { reason: 'outcome_promise', re: /\b(guarantee[ds]?|100\s?%|definitely (grow|work|cure)|will definitely|permanent(ly)? cure|cure (it|this) completely|pakka (ilaj|ilaaj|theek|result)|zaroor theek)\b/i },
];
const SAFE_LINE: Record<Lang, string> = {
  en: "I can't advise on medicines, diagnosis or results over the phone — the doctor will guide you properly at the consultation. Shall I book a visit for you?",
  'hi-Latn': 'Phone par main dawai, bimari ya result ke baare mein salah nahi de sakti — doctor consultation mein aapko sahi se batayenge. Kya main aapke liye appointment book kar doon?',
  hi: 'फ़ोन पर मैं दवाई, बीमारी या रिज़ल्ट के बारे में सलाह नहीं दे सकती — डॉक्टर कंसल्टेशन में आपको सही से बताएँगे। क्या मैं आपके लिए अपॉइंटमेंट बुक कर दूँ?',
  bn: 'ফোনে আমি ওষুধ, রোগ বা ফলাফল নিয়ে পরামর্শ দিতে পারি না — ডাক্তার কনসালটেশনে ঠিকভাবে জানাবেন। আমি কি আপনার জন্য অ্যাপয়েন্টমেন্ট বুক করে দেব?',
  ur: 'فون پر میں دوا، بیماری یا نتیجے کے بارے میں مشورہ نہیں دے سکتی — ڈاکٹر کنسلٹیشن میں آپ کو صحیح بتائیں گے۔ کیا میں آپ کے لیے اپائنٹمنٹ بک کر دوں؟',
};

export function guardOutput(text: string, lang: Lang): GuardResult {
  for (const r of OUT_RULES) if (r.re.test(text)) return { ok: false, text: SAFE_LINE[lang], reason: r.reason };
  return { ok: true, text };
}

/** Spoken at the start of every call, in the caller's language (calls are recorded by default). */
export const RECORDING_NOTICE: Record<Lang, string> = {
  en: 'This call is answered by an AI assistant and may be recorded for quality and your care.',
  'hi-Latn': 'Yeh call AI assistant attend kar rahi hai aur quality aur aapki care ke liye record ho sakti hai.',
  hi: 'यह कॉल एक AI असिस्टेंट ले रही है और गुणवत्ता व आपकी देखभाल के लिए रिकॉर्ड हो सकती है।',
  bn: 'এই কলটি একটি AI সহকারী ধরছে এবং মান ও আপনার যত্নের জন্য রেকর্ড হতে পারে।',
  ur: 'یہ کال ایک AI اسسٹنٹ لے رہی ہے اور معیار اور آپ کی دیکھ بھال کے لیے ریکارڈ ہو سکتی ہے۔',
};
