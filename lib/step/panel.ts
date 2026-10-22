// The review panel and the lenses each round reviews: pure helpers step, `forge job panel` and
// loadStepInput share.
import path from 'node:path';
import { lensAlwaysOnRework } from '../config.ts';
import { LENS_NAME, isLens, lensRepoAllowed, reviewFileName, splitLens } from '../lens.ts';
import type { MemberLens } from '../member-panel.ts';
import { inSpec } from '../glob.ts';
import type { Config, Job, PanelEntry, StepInput } from '../types.ts';
import { after } from './facts.ts';

const alwaysLenses = (config: Config) => config.review.panel.filter((p) => p.always).map((p) => p.name);

/**
 * The lenses this round reviews. A PR rework (`pr.state` OPEN) follows `review.onPrFeedback`:
 * `changed` still means the always-on lenses, and `full` reads the panel that RV9's
 * `forge job panel` recomputes from the diff. Step stays pure: the diff is read by that command.
 */
export function roundLenses(job: Pick<Job, 'reviewers' | 'pr'> & { repos?: Job['repos'] }, config: Config, rerun?: string[] | null): string[] {
  // job.reviewers is settable with --field, so a name that isn't a lens is dropped, never quoted, and
  // a qualified lens counts only while its repo is a reviewed member of the job.
  const base = (job.reviewers.length ? job.reviewers : alwaysLenses(config)).filter((l) => isLens(l) && lensRepoAllowed(job, l));
  // A rework panel (currentRerun) narrows a build-loop round; a PR rework keeps onPrFeedback's rule.
  if (job.pr?.state !== 'OPEN') return rerun?.length ? base.filter((l) => rerun.includes(l)) : base;
  if (config.review.onPrFeedback === 'none') return [];
  return config.review.onPrFeedback === 'full' ? base : alwaysLenses(config).filter((l) => LENS_NAME.test(l));
}

/**
 * This round's rework panel from the latest `panel` event of the round, when it postdates the
 * round's last verify and its `rerun` names only lenses of the full round panel; null means the
 * full panel. Every check fails toward more review: the event is in agent-reachable job state.
 */
export function currentRerun(x: Pick<StepInput, 'job' | 'config' | 'events'>): string[] | null {
  const j = x.job;
  if (j.round < 2 || x.config.review?.onRework !== 'narrow' || j.pr?.state === 'OPEN') return null;
  const lv = j.verifyRuns.filter((r) => r.round === j.round).at(-1);
  const ev = x.events.findLast((e) => e.type === 'panel' && e.round === j.round);
  if (!ev || !after(ev.ts, lv?.at)) return null;
  const rerun: unknown = ev.rerun;
  if (!Array.isArray(rerun) || !rerun.length || rerun.some((l) => typeof l !== 'string')) return null;
  const full = roundLenses(j, x.config);
  return rerun.every((l: string) => full.includes(l)) ? full.filter((l) => rerun.includes(l)) : null;
}

/** A lens's latest verdict before `round`, and the round it came from; null when it never had one. */
export function lastVerdict(verdicts: Job['verdicts'], lens: string, round: number): { verdict: string; round: number } | null {
  for (let r = round - 1; r >= 1; r--) {
    const v = verdicts[String(r)]?.[lens];
    if (typeof v === 'string') return { verdict: v, round: r };
  }
  return null;
}

/**
 * The rework panel for round N ≥ 2 under `review.onRework: narrow`, in panel order: `always` and
 * always-on-rework lenses (lensAlwaysOnRework: `security` unless it opts out), lenses whose latest verdict isn't PASS or that never had one, and lenses whose panel `paths` match
 * a file changed since the sha round N−1's review saw (`changedSince`, null when that sha is
 * unusable). Null, meaning the full panel, whenever narrowing isn't safe or wouldn't skip anything.
 */
