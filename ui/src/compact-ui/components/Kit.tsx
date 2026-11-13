import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ApiError, runJob, type ErrInfo, type Job } from '../api';

export const Button = ({ primary, small, ghost, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; small?: boolean; ghost?: boolean }) => (
  <button type="button" {...p} className={`cx-btn${primary ? ' primary' : ''}${small ? ' sm' : ''}${ghost ? ' ghost' : ''} ${p.className ?? ''}`} />
);
export const Field = ({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) => (
  <label className="cx-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>
);
export const Callout = ({ kind = 'info', title, children }: { kind?: 'info' | 'warn' | 'bad' | 'ok'; title?: string; children?: ReactNode }) => (
  <div className={`cx-call ${kind}`} role={kind === 'bad' ? 'alert' : undefined}>{title && <b>{title}</b>}{children}</div>
);
export const Ext = ({ href, children }: { href: string; children: ReactNode }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;

/** A white card with a small mono caption, like the design. */
export const Card = ({ cap, title, children, dark, className = '' }: { cap?: string; title?: ReactNode; children?: ReactNode; dark?: boolean; className?: string }) => (
  <section className={`cx-c${dark ? ' dark' : ''} ${className}`}>{cap && <p className="cx-cap">{cap}</p>}{title && <h3 className="cx-ct">{title}</h3>}{children}</section>
);
export const Pair = ({ children }: { children: ReactNode }) => <div className="cx-pair">{children}</div>;
export const Chip = ({ children }: { children: ReactNode }) => <span className="cx-chip-o">{children}</span>;

export type RowState = 'done' | 'todo' | 'busy' | 'bad' | 'warn';
export const Rows = ({ children }: { children: ReactNode }) => <ul className="cx-rows">{children}</ul>;
/** One line in a card: a round tick, a label and a small mono tag. Give it onToggle and the tick becomes a checkbox. */
export function Row({ state, label, tag, hint, onToggle, children }: { state: RowState; label: ReactNode; tag?: ReactNode; hint?: ReactNode; onToggle?: (v: boolean) => void; children?: ReactNode }) {
  const mark = { done: '✓', todo: '', busy: '··', bad: '!', warn: '!' }[state];
  return (
    <li className="cx-row2">
      {onToggle
        ? <button type="button" className="cx-ck" data-s={state} role="checkbox" aria-checked={state === 'done'} aria-label={typeof label === 'string' ? label : 'Mark as done'} onClick={() => onToggle(state !== 'done')}>{mark}</button>
        : <span className="cx-ck" data-s={state} aria-hidden>{mark}</span>}
      <div className="cx-rl"><span>{label}</span>{hint && <small>{hint}</small>}{children}</div>
      {tag !== undefined && <span className="cx-tag">{tag}</span>}
    </li>
  );
}

export function HelpCard({ cap = 'Need help?', title, links }: { cap?: string; title: string; links: { label: string; href: string }[] }) {
  return (
    <Card cap={cap} className="cx-help">
      <h3 className="cx-ct">{title}</h3>
      <ul>{links.map((l) => <li key={l.href}><span aria-hidden>►</span><Ext href={l.href}>{l.label}</Ext></li>)}</ul>
    </Card>
  );
}

export function CopyField({ label, value, mask, getValue }: { label?: string; value?: string; mask?: boolean; getValue?: () => Promise<string> }) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(!mask);
  const copy = async () => { try { await navigator.clipboard.writeText(value ?? (await getValue?.()) ?? ''); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setShown(true); } };
  return (
    <div style={{ minWidth: 0 }}>
      {label && <p className="cx-lbl">{label}</p>}
      <div className="cx-copy">
        <code>{shown ? value : '•'.repeat(Math.min(value?.length ?? 24, 32))}</code>
        {mask && <Button small ghost onClick={() => setShown((s) => !s)} aria-pressed={shown}>{shown ? 'Hide' : 'Reveal'}</Button>}
        <Button small onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
    </div>
  );
}

export function ErrorNote({ error }: { error: ErrInfo | ApiError | null }) {
  if (!error) return null;
  return (
    <Callout kind="bad" title={error.message}>
      {error.hint && <div>{error.hint}</div>}
      {error.details && error.details.length > 0 && <ul>{error.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
      <small className="mono" style={{ opacity: .7 }}>{error.code}</small>
    </Callout>
  );
}

/** Run a bridge job and expose its live steps. */
export function useJob<T = any>() {
  const [job, setJob] = useState<Job<T> | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<ErrInfo | null>(null);
  const alive = useRef(true);
  const run = useCallback(async (kind: Parameters<typeof runJob>[0], body: object): Promise<T | null> => {
    setRunning(true); setError(null); setJob(null);
    try { return (await runJob<T>(kind, body, (j) => alive.current && setJob(j))) as T; }
    catch (e) { const err = e as ApiError; setError({ code: err.code ?? 'E_UNEXPECTED', message: err.message, hint: err.hint, details: err.details }); return null; }
    finally { setRunning(false); }
  }, []);
  return { job, running, error, run };
}

/** A running job's steps as rows. */
export function JobRows({ job, error }: { job: Job | null; error?: ErrInfo | null }) {
  if (!job) return null;
  return (
    <Rows>
      {job.steps.map((s, i) => <Row key={i} state={s.state === 'done' ? 'done' : s.state === 'failed' ? 'bad' : 'busy'} label={s.title} hint={s.state === 'running' ? s.detail : s.note} />)}
      {job.warnings.map((w, i) => <Row key={`w${i}`} state="warn" label={w} />)}
      {error && !job.steps.some((s) => s.state === 'failed') && <Row state="bad" label="Stopped" />}
    </Rows>
  );
}

export function Modal({ onClose, children, label }: { onClose: () => void; children: ReactNode; label: string }) {
  return (
    <div className="cx-modal-bg" onClick={onClose}>
      <div className="cx-modal" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}
