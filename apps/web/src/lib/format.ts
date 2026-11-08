/** Money is integer paise on the wire; the UI shows and edits rupees. */
export const rupees = (paise: number | null | undefined) =>
  paise === null || paise === undefined ? 'After assessment' : paise === 0 ? 'Free' : `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** "1,500" or "1500.50" → 150050 paise; empty → null; invalid → NaN. */
export function parseRupees(text: string): number | null {
  const t = text.replace(/[₹,\s]/g, '');
  if (t === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return Number.NaN;
  return Math.round(Number(t) * 100);
}

export const DAYS = [
  { key: 'mon', short: 'Mon', long: 'Monday' },
  { key: 'tue', short: 'Tue', long: 'Tuesday' },
  { key: 'wed', short: 'Wed', long: 'Wednesday' },
  { key: 'thu', short: 'Thu', long: 'Thursday' },
  { key: 'fri', short: 'Fri', long: 'Friday' },
  { key: 'sat', short: 'Sat', long: 'Saturday' },
  { key: 'sun', short: 'Sun', long: 'Sunday' },
] as const;

export const MODE_LABEL = { clinic: 'Clinic', video: 'Video', phone: 'Phone' } as const;

export const minutesLabel = (m: number) => (m >= 60 && m % 60 === 0 ? `${m / 60} h` : m > 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

/** "+919812345670" → "+91 98123 45670"; other numbers unchanged. */
export const phoneLabel = (e164: string) => (/^\+91\d{10}$/.test(e164) ? `+91 ${e164.slice(3, 8)} ${e164.slice(8)}` : e164);

/** Money amounts (collected, due, refunded): always a number, ₹0 included. Use rupees() for prices. */
export const money = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
