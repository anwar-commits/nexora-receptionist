import type { VoiceLang } from '@dr/contracts';
import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';
import { Button, Card, ChipGroup, ChoiceCards, Empty, Field, Notice, Pill, SectionTitle, Select, TextArea, Toggle } from '../../components/ui';
import { api } from '../../lib/api';
import { errorText, useClinic, useClinicData, useSave } from '../../lib/clinic';
import { phoneLabel } from '../../lib/format';
import { LANG_LABEL, TOOL_LABEL, useAgent, type AgentConfig, type AgentView, type SuiteResult, type SuiteSummary, type TestTurn } from '../../lib/voice';

const KEYS = ['ai-receptionist'];
const LANGS = (Object.keys(LANG_LABEL) as VoiceLang[]).map((value) => ({ value, label: LANG_LABEL[value] }));
const when = (iso: string | null) => (iso ? DateTime.fromISO(iso).toFormat('d LLL yyyy, h:mm a') : '—');

/** What the server needs before calls can reach the receptionist. Configured by whoever runs the server, not the clinic. */
function SetupChecklist({ setup }: { setup: AgentView['setup'] }) {
  const rows: [boolean, string, string][] = [
    [setup.model, 'AI model', 'ANTHROPIC_API_KEY — the receptionist\'s replies. Without it, nothing can be tested or published.'],
    [setup.voice, 'ElevenLabs (voice)', `ELEVENLABS_API_KEY — speech in and out. Using ${setup.voiceBaseUrl}${setup.voiceBaseUrl.includes('.in.') ? ' (India deployment, needed for Indian numbers)' : ''}.`],
    [setup.publicUrl, 'Public address of this server', 'PUBLIC_API_URL — so ElevenLabs can reach the receptionist\'s brain.'],
    [setup.initiationWebhook, 'Call-start webhook secret', 'ELEVENLABS_INIT_SECRET — identifies the caller and links the call.'],
    [setup.postCallWebhook, 'Post-call webhook secret', 'ELEVENLABS_WEBHOOK_SECRET — transcripts and recordings after each call.'],
  ];
  const ready = rows.every(([ok]) => ok);
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2"><h2 className="font-display text-lg font-bold">Server connections</h2>{ready ? <Pill tone="ok">All connected</Pill> : <Pill tone="warn">{rows.filter(([ok]) => !ok).length} missing</Pill>}</div>
      <ul className="mt-3 flex flex-col gap-2.5">
        {rows.map(([ok, title, body]) => (
          <li key={title} className="flex items-start gap-3 text-sm">
            <span aria-hidden="true" className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold ${ok ? 'bg-ok-tint text-ok-ink' : 'bg-warn-tint text-warn-ink'}`}>{ok ? '✓' : '!'}</span>
            <span><b>{title}</b> <span className="text-ink-2">— {ok ? 'connected' : 'not set'}</span><br /><span className="text-ink-2">{body}</span></span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function SettingsForm({ view }: { view: NonNullable<AgentView['agent']> }) {
  const [d, setD] = useState<AgentConfig>(view.draft);
  const [intake, setIntake] = useState(view.draft.intakeQuestions.join('\n'));
  useEffect(() => { setD(view.draft); setIntake(view.draft.intakeQuestions.join('\n')); }, [view.draft]);
  const save = useSave((body: unknown) => api('/ai-receptionist/draft', { method: 'PUT', body }), KEYS);
  const [saved, setSaved] = useState(false);
  const set = <K extends keyof AgentConfig>(k: K, v: AgentConfig[K]) => { setSaved(false); setD({ ...d, [k]: v }); };
  const submit = () => {
    const { emergency, ...rest } = d;
    save.mutate({ ...rest, emergency: { transferNumber: emergency.transferNumber || null }, handoff: { transferNumber: d.handoff.transferNumber || null }, intakeQuestions: intake.split('\n').map((s) => s.trim()).filter(Boolean) }, { onSuccess: () => setSaved(true) });
  };
  return (
    <Card className="flex flex-col gap-5 p-5">
      <h2 className="font-display text-lg font-bold">How it speaks and what it may do</h2>
      {save.error ? <Notice>{errorText(save.error)}</Notice> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Assistant's name" name="assistantName" value={d.persona.assistantName} maxLength={40} onChange={(e) => set('persona', { ...d.persona, assistantName: e.target.value })} />
        <Field label="ElevenLabs voice ID" name="voiceId" value={d.voice.voiceId ?? ''} placeholder="Default voice" hint="Optional. From your ElevenLabs voice library." onChange={(e) => set('voice', { voiceId: e.target.value || null })} />
      </div>
      <ChoiceCards name="Tone" value={d.persona.tone} onChange={(tone) => set('persona', { ...d.persona, tone })} options={[
        { value: 'warm', title: 'Warm and simple', body: 'Friendly, short sentences. Suits most clinics.' },
        { value: 'formal', title: 'Polite and formal', body: 'For clinics whose callers expect formal speech.' },
      ]} />
      <ChipGroup label="Languages (the first is used for the greeting)" options={LANGS} value={d.languages} onChange={(languages) => set('languages', languages.length ? languages : d.languages)} />
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-[13px] font-semibold">On a call it may</legend>
        <Toggle label="Book new appointments" description="Only times that are free on your calendar, after reading back the details and hearing a clear yes." checked={d.guardrails.allowBooking} onChange={(v) => set('guardrails', { ...d.guardrails, allowBooking: v })} />
        <Toggle label="Move appointments" description="Only for the caller's own number, after checking the patient's date of birth." checked={d.guardrails.allowReschedule} onChange={(v) => set('guardrails', { ...d.guardrails, allowReschedule: v })} />
        <Toggle label="Cancel appointments" description="Same checks as moving." checked={d.guardrails.allowCancel} onChange={(v) => set('guardrails', { ...d.guardrails, allowCancel: v })} />
      </fieldset>
      <Field label="Transfer to staff on" name="handoffNumber" value={d.handoff.transferNumber ?? ''} placeholder="No transfer — create a call-back task" hint="When a caller asks for a person. Leave empty and reception gets a call-back task instead." onChange={(e) => set('handoff', { transferNumber: e.target.value || null })} />
      <TextArea label="Questions to ask before booking (one per line)" name="intake" value={intake} onChange={(e) => { setSaved(false); setIntake(e.target.value); }} hint="Up to 8. Kept short: callers are on the phone." />
      <Field label="Claude model" name="llmModel" value={d.llmModel} onChange={(e) => set('llmModel', e.target.value)} hint="The model that writes replies, e.g. claude-sonnet-5-5." />
      <div className="flex items-center gap-3">
        <Button variant="primary" loading={save.isPending} onClick={submit}>Save settings</Button>
        {saved ? <span role="status" className="text-sm text-ok-ink">Saved. Run the safety checks to make a new version.</span> : null}
      </div>
      <div className="rounded-xl bg-canvas p-3.5 text-sm"><div className="mb-1 text-xs font-bold tracking-[.06em] text-ink-2">GREETING (SAVED SETTINGS)</div>"{view.firstMessage}"</div>
    </Card>
  );
}

function EmergencyProtocol({ view, canApprove, scripts, readOnlyNumber = false }: { view: NonNullable<AgentView['agent']>; canApprove: boolean; scripts: AgentView['scripts']; readOnlyNumber?: boolean }) {
  const e = view.draft.emergency;
  const [num, setNum] = useState(e.transferNumber ?? '');
  useEffect(() => setNum(e.transferNumber ?? ''), [e.transferNumber]);
  const approve = useSave(() => api('/ai-receptionist/emergency-approval', { method: 'POST', body: {} }), KEYS);
  const save = useSave((n: string | null) => {
    const { emergency: _e, ...rest } = view.draft;
    void _e;
    return api('/ai-receptionist/draft', { method: 'PUT', body: { ...rest, emergency: { transferNumber: n } } });
  }, KEYS);
  const [lang, setLang] = useState<VoiceLang>(view.draft.languages[0] ?? 'hi-Latn');
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-lg font-bold">Emergency protocol</h2>
        {e.approvedAt ? <Pill tone="ok">Approved by {e.approvedByName ?? 'clinic'} · {when(e.approvedAt)}</Pill> : <Pill tone="warn">Needs a doctor's or the owner's approval</Pill>}
      </div>
      <p className="text-sm text-ink-2">
        These are checked in code on every caller turn, before the AI model is asked. If a caller describes chest pain, breathing trouble, heavy bleeding, fainting,
        stroke signs, a seizure, a severe allergy, poisoning or bleeding in pregnancy, the AI says exactly the script below, stops booking for the rest of the call,
        and reception gets an urgent task. If a caller talks about harming themselves, it gives Tele-MANAS (14416) and 112 instead.
      </p>
      {approve.error ? <Notice>{errorText(approve.error)}</Notice> : null}
      {save.error ? <Notice>{errorText(save.error)}</Notice> : null}
      <div role="tablist" aria-label="Script language" className="flex flex-wrap gap-2">
        {view.draft.languages.map((l) => <button key={l} role="tab" aria-selected={lang === l} onClick={() => setLang(l)} className={`h-8 rounded-full border px-3 text-[13px] font-semibold ${lang === l ? 'border-teal bg-teal-tint text-[#0B5E57]' : 'border-line text-ink-2'}`}>{LANG_LABEL[l]}</button>)}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-[#F2D3A2] bg-warn-tint/50 p-3.5 text-sm"><div className="mb-1 text-xs font-bold tracking-[.06em] text-warn-ink">MEDICAL EMERGENCY</div>{scripts.emergency[lang]}</div>
        <div className="rounded-xl border border-[#E5E0FC] bg-ai-tint/60 p-3.5 text-sm"><div className="mb-1 text-xs font-bold tracking-[.06em] text-ai-ink">SELF-HARM</div>{scripts.selfHarm[lang]}</div>
      </div>
      {readOnlyNumber ? <p className="text-sm"><b>Emergency transfer:</b> {e.transferNumber ? phoneLabel(e.transferNumber) : 'none — script and urgent task only'}</p> : <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[260px] flex-1"><Field label="Also transfer emergencies to" name="emergencyNumber" value={num} placeholder="No transfer" hint="Optional: a number answered at all times. Changing it needs a fresh approval." onChange={(ev) => setNum(ev.target.value)} /></div>
        <Button loading={save.isPending} disabled={(num || null) === (e.transferNumber ?? null)} onClick={() => save.mutate(num.trim() || null)}>Save number</Button>
      </div>}
      {canApprove
        ? <Button variant="primary" className="self-start" loading={approve.isPending} onClick={() => approve.mutate(undefined)}>{e.approvedAt ? 'Approve again' : 'I have read the scripts — approve'}</Button>
        : <p className="text-sm text-ink-2">A doctor or the clinic owner signs this off before the receptionist can go live.</p>}
    </Card>
  );
}

function TestConsole({ ready }: { ready: boolean }) {
  const [lines, setLines] = useState('Namaste, mujhe hair fall ke liye doctor ko dikhana hai\nthe first one\nyes please book it');
  const [phone, setPhone] = useState('');
  const run = useSave((body: unknown) => api<{ greeting: string; turns: TestTurn[]; model: string }>('/ai-receptionist/test', { method: 'POST', body }), []);
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div><h2 className="font-display text-lg font-bold">Try it</h2><p className="mt-1 text-sm text-ink-2">Type what a caller says, one line per turn. It runs your saved settings against your real calendar, then everything is undone — no booking, lead or message is kept.</p></div>
      {!ready ? <Notice>Testing needs the AI model connected on the server (ANTHROPIC_API_KEY).</Notice> : null}
      {run.error ? <Notice>{errorText(run.error)}</Notice> : null}
      <TextArea label="Caller says" name="lines" value={lines} onChange={(e) => setLines(e.target.value)} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1"><Field label="Pretend caller number" name="testPhone" value={phone} placeholder="Unknown number" hint="Optional. Use a registered patient's number to test their appointments." onChange={(e) => setPhone(e.target.value)} /></div>
        <Button variant="primary" disabled={!ready || !lines.trim()} loading={run.isPending} onClick={() => run.mutate({ lines: lines.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12), callerPhone: phone.trim() || null })}>Run test call</Button>
      </div>
      {run.data ? (
        <ol className="flex flex-col gap-3" aria-label="Test call">
          <li className="max-w-[85%] rounded-xl bg-teal-tint/60 px-3.5 py-2.5 text-sm"><b>AI:</b> {run.data.greeting}</li>
          {run.data.turns.map((t, i) => (
            <li key={i} className="flex flex-col gap-2">
              <div className="ml-auto max-w-[85%] rounded-xl bg-surface px-3.5 py-2.5 text-sm shadow-sm"><b>Caller:</b> {t.caller}</div>
              {t.tools.length ? <div className="flex flex-wrap gap-1.5">{t.tools.map((x, j) => <Pill key={j} tone={x.status === 'ok' ? 'n' : 'warn'}>{TOOL_LABEL[x.name] ?? x.name}{x.status !== 'ok' ? ` — refused: ${String(x.result.rejected)}` : ''}</Pill>)}</div> : null}
              <div className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm ${t.redFlag ? 'border border-[#F2D3A2] bg-warn-tint' : 'bg-teal-tint/60'}`}>
                <b>AI:</b> {t.reply}
                {t.redFlag ? <div className="mt-1 text-xs font-semibold text-warn-ink">Safety script ({t.redFlag.key.replace(/_/g, ' ')}) — the model was not asked.</div> : null}
                {t.guardBlocked ? <div className="mt-1 text-xs font-semibold text-warn-ink">The model's reply was replaced: it contained {t.guardBlocked.replace(/_/g, ' ')}.</div> : null}
              </div>
            </li>
          ))}
          <li className="text-xs text-ink-2">Model: {run.data.model}. Nothing was saved.</li>
        </ol>
      ) : null}
    </Card>
  );
}

