import fsp from 'node:fs/promises';
import path from 'node:path';
import { CompactError, EXIT } from '../errors.mjs';
import { exists, isEmptyDir, swapDir } from '../util/fs.mjs';
import { makeAppId, slugify } from '../store/state.mjs';
import { resolveSource, analyzeDirectory, loadProjectConfig } from './project.mjs';
import { buildOutput } from './build.mjs';

export async function loadPQ(ctx) {
  if (ctx.pq) return ctx.pq;
  try {
    return (await import('../../templates/runtime/pq.mjs')).createPQ();
  } catch (e) {
    throw new CompactError('E_PQ_MISSING', 'The post-quantum library (@noble/post-quantum) could not be loaded.', {
      hint: 'Run: npm install  (inside the compact-cli folder), or reinstall @compact/cli.', cause: e, exitCode: EXIT.ENV,
    });
  }
}

/** Analyze only: resolves the source and returns the plan. Writes nothing to the project. */
export async function analyzeProject(ctx, input, opts = {}) {
  const src = await ctx.ui.task(`Reading ${input}`, async (t) => resolveSource(ctx, input, { onProgress: (n, m) => t.update(`Downloading files ${n}/${m}`) }));
  const config = await loadProjectConfig(src.dir, { critical: opts.critical, portal: opts.portal, entry: opts.entry, port: opts.port });
  const analysis = await ctx.ui.task('Analysing code', async () => analyzeDirectory(src.dir, config));
  return { ...analysis, src, config };
}

export function assertPlanOk(plan, { allowErrors = false } = {}) {
  if (plan.errors.length && !allowErrors) {
    throw new CompactError('E_PLAN_INVALID', `${plan.errors.length} problem(s) must be fixed before Compact can split this app.`, {
      hint: 'Fix them, mark files with // @compact-critical or // @compact-portal, or pass --critical/--portal globs.',
      details: plan.errors.map((e) => `${e.file ?? '(project)'}: ${e.message}`), exitCode: EXIT.VALIDATION,
    });
  }
}

/** Analyze, then write <out>/{portal,critical,compact}. Atomic: the output folder appears fully built or not at all. */
export async function transformProject(ctx, input, opts = {}) {
  const pq = await loadPQ(ctx);
  const { plan, pkg, files, dir, src, config } = await analyzeProject(ctx, input, opts);
  assertPlanOk(plan, opts);

  const name = slugify(opts.name || pkg.name || src.name);
  const outDir = path.resolve(ctx.cwd, opts.out || `${name}-compact`);
  if (await exists(outDir) && !(await isEmptyDir(outDir)) && !opts.force) {
    throw new CompactError('E_OUT_EXISTS', `${outDir} already exists and is not empty.`, { hint: 'Choose another --out, or pass --force to replace it (keys will be regenerated!).', exitCode: EXIT.USAGE });
  }
  const sourceKey = src.source.type === 'github' ? `${src.source.owner}/${src.source.repo}${src.source.subdir ? `/${src.source.subdir}` : ''}` : src.source.path;
  const appId = makeAppId(name, sourceKey);
  const staging = `${outDir}.staging-${process.pid}`;
  await fsp.rm(staging, { recursive: true, force: true });

  let built;
  try {
    built = await ctx.ui.task('Building portal / critical / compact', async () =>
      buildOutput({ srcDir: dir, files, plan, pkg, staging, appId, name, source: src.source, pq }));
    await swapDir(staging, outDir);
  } catch (e) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw e;
  }

  const app = await ctx.state.upsert(appId, (prev) => ({
    ...prev, name, source: src.source, outDir, mode: plan.mode, entry: plan.entry ?? null, port: plan.port ?? null,
    manifestSha256: built.connect.manifestSha256, transformedAt: new Date().toISOString(), config,
  }));
  return { app, plan, outDir, manifest: built.manifest, connect: built.connect, notes: built.notes, keyFile: path.join(outDir, built.keyFile), skipped: src.skipped };
}
