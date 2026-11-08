import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import './index.css';
import { restore, session } from './lib/api';
import { CreateClinicPage, RegisterPage } from './pages/Forms';
import { LoginPage } from './pages/Login';
import { AiReceptionistPage } from './pages/ai/AiReceptionist';
import { CallsPage } from './pages/ai/Calls';
import { PipelinePage } from './pages/crm/Pipeline';
import { InboxPage } from './pages/reception/Inbox';
import { PaymentsPage, ReceiptPage } from './pages/reception/Payments';
import { ReceptionPage } from './pages/reception/Reception';
import { CalendarPage } from './pages/schedule/Calendar';
import { PatientPage, PatientsPage } from './pages/schedule/Patients';
import { SettingsPage, SetupPage } from './pages/Setup';
import { HomePage, ShellPage } from './pages/Shell';
import { VerifyPage } from './pages/Verify';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } } });

/** Pages that need a session: try to restore it from the refresh token first. */
function RequireSession({ children }: { children: ReactNode }) {
  const signedIn = useSyncExternalStore(session.subscribe, () => session.signedIn);
  const [checked, setChecked] = useState(signedIn);
  useEffect(() => { if (!signedIn) void restore().finally(() => setChecked(true)); }, [signedIn]);
  if (signedIn) return <>{children}</>;
  if (!checked) return <div className="grid h-full place-items-center text-ink-2">Loading…</div>;
  return <Navigate to="/login" replace />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/verify" element={<VerifyPage />} />
          <Route path="/setup-mfa" element={<RequireSession><VerifyPage fromSession /></RequireSession>} />
          <Route path="/clinics/new" element={<RequireSession><CreateClinicPage /></RequireSession>} />
          <Route path="/receipts/:id" element={<RequireSession><ReceiptPage /></RequireSession>} />
          <Route path="/" element={<RequireSession><ShellPage /></RequireSession>}>
            <Route index element={<HomePage />} />
            <Route path="setup/:step?" element={<SetupPage />} />
            <Route path="settings/:section?" element={<SettingsPage />} />
            <Route path="calendar" element={<CalendarPage />} />
            <Route path="patients" element={<PatientsPage />} />
            <Route path="patients/:id" element={<PatientPage />} />
            <Route path="pipeline" element={<PipelinePage />} />
            <Route path="reception" element={<ReceptionPage />} />
            <Route path="inbox" element={<InboxPage />} />
            <Route path="payments" element={<PaymentsPage />} />
            <Route path="calls" element={<CallsPage />} />
            <Route path="ai-receptionist" element={<AiReceptionistPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
