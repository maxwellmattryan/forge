// The files in `.forge/runtime/release/` (their paths, symlink refusal, and reading `release.json` and
// `state.json` as untrusted data, since an agent session can write them) and `forge release plan`'s write.

import fs from 'node:fs';
import path from 'node:path';
import { paths } from '#core/paths.ts';
import { validJobId } from '#core/job/requests.ts';
import type { Config } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { writeJsonAtomic, writeTextAtomic } from '#core/os/fs.ts';
import { assertSafeRef } from '#core/text.ts';
import { MANDATE_ID_SOURCE } from '#api/constants.ts';
import { type PlanOptions, type ReleasePlan, type ReleaseSelection, type ReleaseState, type ReleaseStep, RELEASE_FILE_VERSION, planRelease } from './plan.ts';
import { renderReleaseMd } from './render.ts';

const MANDATE_ID = new RegExp(MANDATE_ID_SOURCE);

export interface ReleaseFiles {
  dir: string;
  md: string;
  json: string;
  state: string;
  logs: string;
}

export function releaseFiles(root: string): ReleaseFiles {
  const dir = path.join(paths(root).runtime, 'release');
  return { dir, md: path.join(dir, 'release.md'), json: path.join(dir, 'release.json'), state: path.join(dir, 'state.json'), logs: path.join(dir, 'logs') };
}

/** Refuses when the release dir or one of the files Forge reads or writes in it is a symlink. */
export function assertNoSymlinks(files: ReleaseFiles, extra: string[] = []): void {
  for (const p of [files.dir, files.md, files.json, files.state, files.logs, ...extra]) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) throw new ForgeError(`${p} is a symlink; forge release reads and writes only real files there. Remove it and plan again`);
  }
}

/** state.json, or null when there is none. A file Forge can't read as its own is refused. */
export function readState(files: ReleaseFiles): ReleaseState | null {
  let text: string;
  try {
    text = fs.readFileSync(files.state, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ForgeError(`cannot read ${files.state}: ${(e as Error).message}`);
  }
  let s: any;
  try {
    s = JSON.parse(text);
  } catch {
    throw new ForgeError(`${files.state} is not valid JSON; re-run forge release plan --force, which discards its checkpoints`);
  }
  if (!s || s.version !== RELEASE_FILE_VERSION || typeof s.planHash !== 'string' || !s.steps || typeof s.steps !== 'object' || Array.isArray(s.steps))
    throw new ForgeError(`${files.state} is not a version ${RELEASE_FILE_VERSION} release state; re-run forge release plan --force, which discards its checkpoints`);
  return s as ReleaseState;
}

/** release.json, or null when there is none; an unreadable or older file is refused with the fix. */
export function readPlanFile(files: ReleaseFiles): ReleasePlan | null {
  let text: string;
  try {
    text = fs.readFileSync(files.json, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ForgeError(`cannot read ${files.json}: ${(e as Error).message}`);
  }
  let p: any;
  try {
    p = JSON.parse(text);
  } catch {
    throw new ForgeError(`${files.json} is not valid JSON; re-run forge release plan`);
  }
  if (!p || p.version !== RELEASE_FILE_VERSION) throw new ForgeError(`${files.json} is not a version ${RELEASE_FILE_VERSION} release plan; re-run forge release plan`);
  const sel = p.selection;
  const okSel = sel && ((sel.kind === 'job' && typeof sel.job === 'string') || (sel.kind === 'since' && typeof sel.tag === 'string') || sel.kind === 'all');
  if (!okSel || typeof p.hash !== 'string' || !Array.isArray(p.repos)) throw new ForgeError(`${files.json} is not a release plan Forge wrote; re-run forge release plan`);
  // Anyone who can write .forge/runtime/ can plant this file, and its selection reaches git argv and
  // a path join before any hash is compared, so it passes the same rules as the CLI flags.
  if (sel.kind === 'since') {
    try {
      assertSafeRef(sel.tag, 'selection.tag');
    } catch (e) {
      throw new ForgeError(`${files.json}: ${(e as Error).message.replace('safe branch name', 'safe tag name')}; re-run forge release plan`);
    }
    // The mandate names the audit events an approval is matched against.
    if (sel.mandate !== undefined && !(typeof sel.mandate === 'string' && MANDATE_ID.test(sel.mandate) && sel.mandate !== 'none'))
      throw new ForgeError(`${files.json}: selection.mandate ${JSON.stringify(String(sel.mandate).slice(0, 80))} is not a mandate id; re-run forge release plan`);
  }
  if (sel.kind === 'job' && !validJobId(sel.job)) throw new ForgeError(`${files.json}: selection.job ${JSON.stringify(sel.job.slice(0, 80))} is not a valid job id; re-run forge release plan`);
  return p as ReleasePlan;
}

/** Every step of the plan, in order. */
export const planSteps = (plan: Pick<ReleasePlan, 'repos'>): ReleaseStep[] => plan.repos.flatMap((r) => r.steps);

export const doneCount = (plan: Pick<ReleasePlan, 'repos'>, state: ReleaseState | null): number => planSteps(plan).filter((s) => state?.steps[s.id]?.status === 'done').length;

/** Whether every step of the plan is done in `state`. */
export const finished = (plan: Pick<ReleasePlan, 'repos'>, state: ReleaseState | null): boolean => planSteps(plan).every((s) => state?.steps[s.id]?.status === 'done');

/**
 * `forge release plan`: plans, guards an unfinished run of another plan, and writes release.md and
 * release.json (and drops state.json on `force`).
 */
export function writeReleasePlan(root: string, config: Config, selection: ReleaseSelection, opts: PlanOptions & { force?: boolean; log?: (line: string) => void } = {}) {
  const files = releaseFiles(root);
  assertNoSymlinks(files);
  const plan = planRelease(root, config, selection, opts);
  const log = opts.log ?? ((l: string) => process.stderr.write(l + '\n'));
  let state: ReleaseState | null;
  try {
    state = readState(files);
  } catch (e) {
    if (!opts.force) throw e;
    // readState's own error says to use --force, so --force must get past an unreadable file.
    log(`forge release plan: --force discarded an unreadable ${files.state}`);
    fs.rmSync(files.state, { force: true });
    state = null;
  }
  if (state && state.planHash !== plan.hash) {
    // finishedAt is set only once every step is done; the counts come from the plan the state belongs to.
    if (!state.finishedAt) {
      const old = (() => {
        try {
          return readPlanFile(files);
        } catch {
          return null;
        }
      })();
      const steps = old && old.hash === state.planHash ? planSteps(old).map((s) => s.id) : Object.keys(state.steps);
      const done = steps.filter((id) => state.steps[id]?.status === 'done').length;
      if (!opts.force) throw new ForgeError(`a release run is in progress (${done}/${steps.length} steps done); finish it with forge release run, or re-plan with --force, which discards its checkpoints`);
      log(`forge release plan: --force discarded the checkpoints of plan ${state.planHash.slice(0, 12)} (${done}/${steps.length} steps done)`);
    }
    fs.rmSync(files.state, { force: true });
  }
  fs.mkdirSync(files.dir, { recursive: true });
  assertNoSymlinks(files);
  writeJsonAtomic(files.json, plan);
  writeTextAtomic(files.md, renderReleaseMd(plan, config));
  return { plan: files.md, steps: files.json, hash: plan.hash.slice(0, 12), order: plan.order, total: planSteps(plan).length, skipped: plan.skipped.map(({ label, reason }) => ({ repo: label, reason })) };
}
