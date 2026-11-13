import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, type AppDetail, type Plan, type Session } from './api';
import { PAGE_COUNT, maxReachable, type Progress } from './flow';

type Source = { source: string; critical: string; portal: string; entry: string; port: string };
type Ctx = {
  session: Session | null; error: ApiError | null; refresh: () => Promise<void>;
  app: AppDetail | null; refreshApp: () => Promise<void>; appId: string; setAppId: (id: string) => void;
  step: number; go: (n: number) => void; next: () => void; back: () => void; reach: number;
  flags: Record<string, boolean>; flag: (k: string, v?: boolean) => void;
  src: Source; setSrc: (s: Partial<Source>) => void; plan: Plan | null; setPlan: (p: Plan | null) => void;
  theme: 'light' | 'dark'; toggleTheme: () => void; home: () => void; newApp: () => void; resetAll: () => void; ready: boolean;
  url: string; setUrl: (u: string) => void;
  lowBalance: boolean; askFunds: (on: boolean) => void; fundsOpen: boolean;
};
const C = createContext<Ctx>(null as unknown as Ctx);
export const useCompact = () => useContext(C);

/** Small persisted state hook: wizard position and ticks survive a refresh. Nothing secret is stored. */
export function usePersisted<T>(key: string, init: T, store: Storage = localStorage): [T, (v: T | ((p: T) => T)) => void] {
  const [v, set] = useState<T>(() => { try { const raw = store.getItem(key); return raw ? (JSON.parse(raw) as T) : init; } catch { return init; } });
  useEffect(() => { try { store.setItem(key, JSON.stringify(v)); } catch { /* storage full or blocked */ } }, [key, v, store]);
  return [v, set];
}

export function CompactProvider({ children, onHome }: { children: ReactNode; onHome: () => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [app, setApp] = useState<AppDetail | null>(null);
  const [appId, setAppId] = usePersisted('compact.ui.app', '');
  const [step, setStep] = usePersisted('compact.ui.step', 0);
  const [flags, setFlags] = usePersisted<Record<string, boolean>>('compact.ui.flags', {});
  const [src, setSrcState] = usePersisted<Source>('compact.ui.src', { source: '', critical: '', portal: '', entry: '', port: '' });
  const [plan, setPlan] = usePersisted<Plan | null>('compact.ui.plan', null, sessionStorage);
  const [theme, setTheme] = usePersisted<'light' | 'dark'>('compact.ui.theme', window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const [url, setUrl] = usePersisted('compact.ui.url', '');
  const [fundsOpen, askFunds] = useState(false);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  const [appLoaded, setAppLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try { setSession(await api.session()); setError(null); }
    catch (e) { setError(e as ApiError); }
  }, []);
  const refreshApp = useCallback(async () => {
    if (!appId) { setApp(null); setAppLoaded(true); return; }
    try { setApp(await api.app(appId)); } catch { setApp(null); } finally { setAppLoaded(true); }
  }, [appId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void refreshApp(); }, [refreshApp, session?.apps]);

  // Same deployer account, same unfinished work: progress lives on the Compact server, keyed by the account.
  const accountId = session?.deployer?.accountId ?? '';
  useEffect(() => {
    if (!session || hydratedFor === accountId) return;
    let alive = true;
    (async () => {
      if (accountId) {
        try {
          const { progress: p } = await api.getProgress();
          if (alive && p) { setStep(Math.min(p.step, PAGE_COUNT - 1)); setFlags(p.flags); setSrcState(p.src); setAppId(p.appId); setUrl(p.url); setPlan(null); setAppLoaded(false); }
          else if (alive && hydratedFor !== null) { setStep(0); setFlags({}); setSrcState({ source: '', critical: '', portal: '', entry: '', port: '' }); setAppId(''); setUrl(''); setPlan(null); }
        } catch { /* keep what this browser remembers */ }
      }
      if (alive) setHydratedFor(accountId);
    })();
    return () => { alive = false; };
  }, [session, accountId, hydratedFor, setStep, setFlags, setSrcState, setAppId, setUrl, setPlan]);
  useEffect(() => {
    if (!accountId || hydratedFor !== accountId) return;
    const t = setTimeout(() => { void api.saveProgress({ step, flags, src, appId, url }).catch(() => {}); }, 600);
    return () => clearTimeout(t);
  }, [accountId, hydratedFor, step, flags, src, appId, url]);

  const progress: Progress = useMemo(() => ({ session, flags, plan, app, url }), [session, flags, plan, app, url]);
  const reach = maxReachable(progress);
  const go = useCallback((n: number) => setStep(Math.max(0, Math.min(n, PAGE_COUNT - 1))), [setStep]);
  const lowBalance = !!session?.deployer && !session.deployer.funded;
  const ready = !!session && hydratedFor === accountId && (!appId || appLoaded);
  const newApp = () => { for (const k of ['reviewed', 'keyBackup', 'vercel1', 'vercel2', 'vercel3', 'vercel4', 'vercel5', 'linked', 'verified']) setFlags((f) => ({ ...f, [k]: false })); setPlan(null); setAppId(''); setUrl(''); setStep(1); };
  const resetAll = () => { setFlags({}); setPlan(null); setAppId(''); setUrl(''); setSrcState({ source: '', critical: '', portal: '', entry: '', port: '' }); setStep(0); };

  const value: Ctx = {
    session, error, refresh, app, refreshApp, appId, setAppId, step: Math.min(step, Math.max(reach, 0)), go, reach,
    next: () => go(step + 1), back: () => go(step - 1),
    flags, flag: (k, v = true) => setFlags((f) => ({ ...f, [k]: v })),
    src, setSrc: (s) => setSrcState((p) => ({ ...p, ...s })), plan, setPlan,
    theme, toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), home: onHome, newApp, resetAll, ready, url, setUrl,
    lowBalance, askFunds, fundsOpen,
  };
  return <C.Provider value={value}>{children}</C.Provider>;
}
