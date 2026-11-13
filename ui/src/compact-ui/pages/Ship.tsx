import { useState } from 'react';
import { useCompact } from '../store';
import { PageFrame } from '../components/Shell';
import { Button, Callout, Card, ErrorNote, Ext, Field, JobRows, Pair, Row, Rows, useJob } from '../components/Kit';
import type { Receipt } from '../api';

type Pushed = { files?: string[]; url?: string };

export function Ship() {
  const { app, session, refresh, refreshApp, askFunds } = useCompact();
  const d = session?.deployer;
  const [pass, setPass] = useState(''); const [owner, setOwner] = useState(''); const [repo, setRepo] = useState(''); const [priv, setPriv] = useState(true);
  const [files, setFiles] = useState<string[] | null>(null);
  const dep = useJob<{ receipts: Receipt[] }>(); const push = useJob<Pushed>();
  const anchored = !!app && app.deployments > 0; const gh = app?.github;
  const rc = (name: string) => (dep.job?.result?.receipts ?? app?.lastReceipts ?? []).find((r) => r.name === name);

  const anchor = async () => {
    if (!d?.funded) return askFunds(true);
    const r = await dep.run('deploy', { appId: app?.id, passphrase: pass || undefined });
    if (r) { await refresh(); await refreshApp(); }
  };
  const body = { appId: app?.id, repo, owner, public: !priv };
  const preview = async () => { const r = await push.run('push', { ...body, dryRun: true }); if (r?.files) setFiles(r.files); };
  const doPush = async () => { const r = await push.run('push', body); if (r) { setFiles(null); await refresh(); await refreshApp(); } };
  const tx = (name: string, busy: boolean) => { const r = rc(name); return r ? `TX ${r.txHash.slice(0, 5)}…` : busy ? 'SENDING' : 'WAITING'; };
  const secretFail = !!push.error && /SECRET/i.test(push.error.code);

  return (
    <PageFrame title="Anchor it," em="then push it." canNext={anchored && !!gh}
      lead="Two testnet transactions record your app’s fingerprint on-chain. Then everything ships to one private repository that Vercel can deploy."
      help={{ title: 'Understand the steps', links: [{ label: 'Transaction explorer (testnet)', href: app?.explorer ?? 'https://testnet.nearblocks.io' }, { label: 'GitHub docs: repositories', href: 'https://docs.github.com/en/repositories/creating-and-managing-repositories/about-repositories' }] }}>
      <Pair>
        <Card cap="06 · Anchor on NEAR testnet" title="Compact signs with your deployer">
          <Rows>
            <Row state={rc('deploy-registry') || anchored ? 'done' : dep.running ? 'busy' : 'todo'} label="Deploy registry contract" tag={tx('deploy-registry', dep.running)} />
            <Row state={rc('write-record') || anchored ? 'done' : dep.running ? 'busy' : 'todo'} label="Write app record" tag={tx('write-record', dep.running)} />
          </Rows>
          {d?.encrypted && <Field label="Deployer passphrase"><input className="cx-in" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" /></Field>}
          <p className="cx-note">Each one is a testnet transaction paid with free test NEAR. Only hashes and your app’s address go on-chain.</p>
          <div style={{ marginTop: 12 }}><Button primary onClick={anchor} disabled={dep.running || !app}>{dep.running ? 'Anchoring…' : anchored ? 'Anchor again' : 'Anchor on testnet'}</Button></div>
          <JobRows job={dep.running ? dep.job : null} error={dep.error} />
          <div style={{ marginTop: 10 }}><ErrorNote error={dep.error} /></div>
          {anchored && app?.registry && <p className="cx-note"><Ext href={`${app.explorer}/address/${app.registry}`}>View registry on the explorer</Ext></p>}
        </Card>
        <Card cap="07 · Push to GitHub">
          <div className="cx-wrapRow" style={{ flexWrap: 'nowrap', marginBottom: 12 }}>
            <input className="cx-in mono" style={{ flex: 1, minWidth: 0 }} aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder={session?.github?.user ?? 'you'} />
            <span aria-hidden>/</span>
            <input className="cx-in mono" style={{ flex: 1, minWidth: 0 }} aria-label="Repository" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder={app?.name ?? 'notes-demo'} />
          </div>
          <Rows>
            <Row state={priv ? 'done' : 'todo'} label="Private repository" tag={priv ? 'On' : 'Off'} onToggle={setPriv} />
            <Row state={secretFail ? 'bad' : files || gh ? 'done' : 'todo'} label="Secret scan" tag={secretFail ? 'Blocked' : files || gh ? '0 found' : 'Waiting'} />
            <Row state={gh ? 'done' : files ? 'done' : push.running ? 'busy' : 'todo'} label={files ? `${files.length} files ready` : gh ? 'Pushed' : 'Files ready'} tag={gh ? 'Done' : 'Waiting'} />
          </Rows>
          <div className="cx-wrapRow" style={{ marginTop: 12 }}>
            <Button ghost onClick={preview} disabled={push.running || !app}>Preview files</Button>
            <Button primary onClick={doPush} disabled={push.running || !anchored}>{push.running ? 'Pushing…' : gh ? 'Push again' : 'Push to GitHub'}</Button>
          </div>
          {!anchored && <p className="cx-note">Anchor first, so the pushed files carry your on-chain address.</p>}
          <JobRows job={push.running ? push.job : null} error={push.error} />
          <div style={{ marginTop: 10 }}><ErrorNote error={push.error} /></div>
          {gh && <div style={{ marginTop: 12 }}><Callout kind="ok" title={gh.private === false ? 'Pushed (public)' : 'Pushed (private)'}><Ext href={gh.url}>{gh.owner}/{gh.repo}</Ext> · {gh.branch}</Callout></div>}
        </Card>
      </Pair>
    </PageFrame>
  );
}