export function reworkPanel(x: { job: Pick<Job, 'round' | 'verdicts' | 'pr' | 'kind'>; config: Config; lenses: string[]; changedSince: string[] | null; members: number }): { rerun: string[]; reasons: Record<string, string[]>; skipped: string[] } | null {
  const j = x.job;
  if (x.config.review?.onRework !== 'narrow' || j.round < 2 || j.pr?.state === 'OPEN' || j.kind === 'retro' || x.members > 0 || !x.changedSince) return null;
  const prev = j.verdicts[String(j.round - 1)];
  // No verdicts, or all PASS: a human sent the job back, so nothing says which lenses to trust.
  if (!prev || !Object.keys(prev).length || Object.values(prev).every((v) => v === 'PASS')) return null;
  const reasons: Record<string, string[]> = {};
  for (const lens of x.lenses) {
    const entry = x.config.review.panel.find((p) => p.name === lens);
    const why: string[] = [];
    if (entry?.always) why.push('always');
    else if (lensAlwaysOnRework(x.config, lens)) why.push('always on rework');
    const last = lastVerdict(j.verdicts, lens, j.round);
    if (!last) why.push('new this round');
    else if (last.verdict !== 'PASS') why.push(`changes requested in round ${last.round}`);
    const globs = Array.isArray(entry?.paths) ? entry.paths.filter((g): g is string => typeof g === 'string' && g !== '') : [];
    for (const g of globs) {
      const hit = x.changedSince.find((f) => inSpec(f, [g]));
      if (hit !== undefined) why.push(`paths ${g}: ${hit}`);
    }
    if (why.length) reasons[lens] = why;
  }
  const rerun = x.lenses.filter((l) => reasons[l]);
  if (!rerun.length || rerun.length === x.lenses.length) return null;
  return { rerun, reasons, skipped: x.lenses.filter((l) => !reasons[l]) };
}

