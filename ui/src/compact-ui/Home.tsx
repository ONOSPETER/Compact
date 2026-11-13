import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useCompact } from './store';
import { Logo } from './components/Logo';
import { SiteHeader } from './components/Shell';
import { Button, Callout } from './components/Kit';

/** Draws its children at a fixed design size and scales them to fit the available width, so nothing overflows on phones. */
function FitBox({ w, h, children }: { w: number; h: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [s, setS] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const fit = () => setS(Math.min(1, el.clientWidth / w));
    fit(); const ro = new ResizeObserver(fit); ro.observe(el); return () => ro.disconnect();
  }, [w]);
  return <div ref={ref} style={{ width: '100%', maxWidth: w, height: h * s }}><div style={{ width: w, height: h, transform: `scale(${s})`, transformOrigin: 'top left' }}>{children}</div></div>;
}

export function Home({ onStart }: { onStart: () => void }) {
  const { session, theme, newApp, error } = useCompact();
  const hasWork = !!session && session.apps.length > 0;
  return (
    <div className="cx" data-theme={theme}>
      <SiteHeader onConnected={onStart} />
      <section className="cx-hero">
        <div>
          <p className="cx-eyebrow"><span />Post-quantum hardening for your app</p>
          <h1 className="cx-hero-h1">Make your app<em>quantum-ready.</em></h1>
          <p className="cx-hero-p">Compact splits your Vite app, encrypts traffic and your users’ data with post-quantum cryptography, anchors proof on NEAR testnet and ships it to Vercel, one guided step at a time.</p>
          <div className="cx-wrapRow" style={{ gap: 22 }}>
            <Button primary className="cx-big" onClick={onStart}>{hasWork ? 'Continue where you left off' : 'Start guided setup'} →</Button>
            <a className="cx-ulink" href="#how" onClick={(e) => { e.preventDefault(); document.getElementById('how')?.scrollIntoView({ behavior: 'smooth' }); }}>See how it works ↓</a>
          </div>
          {hasWork && <p style={{ margin: '18px 0 0', fontSize: 14 }}><button className="cx-ulink" onClick={() => { newApp(); onStart(); }}>Start a new app instead</button></p>}
          {error && !session && <div style={{ marginTop: 20, maxWidth: 520 }}><Callout kind="warn" title="The Compact server isn’t running">{error.hint ?? error.message}</Callout></div>}
        </div>
        <FitBox w={560} h={540}>
          <div className="cx-art" aria-hidden>
            <div className="cx-card-a cx-c1"><span className="cx-mono-s">PORTAL/</span><b>Public UI</b><small>Vite app on Vercel</small></div>
            <div className="cx-card-a cx-c2"><span className="cx-mono-s">CRITICAL/</span><b>Backend, sealed</b><small>Hybrid post-quantum channel</small></div>
            <div className="cx-card-a cx-c3"><Logo size={150} /></div>
            <div className="cx-chip cx-ch1"><div><b>Vite + Node?</b><small>If it ships on Vercel, it fits.</small></div></div>
            <div className="cx-chip cx-ch2"><span className="cx-tick">✓</span><div><b>Manifest anchored</b><small>On NEAR testnet</small></div></div>
          </div>
        </FitBox>
        <p className="cx-hero-foot">Testnet only · GitHub to Vercel · 9 guided steps</p>
      </section>
      <section id="how" className="cx-how">
        <h2 className="cx-h1" style={{ fontSize: 'clamp(28px,4vw,42px)' }}>How it works <em>in four moves.</em></h2>
        <div className="cx-how-grid">
          {[['1', 'Split', 'Compact sorts your Vite app into a public portal and a private critical half, with a reason for every file.'], ['2', 'Seal', 'It creates ML-KEM and ML-DSA keys. Traffic uses a hybrid post-quantum channel, and your users’ data is encrypted on their device first.'], ['3', 'Anchor', 'A fingerprint of your app is written on NEAR testnet, so anyone can check what they load.'], ['4', 'Ship', 'Compact pushes one repo to GitHub, and you deploy it on Vercel with the exact settings it gives you.']].map(([n, t, b]) => (
            <div key={n} className="cx-c"><p className="cx-cap" style={{ margin: 0 }}>{n}</p><h3 className="cx-ct" style={{ margin: '6px 0' }}>{t}</h3><p style={{ margin: 0, color: 'var(--ink2)', fontSize: 14 }}>{b}</p></div>
          ))}
        </div>
        <p className="cx-note" style={{ marginTop: 20 }}>About 75% post-quantum by our own scoring, which is not a standard. Testnet only. Vercel can still see request data while your backend runs.</p>
      </section>
    </div>
  );
}
