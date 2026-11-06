import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homePaths } from '../src/paths.mjs';
import { Keystore } from '../src/store/keystore.mjs';
import { StateStore, makeAppId } from '../src/store/state.mjs';
import { ConfigStore } from '../src/store/config.mjs';
import { Credentials } from '../src/store/credentials.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'compact-test-'));

test('keystore: plain and encrypted accounts, unlock, wrong passphrase, default handling', async () => {
  const paths = homePaths(tmp());
  const ks = new Keystore(paths);
  const a = await ks.add({});
  assert.equal(a.accountId.length, 64);
  assert.equal((fs.statSync(paths.keystore).mode & 0o777), 0o600);
  const b = await ks.add({ passphrase: 'correct horse', setDefault: false });
  assert.equal(await ks.getDefaultId(), a.accountId);
  assert.equal((await ks.list()).length, 2);
  const un = await ks.unlock(a.accountId);
  assert.equal(un.secret, a.secret);
  await assert.rejects(() => ks.unlock(b.accountId, async () => 'wrong'), (e) => e.code === 'E_BAD_PASSPHRASE');
  assert.equal((await ks.unlock(b.accountId, async () => 'correct horse')).secret, b.secret);
  await assert.rejects(() => ks.unlock(b.accountId), (e) => e.code === 'E_PASSPHRASE_REQUIRED');
  assert.ok(!fs.readFileSync(paths.keystore, 'utf8').includes(b.secret)); // encrypted at rest
  await assert.rejects(() => ks.importSecret(a.secret), (e) => e.code === 'E_ACCOUNT_EXISTS');
});

test('keystore: corrupt file is quarantined, never silently replaced', async () => {
  const paths = homePaths(tmp());
  fs.writeFileSync(paths.keystore, '{not json');
  await assert.rejects(() => new Keystore(paths).list(), (e) => e.code === 'E_KEYSTORE_CORRUPT');
  assert.ok(fs.readdirSync(paths.home).some((f) => f.includes('corrupt')));
});

test('state: upsert/resolve/remove, concurrent writers do not lose updates', async () => {
  const paths = homePaths(tmp());
  const st = new StateStore(paths);
  const id = makeAppId('My App', '/x');
  await st.upsert(id, { name: 'my-app', outDir: '/tmp/out/my-app' });
  await Promise.all(Array.from({ length: 12 }, (_, i) => st.upsert(id, (a) => ({ ...a, deployments: [...a.deployments, { n: i }] }))));
  assert.equal((await st.get(id)).deployments.length, 12);
  assert.equal((await st.resolve('my-app')).id, id);
  assert.equal((await st.resolve(undefined, '/tmp/out/my-app/portal/src')).id, id);
  await assert.rejects(() => st.resolve('nope'), (e) => e.code === 'E_UNKNOWN_APP');
  assert.equal(await st.remove(id), true);
  assert.equal((await st.list()).length, 0);
});

test('config: env override is not persisted; credentials resolve in priority order', async () => {
  const paths = homePaths(tmp());
  const cfg = new ConfigStore(paths);
  const c = await cfg.load({ COMPACT_RPC_URLS: 'https://a, https://b' });
  assert.deepEqual(c.rpcUrls, ['https://a', 'https://b']);
  await cfg.save({ setupComplete: true });
  const again = await cfg.load({});
  assert.equal(again.setupComplete, true);
  assert.ok(again.rpcUrls.length >= 2 && !again.rpcUrls.includes('https://a'));
  const cr = new Credentials(paths);
  assert.equal(await cr.githubToken({}), null);
  await cr.saveGithub({ token: 'ghp_file', user: 'me' });
  assert.equal((await cr.githubToken({})).source, 'file');
  assert.equal((await cr.githubToken({ GITHUB_TOKEN: 'ghp_env' })).source, 'env:GITHUB_TOKEN');
  assert.equal((await cr.githubToken({ GITHUB_TOKEN: 'x' }, 'ghp_flag')).source, 'flag');
});
