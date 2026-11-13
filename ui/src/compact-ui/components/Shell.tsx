import { useEffect, useState, type ReactNode } from 'react';
import { Logo } from './Logo';
import { Button, Card, Chip, CopyField, Ext, HelpCard, Modal } from './Kit';
import { ConnectModal, shortId } from './ConnectModal';
import { useCompact } from '../store';
import { PAGE_COUNT, PAGE_LABEL, RAIL, pageDone, railDone } from '../flow';

export const DOCS_URL = 'https://docs.near.org/';

/** Same header on the home page and inside the app. */
export function SiteHeader({ onConnected }: { onConnected?: () => void }) {
  const { theme, toggleTheme, home, session } = useCompact();
  const [open, setOpen] = useState(false);
  const d = session?.deployer;
  const guide = () => { home(); setTimeout(() => document.getElementById('how')?.scrollIntoView({ behavior: 'smooth' }), 60); };
  return (
    <>
      <header className="cx-hd">
        <button className="cx-brand" onClick={home} aria-label="Compact home"><Logo size={32} /><span>compact</span></button>
        <span className="cx-grow" />
        <button className="cx-nav" onClick={guide}>Guide</button>
        <a className="cx-nav" href={DOCS_URL} target="_blank" rel="noreferrer noopener">Docs</a>
        <span className="cx-pill-o"><span className="cx-sq" />Testnet</span>
        <button className="cx-theme" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>{theme === 'dark' ? '☀' : '☾'}</button>
        <Button primary small onClick={() => setOpen(true)}>{d ? shortId(d.accountId) : 'Connect wallet'}</Button>
      </header>
      {open && <ConnectModal onClose={() => setOpen(false)} onDone={() => { setOpen(false); onConnected?.(); }} />}
    </>
  );
}

export const Strip = () => <div className="cx-strip">Testnet only · No real funds · You can reset anytime</div>;

/** Left rail on desktop; a compact progress bar on phones. */
export function Rail() {
  const { step, go, reach, session, flags, plan, app, url, resetAll } = useCompact();
  const [confirm, setConfirm] = useState(false);
  const p = { session, flags, plan, app, url };
  const cur = RAIL.filter((r) => r.page === step);
  return (
    <nav className="cx-rail" aria-label="Progress">
      <div className="cx-rail-bar">
        <p className="cx-stepno" style={{ margin: 0 }}>Step {PAGE_LABEL[step]} / {String(RAIL.length).padStart(2, '0')} · {cur.map((c) => c.label).join(' + ')}</p>
        <div className="segs">{RAIL.map((r) => <i key={r.id} data-s={r.page < step ? 'done' : r.page === step ? 'now' : ''} />)}</div>
      </div>
      <ol>
        {RAIL.map((r, i) => {
          const done = r.page < reach && railDone(r.id, p);
          const now = r.page === step;
          return (
            <li key={r.id}>
              <button className="ri" data-s={done ? 'done' : ''} disabled={r.page > reach} aria-current={now ? 'step' : undefined} onClick={() => go(r.page)}>
                <span className="ck">{done ? '✓' : ''}</span><span className="n">{String(i + 1).padStart(2, '0')}</span><span>{r.label}{now ? ' ●' : ''}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <button className="cx-startover" onClick={() => setConfirm(true)}>Start over</button>
      {confirm && (
        <Modal onClose={() => setConfirm(false)} label="Start over">
          <Chip>Testnet</Chip><h2>Start over?</h2>
          <p>This clears your checklist and progress here. Nothing is deleted from disk, GitHub or NEAR, and your deployer account stays connected.</p>
          <div className="cx-wrapRow"><Button primary onClick={() => { resetAll(); setConfirm(false); }}>Start over</Button><Button ghost onClick={() => setConfirm(false)}>Cancel</Button></div>
        </Modal>
      )}
    </nav>
  );
}

/** One page of the flow: step label, headline, content, Back/Continue, and the help card on the right. */
export function PageFrame({ title, em, lead, help, children, canNext, onNext, hideNext, nextLabel = 'Continue' }: {
  title: string; em: string; lead: ReactNode; help: { title: string; links: { label: string; href: string }[] }; children: ReactNode;
  canNext: boolean; onNext?: () => void; hideNext?: boolean; nextLabel?: string;
}) {
  const { step, back, next } = useCompact();
  return (
    <>
      <div className="cx-main">
        <p className="cx-stepno">Step {PAGE_LABEL[step]} / {String(RAIL.length).padStart(2, '0')}</p>
        <h1 className="cx-h1">{title} <em>{em}</em></h1>
        <p className="cx-lead">{lead}</p>
        {children}
        <div className="cx-foot">
          {step > 0 && <Button ghost onClick={back}>Back</Button>}
          {!hideNext && step < PAGE_COUNT - 1 && <Button primary disabled={!canNext} onClick={() => { onNext?.(); next(); }}>{nextLabel} →</Button>}
        </div>
      </div>
      <aside className="cx-aside"><HelpCard title={help.title} links={help.links} /></aside>
    </>
  );
}

/** Pop-up shown when the deployer cannot pay for transactions. */
export function LowBalance() {
  const { session, fundsOpen, askFunds, refresh } = useCompact();
  const d = session?.deployer;
  useEffect(() => { if (d?.funded && fundsOpen) askFunds(false); }, [d?.funded, fundsOpen, askFunds]);
  if (!fundsOpen || !d) return null;
  return (
    <Modal onClose={() => askFunds(false)} label="Balance too low">
      <Chip>Testnet</Chip>
      <h2>Your balance is too low</h2>
      <p>You have {d.balanceNear} NEAR. Compact needs at least {d.minNear} to deploy. This is test money: it is free from the faucet.</p>
      <CopyField label="Send testnet NEAR to this address" value={d.accountId} />
      <div className="cx-wrapRow" style={{ marginTop: 16 }}>
        <a className="cx-btn primary" href="https://near-faucet.io" target="_blank" rel="noreferrer noopener">Open the faucet</a>
        <Button ghost onClick={() => void refresh()}>Check again</Button>
      </div>
      <p className="cx-note">Other ways to get test NEAR: <Ext href={DOCS_URL}>NEAR docs</Ext>.</p>
    </Modal>
  );
}
