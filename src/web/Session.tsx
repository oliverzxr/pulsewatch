import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Activity } from 'lucide-react';
import type { BrowserSession } from '../shared/contracts.ts';
import { liveSource, request, sessionExpired } from './api.ts';
import { App } from './App.tsx';
import type { MonitorDialog } from './App.tsx';
import { CreateMonitor, RemoveMonitor } from './Dialogs.tsx';
import { ErrorMessage } from './ErrorMessage.tsx';

const submitJson = (path: string, body: object) => request<void>(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const verifyMonitor = (id: number) => request<void>(`/monitors/${id}/check`, { method: 'POST' });

function monitorDialog(dialog: MonitorDialog, close: () => void, done: (message: string) => void) {
  return dialog.kind === 'create'
    ? <CreateMonitor onClose={close} onSaved={() => done('Monitor adicionado. A primeira verificação foi agendada.')} />
    : <RemoveMonitor monitor={dialog.monitor} onClose={close} onRemoved={() => done('Monitor removido.')} />;
}

function AuthScreen({ create, registrationEnabled, onSignedIn }: {
  create: boolean; registrationEnabled: boolean; onSignedIn: () => Promise<void>;
}) {
  const [submittedEmail, setSubmittedEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const signUp = create && !submittedEmail;
  const passwordInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (submittedEmail) passwordInput.current?.focus();
  }, [submittedEmail]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      if (signUp) {
        await submitJson('/auth/sign-up/email', {
          name: fields.get('name'), email: fields.get('email'), password: fields.get('password'),
        });
        setSubmittedEmail(String(fields.get('email')));
        window.history.replaceState(null, '', `/entrar${location.hash}`);
      } else {
        await submitJson('/auth/sign-in/email', { email: fields.get('email'), password: fields.get('password') });
        await onSignedIn();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-page">
    <header className="auth-masthead"><a className="brand" href="/" aria-label="PulseWatch">
      <span className="brand-icon"><Activity size={18} /></span><span>PulseWatch</span></a>
      {registrationEnabled && <a className="auth-nav" href={`${signUp ? '/entrar' : '/cadastro'}${location.hash}`}>{signUp ? 'Entrar' : 'Criar conta'}</a>}
    </header>
    <div className="auth-layout">
      <section className="auth-panel" aria-labelledby="auth-title">
        <h1 id="auth-title">{signUp ? 'Criar conta' : 'Entrar'}</h1>
        {submittedEmail && <p className="auth-feedback" role="status">Entre com seu e-mail e sua senha para acessar o painel.</p>}
        {!registrationEnabled && <p className="auth-feedback">Use uma conta fornecida pelo operador.</p>}
        <form key={String(signUp)} className="monitor-form auth-form" onSubmit={submit}>
          {signUp && <label>Nome<input name="name" autoComplete="name" required minLength={2} maxLength={80} /></label>}
          <label>E-mail<input name="email" type="email" autoComplete="username" defaultValue={submittedEmail} required maxLength={254} /></label>
          <label>Senha<input ref={passwordInput} name="password" type="password" autoComplete={signUp ? 'new-password' : 'current-password'}
            required minLength={signUp ? 12 : undefined} maxLength={128} aria-describedby={signUp ? 'password-rule' : undefined} /></label>
          {signUp && <p id="password-rule" className="password-rule">Use pelo menos 12 caracteres.</p>}
          {error && <ErrorMessage message={error} />}
          <button type="submit" className="button primary auth-submit" disabled={busy}>
            {busy ? (signUp ? 'Criando conta…' : 'Entrando…') : (signUp ? 'Criar conta' : 'Entrar')}
          </button>
        </form>
      </section>
      <section className="auth-context" aria-label="Sobre o PulseWatch">
        <p className="auth-context-title">Monitoramento HTTP</p>
        <p>Acompanhe disponibilidade, latência e incidentes dos seus serviços.</p>
      </section>
    </div>
  </main>;
}

export function SessionGate() {
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const channel = useRef<BroadcastChannel | null>(null);

  function refresh() {
    setError('');
    setRevision((value) => value + 1);
  }

  useEffect(() => {
    const controller = new AbortController();
    request<BrowserSession>('/session', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
      .then((data) => { if (!controller.signal.aborted) setSession(data); })
      .catch(() => { if (!controller.signal.aborted) setError('Não foi possível consultar a sessão.'); });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => {
    const expired = () => setSession((current) => current && { ...current, user: null });
    window.addEventListener(sessionExpired, expired);
    const sync = () => { setSession(null); refresh(); };
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('pulsewatch-auth');
      channel.current.addEventListener('message', sync);
    }
    return () => {
      window.removeEventListener(sessionExpired, expired);
      channel.current?.close();
      channel.current = null;
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    const path = window.location.pathname;
    if (session.user && path !== '/') window.history.replaceState(null, '', `/${location.hash}`);
    if (!session.user && (path !== '/cadastro' || !session.registrationEnabled) && path !== '/entrar') {
      window.history.replaceState(null, '', `/entrar${location.hash}`);
    }
  }, [session]);

  async function signedIn() {
    const data = await request<BrowserSession>('/session');
    if (!data.user) throw new Error('Não foi possível iniciar a sessão. Confira se o navegador aceita cookies.');
    setSession(data);
    channel.current?.postMessage('changed');
  }

  async function signOut() {
    await submitJson('/auth/sign-out', {});
    setSession((current) => current && { ...current, user: null });
    channel.current?.postMessage('changed');
  }

  if (!session) return <main className="session-loading">
    {error ? <ErrorMessage message={error} retry={refresh} /> : <p role="status">Consultando sessão…</p>}
  </main>;
  if (!session.user) return <AuthScreen create={window.location.pathname === '/cadastro' && session.registrationEnabled}
    registrationEnabled={session.registrationEnabled} onSignedIn={signedIn} />;
  return <App key={session.user.id} source={liveSource} account={{
    user: session.user, onLogout: signOut, verifyMonitor, renderDialog: monitorDialog,
  }} />;
}
