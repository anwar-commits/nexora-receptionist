import type { LoginResult } from '@dr/contracts';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, Field, Logo, Notice } from '../components/ui';
import { ApiRequestError, auth, session } from '../lib/api';

export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-wrap">
      <aside className="relative flex flex-[1_1_440px] flex-col bg-navy px-14 py-12 text-[#E8ECF6]">
        <Logo light />
        <div className="my-auto max-w-[460px] py-12">
          <div className="orb mb-8 size-[88px] rounded-full shadow-[0_0_0_12px_rgba(106,90,224,.18)]" aria-hidden="true" />
          <h1 className="font-display text-[40px] leading-[46px] font-extrabold text-white">Every patient call answered. Day and night.</h1>
          <p className="mt-4 text-base leading-6 text-[#C9D1E6]">Your AI receptionist books appointments in Hindi and English, hands off to your team when it should, and never gives medical advice.</p>
        </div>
        <p className="text-xs text-[#98A2BF]">Patients: please use the mobile app or call your clinic.</p>
      </aside>
      <main className="grid flex-[1_1_440px] place-items-center px-6 py-12">{children}</main>
    </div>
  );
}

export function useAfterFirstFactor() {
  const navigate = useNavigate();
  return (r: LoginResult) => {
    if (r.status === 'ok') {
      session.store(r);
      navigate('/', { replace: true });
    } else {
      navigate('/verify', { state: { mfaToken: r.mfaToken, enrolled: r.enrolled } });
    }
  };
}

export function LoginPage() {
  const [mode, setMode] = useState<'password' | 'otp'>('password');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = useAfterFirstFactor();

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(e instanceof ApiRequestError ? e.message : 'Could not reach the server. Check your connection.'); } finally { setBusy(false); }
  }

  const submitPassword = (e: FormEvent) => { e.preventDefault(); void run(async () => next(await auth.login(identifier, password))); };
  const submitOtp = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (!codeSent) { await auth.requestOtp(phone); setCodeSent(true); }
      else next(await auth.verifyOtp(phone, code));
    });
  };

  return (
    <AuthLayout>
      <div className="flex w-full max-w-[400px] flex-col gap-5">
        <div>
          <h2 className="font-display text-[28px] leading-[34px] font-bold">Sign in to your clinic</h2>
          <p className="mt-1.5 text-ink-2">For doctors, reception and clinic staff.</p>
        </div>
        <div role="tablist" aria-label="Sign-in method" className="grid grid-cols-2 gap-1 rounded-xl bg-line-2 p-1">
          {(['password', 'otp'] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setError(null); }}
              className={`h-9 rounded-[9px] text-sm font-semibold transition ${mode === m ? 'bg-surface shadow-sm' : 'text-[#4A5370]'}`}>
              {m === 'password' ? 'Password' : 'SMS code'}
            </button>
          ))}
        </div>
        {error ? <Notice>{error}</Notice> : null}
        {mode === 'password' ? (
          <form onSubmit={submitPassword} className="flex flex-col gap-4">
            <Field label="Work email or mobile number" name="identifier" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
            <Field label="Password" name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <Button variant="primary" type="submit" loading={busy} className="h-12 text-[15px]">Continue</Button>
          </form>
        ) : (
          <form onSubmit={submitOtp} className="flex flex-col gap-4">
            <Field label="Mobile number" name="phone" type="tel" autoComplete="tel" placeholder="98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={codeSent} required />
            {codeSent ? (
              <>
                <Field label="6-digit code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} hint="Sent by SMS if this number has an account. It expires in 5 minutes." required />
                <button type="button" className="self-start text-sm font-semibold text-teal" onClick={() => { setCodeSent(false); setCode(''); }}>Use a different number</button>
              </>
            ) : null}
            <Button variant="primary" type="submit" loading={busy} className="h-12 text-[15px]">{codeSent ? 'Sign in' : 'Send code'}</Button>
          </form>
        )}
        <p className="text-center text-sm text-ink-2">New clinic? <Link to="/register" className="font-semibold text-teal">Create an account</Link></p>
        <p className="text-center text-xs text-ink-2">Owners and doctors also confirm with an authenticator app. Every sign-in is logged.</p>
      </div>
    </AuthLayout>
  );
}
