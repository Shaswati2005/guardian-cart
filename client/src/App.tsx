import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { Spinner } from '@astryxdesign/core/Spinner';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { useToast } from '@astryxdesign/core/Toast';
import { TopNav, TopNavHeading, TopNavItem } from '@astryxdesign/core/TopNav';
import { api, type Role } from './api';
import { Landing } from './pages/Landing';
import { icon, Logo } from './components/ui';

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
  const toast = useToast();
  // Phones get a compact nav (logo only, short tab names) so the bar never pushes the page sideways
  const narrow = useMediaQuery('(max-width: 639px)');
  const [resetting, setResetting] = useState(false);
  // The server checks a signed persona cookie on every action, so switch it before showing a page
  const [sessionRole, setSessionRole] = useState<Role | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const neededRole = ROLE_FOR_ROUTE[route];

  useEffect(() => {
    if (!neededRole || neededRole === sessionRole) return;
    let cancelled = false;
    setSessionError(null);
    // Reuse the cookie when it already has this role (reloads, returning from PayPal), so switching
    // pages doesn't log in over and over
    api
      .sessionInfo()
      .then(info => (info.roles.includes(neededRole) ? undefined : api.startSession(neededRole)))
      .then(() => !cancelled && setSessionRole(neededRole))
      .catch(err => {
        if (!cancelled) setSessionError(err instanceof Error ? err.message : String(err));
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
      const message = VAULT_MESSAGES[vault];
      if (message) toast({ body: message, type: vault === 'connected' ? 'info' : 'error' });
      window.history.replaceState(null, '', `${window.location.pathname}#/caregiver`);
      setRoute('caregiver');
    }
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('guardian:session-expired', onExpired);
    };
  }, [toast]);

  const reset = async () => {
    if (!confirm('Reset the demo? This clears chats, purchases and alerts and releases any PayPal holds. Your rules and the PayPal connection are kept.')) return;
    setResetting(true);
    try {
      const { voidFailures } = await api.reset();
      if (voidFailures > 0) alert(`${voidFailures} PayPal hold(s) couldn't be released; they will expire on their own.`);
      window.location.reload();
    } catch (err) {
      toast({ body: `Reset failed: ${err instanceof Error ? err.message : String(err)}`, type: 'error' });
    } finally {
      setResetting(false);
    }
  };

  const tab = (to: Route, label: string) => (
    <TopNavItem key={to} href={`#/${to === 'landing' ? '' : to}`} label={label} isSelected={route === to} />
  );

  return (
    // App frame: nav on top, and a fixed-height page area so each page's Astryx Layout can fill it
    <div className="flex h-dvh flex-col bg-body">
      <div className="z-40 shrink-0 border-b border-border bg-surface">
        <div className="mx-auto max-w-6xl px-2">
          <TopNav
            label="Main"
            heading={
              <TopNavHeading
                logo={<Logo size={28} />}
                logoLabel="Guardian Cart home"
                heading={narrow ? undefined : 'Guardian Cart'}
                headingHref="#/"
              />
            }
            startContent={[
              tab('margaret', narrow ? 'Margaret' : "Margaret's view"),
              tab('caregiver', narrow ? 'Sarah' : "Sarah's dashboard")
            ]}
            endContent={
              route === 'caregiver' &&
              sessionRole === 'caregiver' && (
                <Button
                  label="Reset demo"
                  isIconOnly={narrow}
                  tooltip={narrow ? 'Reset demo' : undefined}
                  variant="ghost"
                  size="sm"
                  icon={icon(RotateCcw)}
                  isLoading={resetting}
                  onClick={reset}
                />
              )
            }
          />
        </div>
      </div>

      <main className="relative min-h-0 flex-1">
        {route === 'landing' && <Landing />}
        {neededRole && sessionError && (
          <Scroll>
            <p role="alert" className="mx-auto max-w-3xl px-4 py-10 text-xl text-error">
              Couldn't open this page: {sessionError}. Please refresh.
            </p>
          </Scroll>
        )}
        {neededRole && !sessionError && (
          <Suspense fallback={<PageLoading />}>
            {sessionRole !== neededRole ? <PageLoading /> : route === 'margaret' ? <ElderView /> : <CaregiverView />}
          </Suspense>
        )}
      </main>
    </div>
  );
}

function Scroll({ children }: { children: ReactNode }) {
  return <div className="h-full overflow-y-auto">{children}</div>;
}

function PageLoading() {
  return (
    <div className="flex justify-center py-20">
      <Spinner size="xl" />
    </div>
  );
}
