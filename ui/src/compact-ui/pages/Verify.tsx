import { useCompact } from '../store';
import { validUrl } from '../flow';
import { PageFrame } from '../components/Shell';
import { Button, Card, CopyField, ErrorNote, Ext, Pair, Row, Rows, useJob } from '../components/Kit';
import type { VerifyResult } from '../api';

const LABELS: [VerifyResult['checks'][number]['id'], string][] = [
  ['live', 'Function is live (/api/compact/health)'], ['integrity', 'Backend files match the signed manifest'], ['record', 'Manifest matches the NEAR record'],
  ['handshake', 'Encrypted handshake works'], ['vault', 'Vault test: write, read, verify'],
];

export function Verify() {
  const { app, session, url, flags, flag, refresh, refreshApp, askFunds, newApp, resetAll } = useCompact();
  const d = session?.deployer;
  const v = useJob<VerifyResult>(); const dep = useJob(); const push = useJob();
  const result = v.job?.result?.checks ?? null;
  const origin = validUrl(url) ? new URL(url.trim()).origin : '';
  const run = async () => { const r = await v.run('verify', { appId: app?.id, url: origin }); if (r) flag('verified', r.checks.every((c) => c.ok)); };
  const link = async () => {
    if (!d?.funded) return askFunds(true);
    const a = await dep.run('deploy', { appId: app?.id, endpoint: origin });
    if (!a) return;
    const b = await push.run('push', { appId: app?.id });
    if (b) { flag('linked'); await refresh(); await refreshApp(); }
  };
  const stateOf = (id: string) => { const c = result?.find((x) => x.id === id); return c ? (c.ok ? 'done' : 'bad') : v.running ? 'busy' : flags.verified ? 'done' : 'todo'; };
  const failed = (result ?? []).filter((c) => !c.ok);
  const busyLink = dep.running || push.running;
  return (
    <PageFrame title="Verify your" em="live app." canNext={false} hideNext
      lead="Compact tests your deployment end to end, so you know it works before anyone else uses it."
      help={{ title: 'If a check fails', links: [{ label: 'Open the health URL', href: origin ? `${origin}/api/compact/health` : 'https://vercel.com' }, { label: 'Vercel docs: function logs', href: 'https://vercel.com/docs/functions/logs' }, { label: 'Sign-in page on your URL?', href: 'https://vercel.com/docs/security/deployment-protection' }] }}>
      <Pair>
        <Card cap="Checks on your Vercel URL">
          <Rows>
            {LABELS.map(([id, label]) => { const c = result?.find((x) => x.id === id); return <Row key={id} state={stateOf(id)} label={label} hint={c && !c.ok ? [c.message, c.hint].filter(Boolean).join(' ') : undefined} />; })}
            <Row state={flags.linked ? 'done' : busyLink ? 'busy' : 'todo'} label="Anchor your live URL (1 transaction)" tag={flags.linked ? 'Done' : undefined} />
          </Rows>
          <div className="cx-wrapRow" style={{ marginTop: 12 }}>
            <Button primary={!flags.verified} ghost={!!flags.verified} onClick={run} disabled={v.running || !origin || !app}>{v.running ? 'Checking…' : result || flags.verified ? 'Run checks again' : 'Run checks'}</Button>
            <Button primary={!!flags.verified && !flags.linked} ghost={!flags.verified || !!flags.linked} onClick={link} disabled={busyLink || !flags.verified}>{busyLink ? 'Linking…' : flags.linked ? 'Link again' : 'Anchor live URL'}</Button>
          </div>
          {!origin && <p className="cx-note">Go back and paste your Vercel URL first.</p>}
          {failed.length > 0 && <p className="cx-note">Fix the failed check, then run them again. Vault test writes and deletes one tiny entry.</p>}
          <div style={{ marginTop: 10 }}><ErrorNote error={v.error ?? dep.error ?? push.error} /></div>
        </Card>
        <Card dark cap="Hardening score · estimate">
          <p className="cx-big-n">75%</p>
          <p style={{ fontSize: 13, margin: '0 0 16px', opacity: .9 }}>Protected: API traffic and vault data against recorded-traffic attacks. Not yet: TLS certificates and the ed25519 anchor signature.</p>
          {origin ? <a className="cx-btn" style={{ background: 'var(--inv-ink)', color: 'var(--inv)', borderColor: 'var(--inv-ink)' }} href={origin} target="_blank" rel="noreferrer noopener">Open your live app</a> : null}
          <p className="cx-note" style={{ color: 'inherit', opacity: .7 }}>Our own rubric, not a standard. Vercel can still see request data while your backend runs.</p>
        </Card>
      </Pair>
      {flags.linked && app && (
        <Card cap="Your deliverables" title="Save these">
          <div className="cx-stack">
            {app.endpoint && <CopyField label="Live app" value={app.endpoint} />}
            {app.github && <CopyField label="GitHub repository" value={app.github.url} />}
            {app.registry && <CopyField label="NEAR registry account (testnet)" value={app.registry} />}
            <p className="cx-note" style={{ margin: 0 }}>Keep your runner key file and deployer secret safe. Vault keys live in <span className="mono">~/.compact/vault-keys/</span>; without one, its data cannot be read. <Ext href={`${app.explorer}/address/${app.registry ?? ''}`}>Explorer</Ext></p>
            <div className="cx-wrapRow"><Button primary onClick={newApp}>Protect another app</Button><Button ghost onClick={resetAll}>Start over</Button></div>
          </div>
        </Card>
      )}
    </PageFrame>
  );
}
