import { api } from '../api';
import { useCompact } from '../store';
import { validUrl } from '../flow';
import { PageFrame } from '../components/Shell';
import { Button, Card, Ext, Pair, Row, Rows } from '../components/Kit';

export function Vercel() {
  const { app, flags, flag, url, setUrl } = useCompact();
  const env = app?.env ?? { required: ['COMPACT_KEYS_B64'], storage: [], app: [] };
  const copy = (t: string) => navigator.clipboard.writeText(t).catch(() => {});
  const t = (n: number) => ({ state: (flags[`vercel${n}`] ? 'done' : 'todo') as 'done' | 'todo', tag: 'You', onToggle: (v: boolean) => flag(`vercel${n}`, v) });
  const gh = app?.github;
  return (
    <PageFrame title="Deploy on" em="Vercel." canNext={[1, 2, 3, 4, 5].every((n) => flags[`vercel${n}`]) && validUrl(url)}
      lead="Everything Vercel needs is below. Tick each task as you go; Compact checks the result in the next step."
      help={{ title: 'Vercel walkthroughs', links: [{ label: 'Vercel docs: import a project', href: 'https://vercel.com/docs/getting-started-with-vercel/import' }, { label: 'Vercel docs: environment variables', href: 'https://vercel.com/docs/projects/environment-variables' }, { label: 'Vercel Marketplace (Upstash Redis)', href: 'https://vercel.com/marketplace' }, { label: 'If the page asks you to sign in', href: 'https://vercel.com/docs/security/deployment-protection' }] }}>
      <Pair>
        <Card cap="Your tasks">
          <Rows>
            <Row {...t(1)} label={<>Import {gh ? <b>{gh.owner}/{gh.repo}</b> : 'the repo'} at <Ext href="https://vercel.com/new">vercel.com/new</Ext></>} />
            <Row {...t(2)} label="Framework preset: Vite · Output: dist" />
            <Row {...t(3)} label="Add the Upstash Redis integration" hint="Project → Storage → Marketplace → Upstash Redis" />
            <Row {...t(4)} label="Add the variables on the right" />
            <Row {...t(5)} label="Deploy, then paste your .vercel.app URL" />
          </Rows>
        </Card>
        <Card cap="Environment variables">
          <Rows>
            <Row state="todo" label={<span className="mono">COMPACT_KEYS_B64</span>} tag="Step 05 · secret">
              <small style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <Button small ghost onClick={() => copy('COMPACT_KEYS_B64')}>Name</Button>
                <Button small onClick={async () => { if (app) copy((await api.appKeys(app.id)).COMPACT_KEYS_B64); }} disabled={!app}>Copy value</Button>
              </small>
            </Row>
            {env.storage.map((n) => <Row key={n} state="todo" label={<span className="mono">{n}</span>} tag="Auto from Upstash"><small style={{ marginTop: 8 }}><Button small ghost onClick={() => copy(n)}>Copy</Button></small></Row>)}
            {env.app.map((n) => <Row key={n} state="todo" label={<span className="mono">{n}</span>} tag="Your app · secret"><small style={{ marginTop: 8 }}><Button small ghost onClick={() => copy(n)}>Copy name</Button></small></Row>)}
          </Rows>
          <input className="cx-in mono" style={{ marginTop: 14 }} aria-label="Your Vercel URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-app.vercel.app" />
          {url && !validUrl(url) && <p className="cx-note" style={{ color: 'var(--bad)' }}>Use the https:// address that Vercel shows.</p>}
        </Card>
      </Pair>
    </PageFrame>
  );
}
