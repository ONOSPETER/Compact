import path from 'node:path';
import { CompactError, EXIT } from '../errors.mjs';
import { writeJson } from '../util/fs.mjs';
import { collectPublishFiles, scanForSecrets, pushFiles } from '../github/push.mjs';
import { slugify } from '../store/state.mjs';
import { loadApp, readProject } from './project.mjs';

/** Publish portal/ to GitHub. Refuses if anything in it looks like a secret. */
export async function pushPortal(ctx, ref, { owner, repo, branch, isPrivate = true, message, allowSecrets = false, dryRun = false, token } = {}) {
  const { ui } = ctx;
  const app = await loadApp(ctx, ref);
  const { d, connect } = await readProject(app);
  const files = await ui.task('Collecting portal files', async () => collectPublishFiles(d.portal));
  if (!files.length) throw new CompactError('E_PORTAL_EMPTY', 'portal/ has no files to publish.');

  const findings = scanForSecrets(files);
  if (findings.length && !allowSecrets) {
    throw new CompactError('E_SECRETS_IN_PORTAL', 'Something that looks like a secret is in portal/, so nothing was pushed.', {
      hint: 'Remove it (anything in the portal is public). If it is a false positive, re-run with --allow-secrets.',
      details: findings.map((f) => `${f.file}: ${f.label}`), exitCode: EXIT.VALIDATION,
    });
  }
  const local = /localhost|127\.0\.0\.1/.test(connect.endpoint ?? '');
  if (local) ui.warn(`The portal still points at ${connect.endpoint}. Deploy the runner, then run: compact deploy --endpoint <https url> before pushing.`);
  if (dryRun) return { app, dryRun: true, files: files.map((f) => f.path), endpointIsLocal: local };

  const gh = await ctx.github({ token });
  const prev = app.github;
  const target = {
    owner: owner ?? prev?.owner, repo: repo ?? prev?.repo ?? `${slugify(app.name)}-portal`, branch: branch ?? prev?.branch ?? 'main',
  };
  const res = await ui.task(`Pushing ${files.length} files to GitHub`, async (t) =>
    pushFiles(gh, { ...target, files, isPrivate, message: message ?? `Compact portal for ${app.name}`, onProgress: (n, m) => t.update(`Uploading files ${n}/${m}`) }));
  const record = { owner: res.owner, repo: res.repo, branch: res.branch, commitSha: res.commitSha, url: res.url, private: res.private ?? isPrivate, at: new Date().toISOString(), unchanged: res.unchanged };
  await ctx.state.upsert(app.id, (a) => ({ ...a, github: record, pushes: [...(a.pushes ?? []), record] }));
  await writeJson(path.join(d.compact, 'receipts', `${record.at.replace(/[:.]/g, '-')}-push.json`), record).catch(() => {});
  return { app, ...record, created: res.created, endpointIsLocal: local };
}
