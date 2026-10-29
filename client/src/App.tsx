import { lazy, Suspense, useEffect, useState } from 'react';
import { KeyRound, RotateCcw, ShieldCheck } from 'lucide-react';
import { api, ApiError, type Role } from './api';
import { Landing } from './pages/Landing';
import { Button, Spinner } from './components/ui';

// Split per persona: the caregiver page carries AG Grid, which Margaret's page never needs
const ElderView = lazy(() => import('./pages/ElderView').then(m => ({ default: m.ElderView })));
const CaregiverView = lazy(() => import('./pages/CaregiverView').then(m => ({ default: m.CaregiverView })));

type Route = 'landing' | 'margaret' | 'caregiver';

const ROLE_FOR_ROUTE: Partial<Record<Route, Role>> = { margaret: 'elder', caregiver: 'caregiver' };

function routeFromHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return hash === 'margaret' || hash === 'caregiver' ? hash : 'landing';
}

const VAULT_MESSAGES: Record<string, string> = {
  connected: 'PayPal connected. The helper can now pay within your rules.',
  cancelled: 'PayPal connection was cancelled.',
  error: "PayPal connection didn't complete. Please try again."
};

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [toast, setToast] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  // The server checks a signed persona cookie on every action, so switch it before showing a page
  const [sessionRole, setSessionRole] = useState<Role | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  // Sarah's dashboard can move money, so the server asks for her PIN before giving out that role
  const [needsPin, setNeedsPin] = useState(false);
  const neededRole = ROLE_FOR_ROUTE[route];

  useEffect(() => {
    if (!neededRole || neededRole === sessionRole) return;
    let cancelled = false;
    setSessionError(null);
    setNeedsPin(false);
    // Reuse the cookie when it already has this role (reloads, returning from PayPal), so Sarah
    // isn't asked for her PIN again and switching pages doesn't log in over and over
    api
      .sessionInfo()
      .then(info => (info.roles.includes(neededRole) ? undefined : api.startSession(neededRole)))
      .then(() => !cancelled && setSessionRole(neededRole))
      .catch(err => {
        if (cancelled) return;
        if (err instanceof ApiError && err.data.pinRequired) setNeedsPin(true);
        else setSessionError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [neededRole, sessionRole]);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    const onExpired = () => setSessionRole(null);
    window.addEventListener('hashchange', onHash);
    window.addEventListener('guardian:session-expired', onExpired);

    // Returning from PayPal's vault approval page (?vault=connected|cancelled|error)
    const vault = new URLSearchParams(window.location.search).get('vault');
    if (vault) {
      setToast(VAULT_MESSAGES[vault] || null);
      window.history.replaceState(null, '', `${window.location.pathname}#/caregiver`);
      setRoute('caregiver');
    }
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('guardian:session-expired', onExpired);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  const reset = async () => {
    if (!confirm('Reset the demo? This clears chats, purchases and alerts and releases any PayPal holds. Your rules and the PayPal connection are kept.')) return;
    setResetting(true);
    try {
      const { voidFailures } = await api.reset();
      if (voidFailures > 0) alert(`${voidFailures} PayPal hold(s) couldn't be released; they will expire on their own.`);
      window.location.reload();
    } catch (err) {
      setToast(`Reset failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setResetting(false);
    }
  };

  const tab = (to: Route, label: string) => (
    <a
      href={`#/${to === 'landing' ? '' : to}`}
      className={`rounded-lg px-3 py-1.5 text-sm font-bold ${route === to ? 'bg-brand-soft text-brand' : 'text-muted hover:text-ink'}`}
      aria-current={route === to ? 'page' : undefined}
    >
      {label}
    </a>
  );

  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4">
          <a href="#/" className="mr-2 flex items-center gap-2 font-bold text-brand">
            <ShieldCheck className="h-6 w-6" /> <span className="hidden sm:inline">Guardian Cart</span>
          </a>
          {tab('margaret', "Margaret's view")}
          {tab('caregiver', "Sarah's dashboard")}
          {route === 'caregiver' && sessionRole === 'caregiver' && (
            <button
              onClick={reset}
              disabled={resetting}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-bold text-muted hover:text-ink disabled:opacity-50"
            >
              <RotateCcw className="h-4 w-4" /> <span className="hidden sm:inline">Reset demo</span>
            </button>
          )}
        </div>
      </nav>

      {toast && (
        <div role="status" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-ink px-4 py-3 text-white shadow-lg">
          {toast}
        </div>
      )}

      {route === 'landing' && <Landing />}
      {neededRole && sessionError && (
        <p role="alert" className="mx-auto max-w-3xl px-4 py-10 text-xl text-danger">
          Couldn't open this page: {sessionError}. Please refresh.
        </p>
      )}
      {neededRole === 'caregiver' && needsPin && sessionRole !== 'caregiver' && (
        <PinPrompt
          onUnlocked={() => {
            setNeedsPin(false);
            setSessionRole('caregiver');
          }}
        />
      )}
      {neededRole && !sessionError && !needsPin && (
        <Suspense fallback={<PageLoading />}>
          {sessionRole !== neededRole ? <PageLoading /> : route === 'margaret' ? <ElderView /> : <CaregiverView />}
        </Suspense>
      )}
    </div>
  );
}

function PinPrompt({ onUnlocked }: { onUnlocked: () => void }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="mx-auto mt-16 max-w-sm space-y-4 rounded-2xl border border-line bg-surface p-6"
      onSubmit={async e => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api.startSession('caregiver', pin);
          onUnlocked();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1 className="flex items-center gap-2 text-xl font-bold">
        <KeyRound className="h-5 w-5 text-brand" /> Sarah's dashboard
      </h1>
      <p className="text-muted">This page can approve payments and change the rules, so it needs the caregiver PIN.</p>
      <label className="block">
        <span className="text-sm font-bold">PIN</span>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          autoFocus
          value={pin}
          onChange={e => setPin(e.target.value)}
          className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2 text-lg outline-none focus:border-brand"
        />
      </label>
      {error && <p role="alert" className="text-danger">{error}</p>}
      <Button type="submit" busy={busy} disabled={!pin.trim()} className="w-full">
        Open dashboard
      </Button>
    </form>
  );
}

function PageLoading() {
  return (
    <div className="flex justify-center py-20 text-brand">
      <Spinner className="h-8 w-8" />
    </div>
  );
}
