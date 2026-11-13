import type { AppDetail, Plan, Session } from './api';

/** Nine milestones on the left rail, shown on six pages (some pages carry two milestones). */
export type RailId = 'wallet' | 'github' | 'app' | 'review' | 'keys' | 'anchor' | 'push' | 'vercel' | 'verify';
export const RAIL: { id: RailId; label: string; page: number }[] = [
  { id: 'wallet', label: 'Wallet', page: 0 }, { id: 'github', label: 'GitHub', page: 1 }, { id: 'app', label: 'App', page: 1 },
  { id: 'review', label: 'Review', page: 2 }, { id: 'keys', label: 'Keys', page: 2 }, { id: 'anchor', label: 'Anchor', page: 3 },
  { id: 'push', label: 'Push', page: 3 }, { id: 'vercel', label: 'Vercel', page: 4 }, { id: 'verify', label: 'Verify', page: 5 },
];
export const PAGE_COUNT = 6;
export const PAGE_LABEL = ['01', '02-03', '04-05', '06-07', '08', '09'];

export type Progress = { session: Session | null; flags: Record<string, boolean>; plan: Plan | null; app: AppDetail | null; url: string };
export const validUrl = (u: string) => /^https:\/\/[^/\s]+\.[^/\s]+/.test(u.trim());

/** A milestone is done when the real state says so (account funded, app anchored...), or the user ticked it. */
export function railDone(id: RailId, p: Progress): boolean {
  const { session: s, flags: f, plan, app, url } = p;
  switch (id) {
    case 'wallet': return !!s?.deployer?.funded && (!f.created || !!f.savedKey);
    case 'github': return !!s?.github;
    case 'app': return !!plan || !!app;
    case 'review': return !!app;
    case 'keys': return !!app && !!f.keyBackup;
    case 'anchor': return !!app && app.deployments > 0;
    case 'push': return !!app?.github;
    case 'vercel': return [1, 2, 3, 4, 5].every((i) => f[`vercel${i}`]) && validUrl(url);
    case 'verify': return !!f.verified && !!f.linked;
  }
}
export const pageDone = (page: number, p: Progress) => RAIL.filter((r) => r.page === page).every((r) => railDone(r.id, p));
/** You can open any finished page, plus the first unfinished one. */
export function maxReachable(p: Progress): number {
  const i = Array.from({ length: PAGE_COUNT }, (_, n) => n).find((n) => !pageDone(n, p));
  return i === undefined ? PAGE_COUNT - 1 : i;
}