function SuiteAndPublish({ view, ready }: { view: NonNullable<AgentView['agent']>; ready: boolean }) {
  const run = useSave(() => api<SuiteSummary & { versionId: string; version: number; results: SuiteResult[] }>('/ai-receptionist/suite', { method: 'POST', body: {} }), KEYS);
  const publish = useSave((id: string) => api(`/ai-receptionist/versions/${id}/publish`, { method: 'POST', body: {} }), KEYS);
  const [showAll, setShowAll] = useState(false);
  const res = run.data;
  const shown = res ? (showAll ? res.results : res.results.filter((r) => r.status !== 'passed')) : [];
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="font-display text-lg font-bold">Safety checks and going live</h2>
        <p className="mt-1 text-sm text-ink-2">
          Running the checks saves your current settings as a new version and tests it on 40 safety cases: emergencies and self-harm in each language,
          medicine and diagnosis talk, promised results, booking rules, and five conversations with the real model. A version goes live only if all 40 pass
          and the emergency protocol is approved.
        </p>
      </div>
      {run.error ? <Notice>{errorText(run.error)}</Notice> : null}
      {publish.error ? <Notice>{errorText(publish.error)}</Notice> : null}
      <Button variant="primary" className="self-start" loading={run.isPending} onClick={() => run.mutate(undefined)}>{run.isPending ? 'Running 40 checks…' : 'Run the 40 safety checks'}</Button>
      {!ready ? <p className="text-sm text-ink-2">Without the AI model connected, the five model conversations are skipped and the version cannot go live.</p> : null}
      {res ? (
        <div className="flex flex-col gap-2" role="status">
          <div className="flex flex-wrap items-center gap-2 text-sm"><b>Version {res.version}:</b> <Pill tone="ok">{res.passed} passed</Pill>{res.failed ? <Pill tone="warn">{res.failed} failed</Pill> : null}{res.skipped ? <Pill>{res.skipped} skipped</Pill> : null}
            <button type="button" className="ml-auto text-[13px] font-semibold text-teal" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show only problems' : 'Show all 40'}</button></div>
          {shown.length ? (
            <ul className="flex flex-col divide-y divide-line-2 rounded-xl border border-line">
              {shown.map((r) => <li key={r.key} className="flex items-start gap-3 px-3.5 py-2 text-sm"><Pill tone={r.status === 'passed' ? 'ok' : r.status === 'failed' ? 'warn' : 'n'}>{r.status}</Pill><span><b>{r.name}</b><br /><span className="text-ink-2">{r.detail}</span></span></li>)}
            </ul>
          ) : <p className="text-sm text-ok-ink">All 40 checks passed.</p>}
        </div>
      ) : null}
      <h3 className="mt-2 text-sm font-bold">Versions</h3>
      {view.versions.length === 0 ? <Empty>No versions yet. Run the safety checks to make one.</Empty> : (
        <ul className="flex flex-col divide-y divide-line-2">
          {view.versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
              <b className="w-20">Version {v.version}</b>
              {v.live ? <Pill tone="teal">Live</Pill> : null}
              {v.suitePassedAt ? <Pill tone="ok">40/40 passed</Pill> : v.suite ? <Pill tone="warn">{v.suite.passed}/40 passed</Pill> : <Pill>Not checked</Pill>}
              <span className="text-ink-2">{v.publishedAt ? `Published ${when(v.publishedAt)}${v.publishedBy ? ` by ${v.publishedBy}` : ''}` : `Made ${when(v.createdAt)}`}</span>
              {!v.live && v.suitePassedAt ? <Button className="ml-auto h-8 px-3 text-xs" variant="primary" loading={publish.isPending && publish.variables === v.id} onClick={() => publish.mutate(v.id)}>{v.publishedAt ? 'Make live again' : 'Go live'}</Button> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PhoneNumbers({ view }: { view: NonNullable<AgentView['agent']> }) {
  const { branches } = useClinicData();
  const [provider, setProvider] = useState<'exotel' | 'plivo'>('exotel');
  const [f, setF] = useState<Record<string, string>>({ subdomain: 'api.in.exotel.com' });
  const add = useSave((body: unknown) => api('/ai-receptionist/numbers', { method: 'POST', body }), KEYS);
  const remove = useSave((id: string) => api(`/ai-receptionist/numbers/${id}`, { method: 'DELETE' }), KEYS);
  const sync = useSave(() => api('/ai-receptionist/sync', { method: 'POST', body: {} }), KEYS);
  const field = (k: string, label: string, hint?: string, type = 'text') => <Field key={k} label={label} name={k} type={type} value={f[k] ?? ''} hint={hint} autoComplete="off" onChange={(e) => setF({ ...f, [k]: e.target.value })} />;
  const submit = () => add.mutate({ provider, phoneNumber: f.phoneNumber ?? '', label: f.label || undefined, branchId: f.branchId || null,
    ...(provider === 'exotel' ? { accountSid: f.accountSid, apiKey: f.apiKey, apiToken: f.apiToken, subdomain: f.subdomain, appId: f.appId } : { sipAddress: f.sipAddress, username: f.username, password: f.password }) },
  { onSuccess: () => setF({ subdomain: 'api.in.exotel.com' }) });
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div><h2 className="font-display text-lg font-bold">Phone numbers</h2><p className="mt-1 text-sm text-ink-2">Calls to these numbers are answered by the AI receptionist once it is live. Credentials are stored encrypted and passed to ElevenLabs when the number is connected.</p></div>
      {view.vendor.error ? <Notice>Not connected to ElevenLabs: {view.vendor.error}</Notice> : view.vendor.syncedAt ? <Notice kind="ok">Connected to ElevenLabs · last update {when(view.vendor.syncedAt)}</Notice> : null}
      {view.vendor.error && view.liveVersionId ? <Button className="self-start" loading={sync.isPending} onClick={() => sync.mutate(undefined)}>Try connecting again</Button> : null}
      {remove.error ? <Notice>{errorText(remove.error)}</Notice> : null}
      {view.numbers.length === 0 ? <Empty>No numbers yet.</Empty> : (
        <ul className="flex flex-col divide-y divide-line-2">
          {view.numbers.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
              <b className="font-mono">{phoneLabel(n.number)}</b><Pill>{n.provider === 'exotel' ? 'Exotel' : 'Plivo'}</Pill>{n.label ? <span className="text-ink-2">{n.label}</span> : null}
              {n.connected ? <Pill tone="ok">Connected</Pill> : <Pill tone="warn">{view.liveVersionId ? 'Not connected yet' : 'Connects when live'}</Pill>}
              <button type="button" className="ml-auto text-xs font-semibold text-ink-2 hover:text-ink" onClick={() => remove.mutate(n.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <details className="rounded-xl border border-line p-3.5">
        <summary className="cursor-pointer text-sm font-semibold">Add a number</summary>
        <div className="mt-4 flex flex-col gap-4">
          {add.error ? <Notice>{errorText(add.error)}</Notice> : null}
          <ChoiceCards name="Provider" value={provider} onChange={setProvider} options={[
            { value: 'exotel', title: 'Exotel', body: 'Connected natively. You need the Exotel Voicebot applet set up to point at ElevenLabs.' },
            { value: 'plivo', title: 'Plivo', body: 'Connected as a SIP trunk to ElevenLabs.' },
          ]} />
          <div className="grid gap-4 md:grid-cols-2">
            {field('phoneNumber', 'Phone number', 'e.g. +91 80489 61234')}
            {field('label', 'Label', 'Optional, e.g. "Main line"')}
            <Select label="Branch" name="branchId" value={f.branchId ?? ''} onChange={(e) => setF({ ...f, branchId: e.target.value })}>
              <option value="">Whole clinic</option>
              {(branches.data ?? []).filter((b) => b.isActive).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
            {provider === 'exotel' ? (
              <>
                {field('accountSid', 'Exotel account SID')}
                {field('apiKey', 'Exotel API key')}
                {field('apiToken', 'Exotel API token', undefined, 'password')}
                <Select label="Exotel cluster" name="subdomain" value={f.subdomain ?? 'api.in.exotel.com'} onChange={(e) => setF({ ...f, subdomain: e.target.value })}>
                  <option value="api.in.exotel.com">Mumbai (api.in.exotel.com)</option>
                  <option value="api.exotel.com">Singapore (api.exotel.com)</option>
                </Select>
                {field('appId', 'Voicebot applet ID')}
              </>
            ) : (
              <>
                {field('sipAddress', 'Plivo SIP address', 'Your Plivo outbound trunk domain')}
                {field('username', 'SIP username')}
                {field('password', 'SIP password', undefined, 'password')}
              </>
            )}
          </div>
          <Button variant="primary" className="self-start" loading={add.isPending} onClick={submit}>Add number</Button>
        </div>
      </details>
    </Card>
  );
}

/** Settings → AI Receptionist. */
export function AiReceptionistPage() {
  const { can, current } = useClinic();
  const q = useAgent();
  const isDoctor = current.data?.you.roleKey === 'doctor';
  const create = useSave(() => api('/ai-receptionist', { method: 'POST', body: {} }), KEYS);
  const pause = useSave((action: 'pause' | 'resume') => api(`/ai-receptionist/${action}`, { method: 'POST', body: {} }), KEYS);
  if (!can('agent:manage') && !isDoctor) return <Notice>Only the owner and AI operations staff can change the AI receptionist.</Notice>;
  if (q.isLoading || !q.data) return q.error ? <Notice>{errorText(q.error)}</Notice> : <p className="text-ink-2">Loading…</p>;
  const { setup, agent } = q.data;
  if (!q.data.canManage) {
    // Doctors: read the emergency scripts and sign them off; nothing else.
    return (
      <div className="flex flex-col gap-5">
        <SectionTitle title="AI Receptionist" subtitle="As a doctor you approve what the AI says in an emergency. Other settings are changed by the owner." />
        {agent ? <EmergencyProtocol view={agent} canApprove={q.data.canApproveEmergency} scripts={q.data.scripts} readOnlyNumber /> : <Empty>The AI receptionist has not been set up yet.</Empty>}
      </div>
    );
  }
  const status = agent?.status;
  return (
    <div className="flex flex-col gap-5">
      <SectionTitle title="AI Receptionist" subtitle="Answers your phone line, books from your real calendar, and hands over to your team. It never diagnoses, advises on medicines or promises results."
        action={agent ? (
          <>
            <Pill tone={status === 'live' ? 'ok' : status === 'paused' ? 'warn' : 'n'}>{status === 'live' ? 'Live' : status === 'paused' ? 'Paused' : 'Not live yet'}</Pill>
            {status === 'live' ? <Button loading={pause.isPending} onClick={() => pause.mutate('pause')}>Pause</Button> : null}
            {status === 'paused' ? <Button variant="primary" loading={pause.isPending} onClick={() => pause.mutate('resume')}>Resume</Button> : null}
          </>
        ) : undefined} />
      {pause.error ? <Notice>{errorText(pause.error)}</Notice> : null}
      {status === 'paused' ? <Notice>Paused: callers hear that the assistant is not available and are asked to call during clinic hours.</Notice> : null}
      <SetupChecklist setup={setup} />
      {!agent ? (
        <Card className="flex flex-col items-start gap-3 p-5">
          <h2 className="font-display text-lg font-bold">Set up the AI receptionist</h2>
          <p className="text-sm text-ink-2">Starts with safe defaults. Nothing answers your phone until you approve the emergency protocol, pass the safety checks and go live.</p>
          {create.error ? <Notice>{errorText(create.error)}</Notice> : null}
          <Button variant="primary" loading={create.isPending} onClick={() => create.mutate(undefined)}>Set up</Button>
        </Card>
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-2">
          <div className="flex flex-col gap-5">
            <SettingsForm view={agent} />
            <EmergencyProtocol view={agent} canApprove={q.data.canApproveEmergency} scripts={q.data.scripts} />
          </div>
          <div className="flex flex-col gap-5">
            <SuiteAndPublish view={agent} ready={setup.model} />
            <TestConsole ready={setup.model} />
            <PhoneNumbers view={agent} />
          </div>
        </div>
      )}
    </div>
  );
}
