import { useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { Button, Field, Notice } from '../components/ui';
import { ApiRequestError, auth, session } from '../lib/api';
import { AuthLayout } from './Login';

/**
 * Second step. Three cases:
 *  - signed in with password/SMS and already enrolled: enter the authenticator code
 *  - signed in but not enrolled yet: scan a QR code, then enter the code (mfaToken)
 *  - already have a session but a new role needs MFA: same enrolment, using the session
 */
export function VerifyPage({ fromSession = false }: { fromSession?: boolean }) {
  const loc = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const state = (loc.state ?? {}) as { mfaToken?: string; enrolled?: boolean };
  const mfaToken = fromSession ? undefined : state.mfaToken;
  const enrolling = fromSession || state.enrolled === false;

  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enrolling) return;
    auth.enrollStart(mfaToken)
      .then(async (r) => setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 200 }) }))
      .catch((e) => setError(e instanceof ApiRequestError ? e.message : 'Could not start setup'));
  }, [enrolling, mfaToken]);

  if (!fromSession && !mfaToken) return <Navigate to="/login" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (enrolling) {
        const r = await auth.enrollConfirm(code, mfaToken);
        if (r.accessToken && r.refreshToken) session.store({ accessToken: r.accessToken, refreshToken: r.refreshToken, accessTokenExpiresIn: r.accessTokenExpiresIn ?? 900 });
      } else {
        session.store(await auth.verifyMfa(mfaToken!, code));
      }
      await qc.invalidateQueries();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Something went wrong');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <form onSubmit={submit} className="flex w-full max-w-[420px] flex-col gap-5">
        <div>
          <h2 className="font-display text-[26px] font-bold">{enrolling ? 'Set up two-step verification' : 'Authenticator code'}</h2>
          <p className="mt-1.5 text-ink-2">
            {enrolling
              ? 'Your role can see patient data, so it needs a second check at sign-in. Scan this with Google Authenticator or any authenticator app.'
              : 'Open your authenticator app and enter the current 6-digit code.'}
          </p>
        </div>
        {enrolling ? (
          <div className="flex items-center gap-4 rounded-xl border border-line bg-surface p-4">
            {setup ? <img src={setup.qr} alt="QR code to add DocReceptionist to your authenticator app" className="size-[132px] rounded-md" /> : <div className="size-[132px] animate-pulse rounded-md bg-line-2" />}
            <div className="min-w-0 text-[13px]">
              <div className="font-semibold">Can't scan?</div>
              <div className="text-ink-2">Enter this key in the app:</div>
              <code className="mt-1 block break-all font-mono text-xs">{setup?.secret ?? '…'}</code>
            </div>
          </div>
        ) : null}
        {error ? <Notice>{error}</Notice> : null}
        <Field label="6-digit code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required autoFocus />
        <Button variant="primary" type="submit" loading={busy} disabled={code.length !== 6} className="h-12 text-[15px]">{enrolling ? 'Turn on and continue' : 'Verify and sign in'}</Button>
        {!fromSession ? <Link to="/login" className="text-center text-sm font-semibold text-teal">Start again</Link> : null}
      </form>
    </AuthLayout>
  );
}
