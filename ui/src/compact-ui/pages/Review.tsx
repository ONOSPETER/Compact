import { useEffect, useState } from 'react';
import { api } from '../api';
import { useCompact } from '../store';
import { PageFrame } from '../components/Shell';
import { Button, Callout, Card, ErrorNote, Field, JobRows, Pair, Row, Rows, useJob } from '../components/Kit';

type Built = { appId: string; notes?: string[] };

export function Review() {
  const { plan, app, src, setAppId, refresh, refreshApp, flags, flag, go } = useCompact();
  const [key, setKey] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [name, setName] = useState(''); const [force, setForce] = useState(false); const [all, setAll] = useState(false);
  const { job, running, error, run } = useJob<Built>();
  useEffect(() => { if (app && !key) api.appKeys(app.id).then((r) => setKey(r.COMPACT_KEYS_B64)).catch(() => {}); }, [app, key]);

  const build = async () => {
    const r = await run('transform', { ...src, name, force });
    if (r) { setNotes((r.notes ?? []).filter((n) => /vite\.config|React plugin/.test(n))); setAppId(r.appId); flag('keyBackup', false); await refresh(); await refreshApp(); }
  };
  const download = () => { if (!key) return; const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([`COMPACT_KEYS_B64=${key}\n`], { type: 'text/plain' })); a.download = 'compact-keys.txt'; a.click(); URL.revokeObjectURL(a.href); };

  const entries = plan ? Object.entries(plan.files) : [];
  const crit = entries.filter(([, v]) => v.side === 'critical');
  const shown = all ? crit : crit.slice(0, 4);
  const blocked = !!plan && plan.errors.length > 0;
  const exists = error?.code === 'E_OUT_EXISTS';
  return (
    <PageFrame title="Review the split," em="save your key." canNext={!!app && !!flags.keyBackup}
      lead="Compact decided which files stay public and which run behind the encrypted channel. Fix any warnings, then build and store your key."
      help={{ title: 'Why this matters', links: [{ label: 'What is a post-quantum channel?', href: 'https://csrc.nist.gov/projects/post-quantum-cryptography' }, { label: 'Where to keep secrets', href: 'https://vercel.com/docs/projects/environment-variables' }] }}>
      <Pair>
        <Card cap="04 · How your app splits" title={plan ? (plan.mode === 'http' ? `Mode: server (${plan.entry})` : plan.mode === 'rpc' ? 'Mode: functions' : 'Mode: nothing private') : app ? `Built: ${app.name}` : 'Not analyzed yet'}>
          {plan ? (
            <>
              <Rows>
                {shown.map(([f, v]) => <Row key={f} state="done" label={<span className="mono">{f}</span>} tag="Critical" hint={v.reasons[0]} />)}
                <Row state="done" label={`${plan.counts.portal ?? 0} files in the public UI`} tag="Portal" />
                {plan.warnings.slice(0, 3).map((w, i) => <Row key={`w${i}`} state="warn" label={w.message} tag="Warning" hint={w.file} />)}
                {plan.errors.map((e, i) => <Row key={`e${i}`} state="bad" label={e.message} tag="Error" hint={e.file ?? e.hint} />)}
              </Rows>
              {crit.length > 4 && <Button small ghost style={{ marginTop: 8 }} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${crit.length} private files`}</Button>}
              {blocked && <div style={{ marginTop: 12 }}><Callout kind="bad" title="Fix these before building">Go back and add an override, or change the app.<div style={{ marginTop: 8 }}><Button small onClick={() => go(1)}>Back to your app</Button></div></Callout></div>}
            </>
          ) : app ? <p className="cx-note">This app was already analyzed and built. Go back one page to analyze it again.</p>
            : <p className="cx-note">Go back and download your app first.</p>}
        </Card>
        <Card cap="05 · Your secret key">
          {!app || force || running || error ? (
            <>
              <p className="cx-note" style={{ marginTop: 0 }}>Building writes your project and creates fresh post-quantum keys. Your original code is not changed.</p>
              <Field label="Project name (optional)"><input className="cx-in" value={name} onChange={(e) => setName(e.target.value)} placeholder="notes-demo" /></Field>
              {(exists || force) && <Callout kind="warn" title="That folder already exists"><label className="cx-check"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /><span>Replace it (this makes new keys)</span></label></Callout>}
              <div style={{ marginTop: 12 }}><Button primary onClick={build} disabled={running || !plan || blocked}>{running ? 'Building…' : 'Looks right: build'}</Button></div>
              <JobRows job={running ? job : null} error={error} />
              <div style={{ marginTop: 10 }}><ErrorNote error={error} /></div>
            </>
          ) : (
            <>
              <div className="cx-keybox">COMPACT_KEYS_B64 = {key ? `${key.slice(0, 14)}…` : '…'}<br />••••••••••</div>
              <div className="cx-wrapRow"><Button onClick={async () => { if (key) { await navigator.clipboard.writeText(key).catch(() => {}); } }} disabled={!key}>Copy</Button><Button onClick={download} disabled={!key}>Download</Button></div>
              <p className="cx-note"><b>Keep it safe.</b> Your backend cannot start without it. Never commit it. It is also stored at <span className="mono">{app.outDir}/compact/keys/runner.secret.json</span>.</p>
              <Rows><Row state={flags.keyBackup ? 'done' : 'todo'} label="I saved it somewhere safe" onToggle={(v) => flag('keyBackup', v)} /></Rows>
              {notes.length > 0 && <div style={{ marginTop: 12 }}><Callout title="Compact fixed your Vite setup"><ul>{notes.map((n, i) => <li key={i}>{n}</li>)}</ul></Callout></div>}
              <Button small ghost style={{ marginTop: 8 }} onClick={() => setForce(true)}>Rebuild from scratch</Button>
            </>
          )}
        </Card>
      </Pair>
    </PageFrame>
  );
}
