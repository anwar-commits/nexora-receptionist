import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Button, Card, Drawer, Empty, Field, Notice, Pill, SectionTitle, TextArea } from '../../components/ui';
import { ApiRequestError, api } from '../../lib/api';
import { errorText, useClinic, useClinicData, useSave } from '../../lib/clinic';
import { money as rupees, parseRupees, phoneLabel } from '../../lib/format';
import { METHOD_LABEL, type DayTotals, type Payment, type Receipt } from '../../lib/reception';
import { todayIn, useZone, type PatientView } from '../../lib/schedule';
import { PatientPicker } from '../schedule/Booking';

/** Collect money at the counter for a visit (or as an advance) and get a receipt. */
export function CollectDrawer({ target, onClose }: {
  target: { patient: { profileId: string; fullName: string; mrn: string } | null; appointmentId?: string; queueTokenId?: string; duePaise?: number; purpose?: string } | null;
  onClose: () => void;
}) {
  const [patient, setPatient] = useState<PatientView | null>(null);
  const [amount, setAmount] = useState(target?.duePaise ? String(target.duePaise / 100) : '');
  const [method, setMethod] = useState<'cash' | 'upi' | 'card'>('cash');
  const [reference, setReference] = useState('');
  const [purpose, setPurpose] = useState(target?.purpose ?? 'Consultation');
  const [key] = useState(() => crypto.randomUUID());
  const [done, setDone] = useState<Payment | null>(null);
  const paise = parseRupees(amount);
  const who = target?.patient ?? (patient ? { profileId: patient.id, fullName: patient.fullName, mrn: patient.mrn } : null);
  const save = useSave(() => api<Payment>('/payments', {
    method: 'POST',
    body: { patientProfileId: who!.profileId, appointmentId: target?.appointmentId, queueTokenId: target?.queueTokenId, amountPaise: paise, method, reference: reference || undefined, purpose, idempotencyKey: key },
  }), ['dues', 'payments', 'queue']);
  const bad = paise === null || Number.isNaN(paise) || paise < 100 || (target?.duePaise !== undefined && paise > target.duePaise);

  return (
    <Drawer title={done ? 'Payment received' : 'Collect payment'} onClose={onClose}>
      {done ? (
        <div className="flex flex-col gap-4">
          <Notice kind="ok"><b>{rupees(done.amountPaise)}</b> received by {METHOD_LABEL[done.method]} from {done.patient.fullName}. Receipt {done.receiptNumber}.</Notice>
          <div className="flex gap-2">
            <Link to={`/receipts/${done.id}`} target="_blank" className="inline-flex h-11 items-center rounded-[10px] bg-teal px-5 text-[15px] font-semibold text-white">Print receipt</Link>
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: setDone }); }}>
          {save.error ? <Notice>{errorText(save.error)}</Notice> : null}
          {target?.patient ? <div className="rounded-xl border border-line bg-surface px-4 py-3 text-sm"><b>{target.patient.fullName}</b> · {target.patient.mrn}{target.duePaise !== undefined ? <> · due <b>{rupees(target.duePaise)}</b></> : null}</div>
            : <PatientPicker value={patient} onChange={setPatient} />}
          <Field label="Amount (₹)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus={!!target?.patient}
            error={amount && bad ? (target?.duePaise !== undefined && paise !== null && paise > target.duePaise ? `At most ${rupees(target.duePaise)} is due` : 'Enter an amount like 500') : undefined} />
          <div role="radiogroup" aria-label="Payment method" className="flex gap-2">
            {(['cash', 'upi', 'card'] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={method === m} onClick={() => setMethod(m)}
                className={`h-11 flex-1 rounded-[10px] border text-sm font-semibold ${method === m ? 'border-teal bg-teal-tint text-[#0B5E57]' : 'border-line bg-surface text-ink-2'}`}>{METHOD_LABEL[m]}</button>
            ))}
          </div>
          {method !== 'cash' ? <Field label={method === 'upi' ? 'UPI reference (from the payment app)' : 'Card slip number (optional)'} value={reference} onChange={(e) => setReference(e.target.value)} /> : null}
          {!target?.appointmentId && !target?.queueTokenId ? <Field label="For" value={purpose} onChange={(e) => setPurpose(e.target.value)} hint="e.g. Advance for FUE, PRP session 3" /> : null}
          <Button variant="primary" type="submit" loading={save.isPending} disabled={!who || bad || (method === 'upi' && !reference.trim())}>Collect {paise && !Number.isNaN(paise) ? rupees(paise) : ''}</Button>
          <p className="text-xs text-ink-2">Payment links for patients to pay online arrive with the Razorpay integration.</p>
        </form>
      )}
    </Drawer>
  );
}

