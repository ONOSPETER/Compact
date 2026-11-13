import { useEffect, useState } from 'react';
import './styles.css';
import { CompactProvider, useCompact } from './store';
import { LowBalance, Rail, SiteHeader, Strip } from './components/Shell';
import { Button, ErrorNote } from './components/Kit';
import { Home } from './Home';
import { Wallet } from './pages/Wallet';
import { Source } from './pages/Source';
import { Review } from './pages/Review';
import { Ship } from './pages/Ship';
import { Vercel } from './pages/Vercel';
import { Verify } from './pages/Verify';

const PAGES = [Wallet, Source, Review, Ship, Vercel, Verify];

function Frame() {
  const { step, session, error, refresh, theme, ready } = useCompact();
  const Page = PAGES[step] ?? PAGES[0];
  // While the deployer is unfunded, look for the faucet transfer every few seconds.
  const waiting = !!session?.deployer && !session.deployer.funded;
  useEffect(() => { if (!waiting) return; const t = setInterval(() => void refresh(), 6000); return () => clearInterval(t); }, [waiting, refresh]);
  return (
    <div className="cx" data-theme={theme}>
      <SiteHeader />
      <Strip />
      <div className="cx-app">
        <Rail />
        {!session && error ? <div><ErrorNote error={error} /><div style={{ marginTop: 14 }}><Button onClick={() => void refresh()}>Try again</Button></div></div>
          : !ready ? <p className="cx-lead">Loading your work…</p> : <Page key={step} />}
      </div>
      <LowBalance />
    </div>
  );
}

const fromHash = () => (window.location.hash === '#/app' ? 'app' : 'home');

/** The whole Compact UI: a home page, and the guided setup behind it. Render it anywhere: <CompactApp />. */
export function CompactApp() {
  const [route, setRoute] = useState<'home' | 'app'>(fromHash());
  useEffect(() => { const f = () => setRoute(fromHash()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  const to = (r: 'home' | 'app') => { window.location.hash = r === 'app' ? '#/app' : ''; setRoute(r); window.scrollTo(0, 0); };
  return (
    <CompactProvider onHome={() => to('home')}>
      {route === 'home' ? <Home onStart={() => to('app')} /> : <Frame />}
    </CompactProvider>
  );
}
