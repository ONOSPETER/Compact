import { useEffect, useState } from 'react';
import { api, type Check } from '../api';
import { useCompact } from '../store';
import { PageFrame } from '../components/Shell';
import { Button, Callout, Card, CopyField, ErrorNote, Field, Row, Rows } from '../components/Kit';

export function Wallet() {
  const { session, refresh, flags, flag, askFunds } = useCompact();
  const d = session?.deployer ?? null;
  const [pass, setPass] = useState(''); const [secretIn, setSecretIn] = useState('');
  const [fresh, setFresh] = useState<{ secretKey: string } | null>(null); // memory only, shown once
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<any>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);

  useEffect(() => { void refresh(); api.doctor().then((r) => setChecks(r.checks)).catch(() => setChecks([])); }, [refresh]);
  const act = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); await refresh(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const create = () => act(async () => { const r = await api.createAccount(pass || undefined); setFresh(r); flag('created'); flag('savedKey', false); askFunds(true); });
  const imp = () => act(async () => { await api.importAccount(secretIn, pass || undefined); setSecretIn(''); flag('created', false); });

  const min = Number(d?.minNear ?? 0.05); const bal = Number(d?.balanceNear ?? 0);
  const pct = Math.max(0, Math.min(100, (bal / (min || 1)) * 100));
  const issues = (checks ?? []).filter((c) => c.status === 'fail' && !/^(Deployer|GitHub|RPC)/.test(c.name));
  const rpcOk = (checks ?? []).filter((c) => c.name.startsWith('RPC')).some((c) => c.status === 'ok') || !(checks ?? []).some((c) => c.name.startsWith('RPC'));
  const problems = issues.length + (rpcOk ? 0 : 1);

  return (
    <PageFrame title="Connect your" em="NEAR wallet." canNext={!!d?.funded && (!flags.created || !!flags.savedKey)}
      lead="This testnet account signs two transactions: it deploys a tiny registry contract and records your app’s fingerprint. No real money is involved."
      help={{ title: 'Get testnet NEAR', links: [{ label: 'Faucet: near-faucet.io', href: 'https://near-faucet.io' }, { label: 'NEAR docs: accounts', href: 'https://docs.near.org/' }, { label: 'Testnet explorer', href: 'https://testnet.nearblocks.io' }] }}>
      {!d ? (
        <div className="cx-stack">
          <Card cap="01 · Create a deployer" title="Fastest: let Compact make one">
            <Field label="Passphrase to encrypt the key (optional)" hint="If you set one, you enter it again to anchor and link your app."><input className="cx-in" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" /></Field>
            <Button primary onClick={create} disabled={busy}>{busy ? 'Creating…' : 'Create testnet account'}</Button>
          </Card>
          <Card cap="Or import your own" title="Already have a testnet key?">
            <Field label="Secret key" hint="Starts with ed25519:. Testnet keys only."><input className="cx-in mono" type="password" value={secretIn} onChange={(e) => setSecretIn(e.target.value)} autoComplete="off" /></Field>
            <Button onClick={imp} disabled={busy || !secretIn.trim()}>Import account</Button>
          </Card>
          <ErrorNote error={err} />
        </div>
      ) : (
        <div className="cx-stack">
          <Card cap="Connected · Testnet" title={<span className="mono" style={{ fontSize: 15, overflowWrap: 'anywhere' }}>{d.accountId}</span>}>
            <div className="cx-bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
            <p className="cx-cap" style={{ margin: 0 }}>{d.minNear} NEAR needed · you have {d.balanceNear}</p>
            <Rows>
              <Row state="done" label="Connect a testnet account" />
              <Row state={d.funded ? 'done' : 'todo'} label={`Hold at least ${d.minNear} NEAR`} tag={`${d.balanceNear} NEAR`} />
              <Row state={d.funded ? 'done' : 'busy'} label={d.funded ? 'Balance is enough' : 'Checking your balance every 6 seconds'} tag={d.funded ? 'OK' : undefined}>
                {!d.funded && <small><Button small style={{ marginTop: 8 }} onClick={() => askFunds(true)}>Show funding help</Button></small>}
              </Row>
              <Row state={checks === null ? 'busy' : problems ? 'warn' : 'done'} label="Compact server checks" tag={checks === null ? 'RUNNING' : problems ? `${problems} ISSUE${problems > 1 ? 'S' : ''}` : 'OK'}
                hint={problems ? [...issues.map((c) => `${c.name}: ${c.detail ?? ''} ${c.hint ?? ''}`), ...(rpcOk ? [] : ['Cannot reach any NEAR testnet RPC.'])].join(' · ') : undefined} />
            </Rows>
          </Card>
          {fresh && (
            <Callout kind="warn" title="Save your secret key now. It is shown only once.">
              <p style={{ margin: '4px 0 10px' }}>Anyone with this key controls the account. Keep it in a password manager.</p>
              <CopyField label="Secret key" value={fresh.secretKey} mask />
              <label className="cx-check" style={{ marginTop: 12 }}><input type="checkbox" checked={!!flags.savedKey} onChange={(e) => flag('savedKey', e.target.checked)} /><span>I saved the secret key somewhere safe</span></label>
            </Callout>
          )}
          <ErrorNote error={err} />
        </div>
      )}
    </PageFrame>
  );
}
