import { api, type Plan } from '../api';
import { useState } from 'react';
import { useCompact } from '../store';
import { PageFrame } from '../components/Shell';
import { Button, Card, Chip, ErrorNote, Field, JobRows, Pair, Row, Rows, useJob } from '../components/Kit';

export function Source() {
  const { session, refresh, src, setSrc, plan, setPlan, flag, app } = useCompact();
  const gh = session?.github ?? null;
  const [token, setToken] = useState(''); const [busy, setBusy] = useState(false); const [gerr, setGerr] = useState<any>(null);
  const { job, running, error, run } = useJob<{ plan: Plan }>();
  const save = async () => { setBusy(true); setGerr(null); try { await api.saveGithub(token); setToken(''); await refresh(); } catch (e) { setGerr(e); } finally { setBusy(false); } };
  const analyze = async () => { const r = await run('analyze', src); if (r) { setPlan(r.plan); flag('reviewed', false); } };
  const files = plan ? Object.keys(plan.files).length : 0;
  return (
    <PageFrame title="Connect GitHub," em="pick your app." canNext={!!gh && (!!plan || !!app)}
      lead="Compact pushes your finished app to a private repository. Your token is saved on this machine only and sent to nobody but GitHub."
      help={{ title: 'Create a GitHub token', links: [{ label: 'Open GitHub’s new token page', href: 'https://github.com/settings/personal-access-tokens/new' }, { label: 'GitHub docs: personal access tokens', href: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens' }, { label: 'Or a classic token (repo scope)', href: 'https://github.com/settings/tokens/new?scopes=repo&description=Compact' }] }}>
      <Pair>
        <Card cap="02 · GitHub token">
          {!gh && <Field label="Token"><input className="cx-in mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" autoComplete="off" /></Field>}
          <div className="cx-chips"><Chip>Contents: read &amp; write</Chip><Chip>Administration: write</Chip></div>
          {!gh && <Button primary onClick={save} disabled={busy || !token.trim()}>{busy ? 'Checking…' : 'Save and verify'}</Button>}
          <Rows><Row state={gh ? 'done' : 'todo'} label={gh ? <>Token valid{gh.user ? ` · @${gh.user}` : ''}</> : 'Paste a token to verify it'}>
            {gh && <small><Button small ghost style={{ marginTop: 8 }} onClick={async () => { await api.clearGithub(); await refresh(); }}>Remove token</Button></small>}</Row></Rows>
          <ErrorNote error={gerr} />
        </Card>
        <Card cap="03 · Your app">
          <Field label="GitHub link or folder"><input className="cx-in mono" value={src.source} onChange={(e) => setSrc({ source: e.target.value })} placeholder="github.com/you/notes-demo" /></Field>
          <p className="cx-cap">{plan ? `Mode ${plan.mode} · ${plan.entry ?? 'vite'}` : 'Vite + Node apps'}</p>
          <Button primary onClick={analyze} disabled={running || !src.source.trim()}>{running ? 'Downloading…' : plan || app ? 'Download again' : 'Download and analyze'}</Button>
          <Rows>
            {plan || app ? <Row state="done" label={plan ? `Downloaded ${files} files` : 'App already built'} /> : <Row state="todo" label="Not downloaded yet" />}
          </Rows>
          <JobRows job={running ? job : null} error={error} />
          <ErrorNote error={error} />
          <details style={{ marginTop: 12 }}><summary style={{ cursor: 'pointer', fontSize: 13 }}>Advanced: override the split</summary>
            <div style={{ marginTop: 10 }}>
              <Field label="Always keep private (one per line)"><textarea className="cx-ta" rows={2} value={src.critical} onChange={(e) => setSrc({ critical: e.target.value })} /></Field>
              <Field label="Always keep public"><textarea className="cx-ta" rows={2} value={src.portal} onChange={(e) => setSrc({ portal: e.target.value })} /></Field>
              <Field label="Server entry"><input className="cx-in mono" value={src.entry} onChange={(e) => setSrc({ entry: e.target.value })} placeholder="server/index.js" /></Field>
              <Field label="Server port"><input className="cx-in mono" value={src.port} onChange={(e) => setSrc({ port: e.target.value })} placeholder="3001" /></Field>
            </div>
          </details>
        </Card>
      </Pair>
    </PageFrame>
  );
}
