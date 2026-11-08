import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, Card, Empty, Field, Notice, Pill, Select, TextArea } from '../../components/ui';
import { api } from '../../lib/api';
import { errorText, useClinic, useSave } from '../../lib/clinic';
import { phoneLabel } from '../../lib/format';
import { useConversations, type ChannelAccount, type Thread } from '../../lib/reception';
import { useZone } from '../../lib/schedule';

const FILTERS = [
  { key: 'open', label: 'Open', qs: 'status=open' },
  { key: 'mine', label: 'Mine', qs: 'status=open&mine=1' },
  { key: 'unassigned', label: 'Unassigned', qs: 'status=open&unassigned=1' },
  { key: 'closed', label: 'Closed', qs: 'status=closed' },
] as const;
const TICKS: Record<string, string> = { queued: '…', sent: '✓', delivered: '✓✓', read: '✓✓ read', failed: 'Not sent' };
const when = (iso: string | null, zone: string) => {
  if (!iso) return '';
  const d = DateTime.fromISO(iso).setZone(zone);
  return d.hasSame(DateTime.now().setZone(zone), 'day') ? d.toFormat('h:mm a') : d.toFormat('d LLL');
};

function ThreadView({ id }: { id: string }) {
  const { orgId, can } = useClinic();
  const zone = useZone();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<{ user: { id: string } }>('/me', { org: false }) });
  const t = useQuery({ queryKey: ['conversation', orgId, id], queryFn: () => api<Thread>(`/conversations/${id}`), refetchInterval: 10_000 });
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const keys = ['conversation', 'conversations', 'lead', 'leads'];
  const send = useSave(() => api(`/conversations/${id}/messages`, { method: 'POST', body: { body: text } }), keys);
  const update = useSave((body: Record<string, unknown>) => api(`/conversations/${id}`, { method: 'PATCH', body }), keys);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [t.data?.messages.length]);
  if (!t.data) return t.error ? <Notice>{errorText(t.error)}</Notice> : <p className="text-ink-2">Loading…</p>;
  const c = t.data;
  const canReply = can('inbox:reply');
  const submit = (e: FormEvent) => { e.preventDefault(); send.mutate(undefined, { onSuccess: () => setText('') }); };

  return (
    <Card className="flex h-[calc(100vh-200px)] min-h-[480px] flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
        <div className="min-w-0">
          <div className="font-display text-lg font-bold">{c.party.name ?? (c.party.phone ? phoneLabel(c.party.phone) : 'Unknown')}</div>
          <div className="text-xs text-ink-2">
            {c.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} · {c.party.phone ? phoneLabel(c.party.phone) : ''} · to {c.account.name ?? c.account.address}
            {c.account.isTest ? <span className="ml-1"><Pill tone="warn">Test channel</Pill></span> : null}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {c.party.patient ? <Link to={`/patients/${c.party.patient.profileId}`} className="text-[13px] font-semibold text-teal">Patient {c.party.patient.mrn} →</Link> : null}
          {c.party.lead ? <Link to={`/pipeline?lead=${c.party.lead.id}`} className="text-[13px] font-semibold text-teal">Lead →</Link> : null}
          {canReply && me.data && c.assignee?.id !== me.data.user.id ? <Button className="h-9" onClick={() => update.mutate({ assigneeUserId: me.data!.user.id })}>Assign to me</Button> : null}
          {canReply ? (c.status === 'closed'
            ? <Button className="h-9" onClick={() => update.mutate({ status: 'open' })}>Reopen</Button>
            : <Button className="h-9" onClick={() => update.mutate({ status: 'closed' })}>Close</Button>) : null}
        </div>
      </header>
      {update.error ? <div className="px-5 pt-3"><Notice>{errorText(update.error)}</Notice></div> : null}
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto bg-[#F3F0E9] px-5 py-4">
        {c.messages.map((m) => (
          <div key={m.id} className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm shadow-sm ${m.direction === 'outbound' ? 'rounded-br-md bg-teal-tint' : 'rounded-bl-md bg-surface'}`}>
              <div className="whitespace-pre-wrap">{m.body}</div>
              <div className={`mt-1 text-right text-[11px] ${m.status === 'failed' ? 'font-semibold text-warn-ink' : 'text-ink-2'}`}>
                {m.direction === 'outbound' && m.author ? `${m.author} · ` : ''}{when(m.at, zone)}{m.direction === 'outbound' && m.status ? ` · ${TICKS[m.status] ?? m.status}` : ''}
              </div>
              {m.error ? <div className="text-[11px] text-warn-ink">{m.error}</div> : null}
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      {canReply && c.status !== 'closed' ? (
        c.replyWindowOpen ? (
          <form onSubmit={submit} className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
            {send.error ? <div className="w-full"><Notice>{errorText(send.error)}</Notice></div> : null}
            <div className="flex-1">
              <TextArea label="Reply" value={text} onChange={(e) => setText(e.target.value)} className="min-h-[52px]" rows={2} hint="Enter to send, Shift+Enter for a new line"
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && text.trim()) { e.preventDefault(); send.mutate(undefined, { onSuccess: () => setText('') }); } }} />
            </div>
            <Button variant="primary" type="submit" loading={send.isPending} disabled={!text.trim()}>Send</Button>
          </form>
        ) : (
          <div className="border-t border-line px-5 py-3 text-sm text-ink-2">
            More than 24 hours since {c.party.name ?? 'the patient'} last wrote. WhatsApp only allows approved templates now (they arrive with integrations). Call the patient{c.party.phone ? ` on ${phoneLabel(c.party.phone)}` : ''} instead.
          </div>
        )
      ) : null}
    </Card>
  );
}

function SimulatePanel({ accounts }: { accounts: ChannelAccount[] }) {
  const test = accounts.filter((a) => a.isTest && a.isActive);
  const [account, setAccount] = useState('');
  const [from, setFrom] = useState('');
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const sim = useSave(() => api(`/channel-accounts/${account || test[0]!.id}/simulate-inbound`, { method: 'POST', body: { from, body, name: name || undefined } }), ['conversations', 'conversation', 'leads']);
  if (!test.length) return null;
  return (
    <details className="rounded-xl border border-dashed border-[#C97A06] bg-warn-tint/40 p-4 text-sm">
      <summary className="cursor-pointer font-semibold text-warn-ink">Test channel: pretend a patient wrote</summary>
      <form className="mt-3 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); sim.mutate(undefined, { onSuccess: () => setBody('') }); }}>
        {sim.error ? <Notice>{errorText(sim.error)}</Notice> : null}
        {test.length > 1 ? <Select label="Test channel" value={account} onChange={(e) => setAccount(e.target.value)}>{test.map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}</Select> : null}
        <div className="grid grid-cols-2 gap-3"><Field label="From number" value={from} onChange={(e) => setFrom(e.target.value)} /><Field label="Their name (optional)" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <Field label="Message" value={body} onChange={(e) => setBody(e.target.value)} />
        <Button type="submit" disabled={!from || !body} loading={sim.isPending}>Receive message</Button>
      </form>
    </details>
  );
}

export function InboxPage() {
  const { orgId, can } = useClinic();
  const zone = useZone();
  const [params, setParams] = useSearchParams();
  const filter = FILTERS.find((f) => f.key === params.get('filter')) ?? FILTERS[0];
  const open = params.get('c');
  const list = useConversations(filter.qs);
  const accounts = useQuery({ queryKey: ['channel-accounts', orgId], queryFn: () => api<{ items: ChannelAccount[] }>('/channel-accounts').then((r) => r.items), enabled: can('inbox:read') });
  const set = (k: string, v: string | null) => setParams((p) => { if (v) p.set(k, v); else p.delete(k); return p; });
  if (!can('inbox:read')) return <Notice>Your role does not use the inbox.</Notice>;
  const noAccounts = accounts.data && accounts.data.filter((a) => a.isActive).length === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div><h1 className="font-display text-[26px] font-bold">Inbox</h1><p className="mt-1 text-ink-2">WhatsApp and SMS from patients, in one place. New numbers are added to the pipeline as enquiries.</p></div>
        <div className="ml-auto flex rounded-lg border border-line bg-surface p-0.5" role="tablist">
          {FILTERS.map((f) => <button key={f.key} type="button" role="tab" aria-selected={filter.key === f.key} onClick={() => set('filter', f.key)} className={`h-8 rounded-md px-3 text-sm font-semibold ${filter.key === f.key ? 'bg-teal-tint text-[#0B5E57]' : 'text-ink-2'}`}>{f.label}</button>)}
        </div>
      </div>
      {noAccounts ? <Notice>No WhatsApp or SMS number is connected yet. {can('channel:manage') ? <Link to="/settings/channels" className="font-semibold underline">Connect one in Settings › Channels</Link> : 'Ask the clinic owner to connect one.'}</Notice> : null}
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[0_1_340px] flex-col gap-2">
          {list.data?.length === 0 ? <Empty>No conversations here.</Empty> : null}
          {list.data?.map((c) => (
            <button key={c.id} type="button" onClick={() => set('c', c.id)} aria-current={open === c.id ? 'true' : undefined}
              className={`flex flex-col gap-0.5 rounded-xl border px-3.5 py-2.5 text-left text-sm ${open === c.id ? 'border-teal bg-surface ring-1 ring-teal' : 'border-line bg-surface hover:shadow-sm'}`}>
              <div className="flex items-center gap-2">
                <b className="truncate">{c.party.name ?? c.party.phone ?? 'Unknown'}</b>
                <span className="text-[11px] text-ink-2">{c.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}</span>
                <span className="ml-auto text-xs text-ink-2">{when(c.lastMessageAt, zone)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="truncate text-ink-2">{c.lastMessage?.direction === 'outbound' ? 'You: ' : ''}{c.lastMessage?.body}</span>
                {c.unread ? <span className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-teal px-1.5 text-[11px] font-bold text-white">{c.unread}</span> : null}
              </div>
              <div className="flex gap-2 text-[11px] text-ink-2">
                {c.party.patient ? <span>Patient {c.party.patient.mrn}</span> : c.party.lead ? <span>Lead · {c.party.lead.stage}</span> : null}
                {c.assignee ? <span>· {c.assignee.name}</span> : <span>· Unassigned</span>}
                {!c.replyWindowOpen ? <span className="text-warn-ink">· 24 h passed</span> : null}
              </div>
            </button>
          ))}
          {accounts.data ? <SimulatePanel accounts={accounts.data} /> : null}
        </div>
        <div className="min-w-0 flex-[1_1_520px]">{open ? <ThreadView id={open} /> : <Empty>Choose a conversation.</Empty>}</div>
      </div>
    </div>
  );
}

/** Settings › Channels: connect WhatsApp (Meta Cloud API) or a test channel. */
export function ChannelsSettings() {
  const { orgId, can } = useClinic();
  const accounts = useQuery({ queryKey: ['channel-accounts', orgId], queryFn: () => api<{ items: ChannelAccount[] }>('/channel-accounts').then((r) => r.items), enabled: can('inbox:read') });
  const [mode, setMode] = useState<'none' | 'whatsapp' | 'test'>('none');
  const [f, setF] = useState({ displayName: '', address: '', phoneNumberId: '', accessToken: '', appSecret: '', kind: 'whatsapp' });
  const [created, setCreated] = useState<{ verifyToken: string | null; webhookPath: string | null } | null>(null);
  const add = useSave(() => api<{ id: string; verifyToken: string | null; webhookPath: string | null }>('/channel-accounts', {
    method: 'POST',
    body: mode === 'whatsapp'
      ? { provider: 'whatsapp_cloud', kind: 'whatsapp', displayName: f.displayName, address: f.address, phoneNumberId: f.phoneNumberId, accessToken: f.accessToken, appSecret: f.appSecret }
      : { provider: 'sandbox', kind: f.kind, displayName: f.displayName, address: f.address },
  }), ['channel-accounts']);
  const remove = useSave((id: string) => api(`/channel-accounts/${id}`, { method: 'DELETE' }), ['channel-accounts']);
  const manage = can('channel:manage');
  const url = (path: string) => `${window.location.origin}${path}`;

  return (
    <div className="flex flex-col gap-5">
      {add.error || remove.error ? <Notice>{errorText(add.error ?? remove.error)}</Notice> : null}
      {created?.verifyToken ? (
        <Notice kind="ok">
          Connected. In Meta's App Dashboard › WhatsApp › Configuration, set the callback URL to <code className="font-mono">{url(created.webhookPath!)}</code> and the verify token to <code className="font-mono">{created.verifyToken}</code>, then subscribe to <b>messages</b>. The token is shown only once.
        </Notice>
      ) : null}
      <Card className="divide-y divide-line-2">
        {accounts.data?.length ? accounts.data.map((a) => (
          <div key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5 text-sm">
            <div className="min-w-0 flex-1">
              <b>{a.displayName ?? a.address}</b> <span className="text-ink-2">· {a.kind === 'whatsapp' ? 'WhatsApp' : 'SMS'} · {phoneLabel(a.address)}</span>
              {a.webhookPath ? <div className="truncate font-mono text-xs text-ink-2">Webhook: {url(a.webhookPath)}</div> : null}
            </div>
            {a.isTest ? <Pill tone="warn">Test channel</Pill> : <Pill tone="teal">Meta Cloud API</Pill>}
            {a.isActive ? <Pill tone="ok">Connected</Pill> : <Pill>Disconnected</Pill>}
            {manage && a.isActive ? <button type="button" onClick={() => remove.mutate(a.id)} className="text-[13px] font-semibold text-ink-2 hover:text-ink">Disconnect</button> : null}
          </div>
        )) : <div className="p-5"><Empty>No numbers connected.</Empty></div>}
      </Card>
      {manage ? (
        <div className="flex gap-2">
          <Button onClick={() => { setMode(mode === 'whatsapp' ? 'none' : 'whatsapp'); setCreated(null); }}>Connect WhatsApp Business</Button>
          <Button variant="ghost" onClick={() => { setMode(mode === 'test' ? 'none' : 'test'); setCreated(null); }}>Add a test channel</Button>
        </div>
      ) : null}
      {mode !== 'none' ? (
        <Card className="p-5">
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); add.mutate(undefined, { onSuccess: (r) => { setCreated(r); setMode('none'); } }); }}>
            {mode === 'whatsapp' ? (
              <p className="text-sm text-ink-2">From Meta Business Manager: your WhatsApp Business number, its phone number ID, a permanent (system user) access token and the app secret. They are stored encrypted.</p>
            ) : (
              <p className="text-sm text-ink-2">A test channel sends nothing outside DocReceptionist. Use it to train staff and try the inbox before your WhatsApp number is connected. Not available in production.</p>
            )}
            <div className="grid grid-cols-2 gap-4">
              <Field label="Name" placeholder="Clinic WhatsApp" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />
              <Field label="Number" type="tel" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
              {mode === 'whatsapp' ? (
                <>
                  <Field label="Phone number ID" value={f.phoneNumberId} onChange={(e) => setF({ ...f, phoneNumberId: e.target.value })} />
                  <Field label="App secret" type="password" value={f.appSecret} onChange={(e) => setF({ ...f, appSecret: e.target.value })} />
                  <div className="col-span-2"><Field label="Access token" type="password" value={f.accessToken} onChange={(e) => setF({ ...f, accessToken: e.target.value })} /></div>
                </>
              ) : (
                <Select label="Kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="whatsapp">WhatsApp (test)</option><option value="sms">SMS (test)</option></Select>
              )}
            </div>
            <Button variant="primary" type="submit" className="self-end" loading={add.isPending}>Connect</Button>
          </form>
        </Card>
      ) : null}
      <p className="text-sm text-ink-2">SMS numbers need a DLT-registered sender and templates; they connect with integrations. Phone lines for the AI receptionist (Exotel, Plivo) are set up under AI phone line.</p>
    </div>
  );
}