/** Path-like tokens in a lens's `when` text; prose-only `when`s are left to the spec-writer's suggestion. */
export function whenTokens(when: string | undefined): string[] {
  return String(when ?? '')
    .split(/[,\s]+/)
    .map((t) => t.replace(/^["'`([]+/, '').replace(/["'`)\];:.,]+$/, ''))
    .filter((t) => t && (t.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(t)));
}

/** A review panel and why each lens is on it: `forge job panel`'s result, and SP3's lenses. */
export interface PanelChoice {
  lenses: string[];
  reasons: Record<string, string[]>;
}

/** One reviewed member for choosePanel: its usable panel entries and its changed files, repo-relative. */
export interface PanelMember {
  repo: string;
  lenses: MemberLens[];
  changed: string[];
}

/**
 * The review panel from recorded inputs, in panel order: `always` lenses, the spec's suggestions
 * that are in the panel, lenses whose `when` paths or `paths` cover an Approach path, lenses whose
 * `paths` match a changed file (skipped when `changed` is null, at spec time), then `carried`
 * lenses, which can only add, so a lens never drops within a build loop. A lens gets every reason
 * that applies, in that order. Names that aren't plain lens names are dropped wherever they come from.
 * `members` adds each reviewed member's own lenses as `<repo>:<name>` after the root's, matched
 * against Approach paths under `<repo>/` and the member's changed files; an entry subsumed by a root
 * lens adds its reasons to that lens instead. A carried qualified lens stays only while its repo is a member.
 */
export function choosePanel(x: { kind: Job['kind']; config: Config; suggested: string[]; approachPaths: string[]; changed: string[] | null; carried: string[]; members?: PanelMember[] }): PanelChoice {
  if (x.kind === 'retro') return { lenses: ['code', 'docs'], reasons: { code: ['retro'], docs: ['retro'] } };
  const panel = x.config.review.panel.filter((p) => LENS_NAME.test(p.name));
  const names = panel.map((p) => p.name);
  const members = x.members ?? [];
  const memberNames = members.map((m) => m.repo);
  const qualified = members.flatMap((m) => m.lenses.filter((l) => !l.subsumed).map((l) => l.lens));
  const suggested = new Set(x.suggested.filter((n) => (LENS_NAME.test(n) && names.includes(n)) || qualified.includes(n)));
  const ofMember = (n: string) => {
    const s = splitLens(n);
    return Boolean(s?.repo && memberNames.includes(s.repo));
  };
  const carried = [...new Set(x.carried.filter((n) => typeof n === 'string' && (LENS_NAME.test(n) || ofMember(n))))];
  // A member entry's Approach and diff reasons, with paths written `<repo>/<path>`.
  const memberWhy = (m: PanelMember, e: PanelEntry): string[] => {
    const why: string[] = [];
    const prefix = `${m.repo}/`;
    const globs = Array.isArray(e.paths) ? e.paths.filter((g): g is string => typeof g === 'string' && g !== '') : [];
    const tokens = e.pathsOnly === true ? [] : [...whenTokens(e.when), ...globs];
    const covered = tokens.length ? x.approachPaths.find((ap) => ap.startsWith(prefix) && inSpec(ap.slice(prefix.length), tokens)) : undefined;
    if (covered !== undefined) why.push(`approach ${covered}`);
    for (const g of x.changed ? globs : []) {
      const hits = m.changed.filter((f) => inSpec(f, [g]));
      if (hits.length) why.push(`paths ${g}: ${prefix}${hits[0]}${hits.length > 1 ? ` (+${hits.length - 1} more)` : ''}`);
    }
    return why;
  };
  const subsumed = new Map<string, string[]>();
  for (const m of members)
    for (const l of m.lenses)
      if (l.subsumed && names.includes(l.lens)) subsumed.set(l.lens, [...(subsumed.get(l.lens) ?? []), ...memberWhy(m, l.entry)]);
  // A Map, not an object: a digits-only lens name would sort first among an object's keys.
  const chosen = new Map<string, string[]>();
  for (const p of panel) {
    if (chosen.has(p.name)) continue;
    const why: string[] = [];
    // pathsOnly: a spec can't pull the lens in; only always, the diff or carry can.
    const pathsOnly = p.pathsOnly === true;
    if (p.always) why.push('always');
    if (suggested.has(p.name) && !pathsOnly) why.push('suggested');
    const globs = Array.isArray(p.paths) ? p.paths.filter((g): g is string => typeof g === 'string' && g !== '') : [];
    const tokens = pathsOnly ? [] : [...whenTokens(p.when), ...globs];
    const covered = tokens.length ? x.approachPaths.find((ap) => inSpec(ap, tokens)) : undefined;
    if (covered !== undefined) why.push(`approach ${covered}`);
    for (const g of x.changed ? globs : []) {
      const hits = (x.changed ?? []).filter((f) => inSpec(f, [g]));
      if (hits.length) why.push(`paths ${g}: ${hits[0]}${hits.length > 1 ? ` (+${hits.length - 1} more)` : ''}`);
    }
    for (const r of subsumed.get(p.name) ?? []) if (!why.includes(r)) why.push(r);
    if (carried.includes(p.name)) why.push('carried');
    if (why.length) chosen.set(p.name, why);
  }
  for (const m of members) {
    for (const l of m.lenses) {
      if (l.subsumed || chosen.has(l.lens)) continue;
      const why: string[] = [];
      if (l.entry.always) why.push('always');
      if (suggested.has(l.lens) && l.entry.pathsOnly !== true) why.push('suggested');
      why.push(...memberWhy(m, l.entry));
      if (carried.includes(l.lens)) why.push('carried');
      if (why.length) chosen.set(l.lens, why);
    }
  }
  for (const n of carried) if (!chosen.has(n) && !names.includes(n)) chosen.set(n, ['carried']);
  return { lenses: [...chosen.keys()], reasons: Object.fromEntries(chosen) };
}

/** SP3: always lenses, the suggested ones in the panel, and the ones whose `when` paths or `paths` the Approach names, in panel order. */
export function selectPanel(x: Pick<StepInput, 'job' | 'config' | 'spec'>): string[] {
  // Never carries: a revised spec re-records the panel from scratch.
  return choosePanel({ kind: x.job.kind, config: x.config, suggested: x.spec.suggested, approachPaths: x.spec.approachPaths, changed: null, carried: [] }).lenses;
}

/** The previous round's review files that asked for changes, sorted by lens; pure, so callers decide what exists. */
export function reworkReviewFiles(job: Job, previousReviewDir: string | null): string[] {
  if (job.round <= 1 || !previousReviewDir) return [];
  const prev = job.verdicts[String(job.round - 1)] ?? {};
  return Object.keys(prev)
    .filter((lens) => isLens(lens) && lensRepoAllowed(job, lens) && prev[lens] !== 'PASS')
    .sort()
    .map((lens) => path.join(previousReviewDir, reviewFileName(lens)));
}