function RefundDrawer({ payment, onClose }: { payment: Payment; onClose: () => void }) {
  const left = payment.amountPaise - payment.refundedPaise;
  const [amount, setAmount] = useState(String(left / 100));
  const [reason, setReason] = useState('');
  const paise = parseRupees(amount);
  const save = useSave(() => api(`/payments/${payment.id}/refund`, { method: 'POST', body: { amountPaise: paise, reason } }), ['payments', 'dues']);
  return (
    <Drawer title={`Refund ${payment.receiptNumber}`} onClose={onClose}>
      {save.error ? <Notice>{errorText(save.error)}</Notice> : null}
      <p className="text-sm">{payment.patient.fullName} paid {rupees(payment.amountPaise)} by {METHOD_LABEL[payment.method]}{payment.refundedPaise ? `; ${rupees(payment.refundedPaise)} already refunded` : ''}.</p>
      <Field label="Refund (₹)" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Charged twice for PRP session" />
      <p className="text-xs text-ink-2">Give the money back by the same method ({METHOD_LABEL[payment.method]}). This records the refund; card and UPI reversals go through your terminal or bank.</p>
      <Button variant="primary" loading={save.isPending} disabled={!paise || Number.isNaN(paise) || paise > left || reason.trim().length < 3} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>Record refund</Button>
    </Drawer>
  );
}

