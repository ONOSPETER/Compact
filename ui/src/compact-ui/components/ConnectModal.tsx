import { useState } from 'react';
import { api } from '../api';
import { useCompact } from '../store';
import { Button, Chip, ErrorNote, Field, Modal } from './Kit';

export const shortId = (id: string) => `${id.slice(0, 6)}…${id.slice(-4)}`;

/** "Connect wallet": paste the deployer's secret key. The same key brings the unfinished work back. */
export function ConnectModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { session, refresh } = useCompact();
  const d = session?.deployer;
  const [switching, setSwitching] = useState(!d);
  const [key, setKey] = useState(''); const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<any>(null);
  const connect = async () => {
    setBusy(true); setErr(null);
    try { await api.importAccount(key.trim(), pass || undefined); setKey(''); await refresh(); onDone(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose} label="Connect wallet">
      <Chip>Testnet</Chip>
      {d && !switching ? (
        <>
          <h2>Welcome back</h2>
          <p>Connected as <b className="mono">{shortId(d.accountId)}</b>. Your unfinished work is waiting.</p>
          <div className="cx-wrapRow" style={{ marginTop: 16 }}><Button primary onClick={onDone}>Continue</Button><Button ghost onClick={() => setSwitching(true)}>Use a different key</Button></div>
        </>
      ) : (
        <>
          <h2>Connect your wallet</h2>
          <p>Paste the secret key of your NEAR <b>testnet</b> deployer account. Compact keeps it on this machine. Use the same key as before and your unfinished work comes back.</p>
          <Field label="Secret key" hint="Starts with ed25519:. Testnet keys only."><input className="cx-in mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" /></Field>
          <Field label="Passphrase to encrypt it (optional)"><input className="cx-in" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" /></Field>
          <ErrorNote error={err} />
          <div className="cx-wrapRow" style={{ marginTop: 14 }}><Button primary onClick={connect} disabled={busy || !key.trim()}>{busy ? 'Connecting…' : 'Connect'}</Button><Button ghost onClick={onDone}>No key yet? Start guided setup</Button></div>
        </>
      )}
    </Modal>
  );
}