/** The day's collection: what came in, by method and by person, and refunds. */
export function PaymentsPage() {
  const { orgId, can } = useClinic();
  const { branches } = useClinicData();
  const zone = useZone();
  const [params, setParams] = useSearchParams();
  const date = params.get('date') ?? todayIn(zone);
  const branch = params.get('branch') ?? '';
  const [collect, setCollect] = useState(false);
  const [refund, setRefund] = useState<Payment | null>(null);
  const data = useQuery({
    queryKey: ['payments', orgId, date, branch],
    queryFn: () => api<{ date: string; branchId: string; items: Payment[]; totals: DayTotals }>(`/payments?date=${date}${branch ? `&branchId=${branch}` : ''}`),
    enabled: can('payment:collect'),
  });
  if (!can('payment:collect')) return <Notice>Your role does not handle payments.</Notice>;
  const t = data.data?.totals;
  return (
    <div className="flex flex-col gap-5">
      <SectionTitle title="Payments" subtitle="Money taken at the desk. Use this to close the day: count the cash drawer against the cash total."
        action={<Button variant="primary" onClick={() => setCollect(true)}>+ Collect payment</Button>} />
      <div className="flex flex-wrap items-center gap-3">
        <input type="date" aria-label="Day" value={date} onChange={(e) => e.target.value && setParams((p) => { p.set('date', e.target.value); return p; })} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm" />
        {(branches.data?.length ?? 0) > 1 ? (
          <select aria-label="Branch" value={branch || data.data?.branchId || ''} onChange={(e) => setParams((p) => { p.set('branch', e.target.value); return p; })} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm">
            {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        ) : null}
      </div>
      {data.error ? <Notice>{errorText(data.error)}</Notice> : null}
      {t ? (
        <div className="grid gap-4 md:grid-cols-4">
          <Card className="p-4"><div className="text-xs font-bold tracking-[.06em] text-ink-2">NET</div><div className="mt-1 text-2xl font-bold">{rupees(t.netPaise)}</div><div className="text-xs text-ink-2">{rupees(t.collectedPaise)} in · {rupees(t.refundedPaise)} refunded</div></Card>
          {(['cash', 'upi', 'card'] as const).map((m) => (
            <Card key={m} className="p-4"><div className="text-xs font-bold tracking-[.06em] text-ink-2">{METHOD_LABEL[m].toUpperCase()}</div>
              <div className="mt-1 text-2xl font-bold">{rupees((t.byMethod[m]?.collectedPaise ?? 0) - (t.byMethod[m]?.refundedPaise ?? 0))}</div>
              <div className="text-xs text-ink-2">{t.byMethod[m]?.count ?? 0} payment{t.byMethod[m]?.count === 1 ? '' : 's'}{t.byMethod[m]?.refundedPaise ? ` · ${rupees(t.byMethod[m]!.refundedPaise)} refunded` : ''}</div></Card>
          ))}
        </div>
      ) : null}
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[#FBF9F4] text-left text-[11px] font-bold tracking-[.06em] text-ink-2"><tr><th className="px-4 py-2.5">TIME</th><th className="px-4">RECEIPT</th><th className="px-4">PATIENT</th><th className="px-4">FOR</th><th className="px-4">METHOD</th><th className="px-4 text-right">AMOUNT</th><th className="px-4">BY</th><th /></tr></thead>
          <tbody>
            {data.data?.items.map((p) => (
              <tr key={p.id} className="border-t border-line-2">
                <td className="px-4 py-2.5">{DateTime.fromISO(p.at).setZone(zone).toFormat('h:mm a')}</td>
                <td className="px-4 font-mono"><Link to={`/receipts/${p.id}`} target="_blank" className="text-teal">{p.receiptNumber}</Link></td>
                <td className="px-4"><Link to={`/patients/${p.patient.profileId}`} className="font-semibold">{p.patient.fullName}</Link></td>
                <td className="px-4">{p.purpose}</td>
                <td className="px-4">{METHOD_LABEL[p.method]}{p.reference ? <span className="text-ink-2"> · {p.reference}</span> : null}</td>
                <td className="px-4 text-right font-mono">{rupees(p.amountPaise)}{p.refundedPaise ? <div className="text-xs text-warn-ink">−{rupees(p.refundedPaise)}</div> : null}</td>
                <td className="px-4">{p.collectedBy}</td>
                <td className="px-4 text-right">{p.status === 'refunded' ? <Pill>Refunded</Pill> : can('payment:refund') ? <button type="button" onClick={() => setRefund(p)} className="text-[13px] font-semibold text-teal">Refund…</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.data?.items.length === 0 ? <div className="p-4"><Empty>No payments on this day.</Empty></div> : null}
      </Card>
      {t && Object.keys(t.byPerson).length ? <p className="text-sm text-ink-2">Collected by: {Object.entries(t.byPerson).map(([n, v]) => `${n} ${rupees(v)}`).join(' · ')}</p> : null}
      {collect ? <CollectDrawer target={null} onClose={() => setCollect(false)} /> : null}
      {refund ? <RefundDrawer payment={refund} onClose={() => setRefund(null)} /> : null}
    </div>
  );
}

/** Printable receipt, opened in its own tab. */
export function ReceiptPage() {
  const { id = '' } = useParams();
  const r = useQuery({ queryKey: ['receipt', id], queryFn: () => api<Receipt>(`/payments/${id}/receipt`), retry: false });
  if (r.error) return <div className="p-8"><Notice>{r.error instanceof ApiRequestError ? r.error.message : 'Could not load the receipt'}</Notice></div>;
  if (!r.data) return <p className="p-8 text-ink-2">Loading…</p>;
  const x = r.data;
  return (
    <div className="mx-auto my-8 max-w-[560px] bg-white p-8 text-[14px] text-ink shadow print:my-0 print:shadow-none">
      <div className="flex items-start">
        <div>
          <div className="font-display text-xl font-bold">{x.clinic.name}</div>
          {x.clinic.legalName ? <div>{x.clinic.legalName}</div> : null}
          <div className="text-ink-2">{[x.clinic.branch, x.clinic.address].filter(Boolean).join(' · ')}</div>
          {x.clinic.phone ? <div className="text-ink-2">{phoneLabel(x.clinic.phone)}</div> : null}
          {x.clinic.gstin ? <div className="text-ink-2">GSTIN {x.clinic.gstin}</div> : null}
        </div>
        <div className="ml-auto text-right"><div className="text-xs font-bold tracking-[.08em] text-ink-2">PAYMENT RECEIPT</div><div className="font-mono text-base font-bold">{x.receiptNumber}</div><div>{DateTime.fromISO(x.at).setZone(x.timeZone).toFormat('d LLL yyyy, h:mm a')}</div></div>
      </div>
      <hr className="my-5 border-line" />
      <div className="grid grid-cols-[120px_1fr] gap-y-1.5">
        <span className="text-ink-2">Received from</span><span><b>{x.patient.fullName}</b> · {x.patient.mrn} · {phoneLabel(x.patientPhone)}</span>
        <span className="text-ink-2">For</span><span>{x.purpose}</span>
        <span className="text-ink-2">Paid by</span><span>{METHOD_LABEL[x.method]}{x.reference ? ` · ref ${x.reference}` : ''}</span>
        <span className="text-ink-2">Received by</span><span>{x.collectedBy}</span>
      </div>
      <div className="mt-5 flex items-baseline rounded-lg bg-[#F3F0E9] px-4 py-3"><span className="font-semibold">Amount received</span><span className="ml-auto font-mono text-xl font-bold">{rupees(x.amountPaise)}</span></div>
      {x.refundedPaise ? <div className="mt-2 text-right text-warn-ink">Refunded {rupees(x.refundedPaise)}</div> : null}
      <p className="mt-6 text-xs text-ink-2">This is a payment receipt, not a tax invoice.</p>
      <div className="mt-6 flex gap-2 print:hidden"><Button variant="primary" onClick={() => window.print()}>Print</Button><Button onClick={() => window.close()}>Close</Button></div>
    </div>
  );
}
