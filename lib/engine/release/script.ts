// The script release mechanism's engine side (docs/CONFIG.md "Release strategy"): the notes file's path,
// the plan's draft through the script's `--draft-notes`, the bump a recompute takes back from release.json,
// and the `pr-merged` check. The engine only ever spawns `node <script> …` for a script repo: every check
// on release branches, PRs and tags stays in the script. It imports only types from plan.ts.

import path from 'node:path';
import { paths } from '#core/paths.ts';
import { isReleaseScript } from '#core/config/release-strategy.ts';
import { run } from '#core/os/process.ts';
import { safeText } from '#core/text.ts';
import type { Config } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { commandEnv } from '../guard/command-env.ts';
import type { RepoKey } from '../project/repo-order.ts';
import type { ReleaseBump, ReleasePlan, ReleaseRepo, VersionBump } from './plan.ts';
import { type RepoInput, labelOf } from './steps.ts';

export const CHECK_TIMEOUT_MS = 120_000;
const DRAFT_TIMEOUT_MS = 60_000;
const STDOUT_MAX = 256 * 1024;
const REASONS_MAX = 5;
const REASON_MAX = 500;
const XYZ = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const BUMPS: readonly string[] = ['patch', 'minor', 'major'];
const INFERRED: readonly string[] = ['patch', 'minor'];

/** The notes file `forge release plan` drafts and the `start` step commits: `notes-root.md`, or `notes-<repo>.md` for a member. */
export function notesPath(root: string, repo: RepoKey): string {
  return path.join(paths(root).runtime, 'release', repo === null ? 'notes-root.md' : `notes-${repo}.md`);
}

const lastLine = (s: string): string => s.trim().split('\n').at(-1)?.trim() ?? '';
const isMap = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const validReasons = (v: unknown): v is string[] => Array.isArray(v) && v.length <= REASONS_MAX && v.every((r) => typeof r === 'string' && r.length <= REASON_MAX);

/** Why `b` is not a bump Forge may plan with, or null. */
function bumpProblem(b: Record<string, any>, from: string, to: string): string | null {
  if (typeof b[from] !== 'string' || !XYZ.test(b[from])) return `${from} is not X.Y.Z`;
  if (typeof b[to] !== 'string' || !XYZ.test(b[to])) return `${to} is not X.Y.Z`;
  if (!BUMPS.includes(b.bump)) return 'bump is not patch, minor or major';
  if (!INFERRED.includes(b.inferred)) return 'inferred is not patch or minor';
  if (!validReasons(b.reasons)) return `reasons is not a list of at most ${REASONS_MAX} strings of ${REASON_MAX} characters or fewer`;
  return null;
}

/**
 * Runs `node <script> --draft-notes [--bump X]` in the repo, under the command environment (the script never sees
 * credentials), and checks what it printed. Throws a ForgeError naming the repo when it fails or prints anything
 * but `{current, next, bump, inferred, reasons, since, draft}` with a draft that starts `## <next>`.
 */
export function draftBump(root: string, config: Config, input: RepoInput, override: VersionBump | null): { bump: ReleaseBump; draft: string } {
  const label = labelOf(input.repo);
  const script = input.strategy.script;
  if (!isReleaseScript(script)) throw new ForgeError(`${label}: release.script ${JSON.stringify(script ?? null)} is not a relative path inside the repo`);
  const r = run(process.execPath, [script, '--draft-notes', ...(override ? ['--bump', override] : [])], { cwd: input.dir, env: commandEnv(config), timeoutMs: DRAFT_TIMEOUT_MS, allowFail: true });
  const said = lastLine(r.stderr);
  const fail = (why: string) => new ForgeError(`${label}: ${script} --draft-notes ${why}${said ? `: ${safeText(said, 300)}` : ''}; nothing was written`);
  if (!r.ok) throw fail(r.timedOut ? `took longer than ${DRAFT_TIMEOUT_MS / 1000}s` : `exited ${r.status ?? 'abnormally'}`);
  if (r.stdout.length > STDOUT_MAX) throw fail(`printed more than ${STDOUT_MAX / 1024} KB`);
  let d: unknown;
  try {
    d = JSON.parse(r.stdout);
  } catch {
    throw fail('did not print one JSON object');
  }
  if (!isMap(d)) throw fail('did not print one JSON object');
  const problem =
    bumpProblem(d, 'current', 'next') ??
    (override && d.bump !== override ? `bump is ${JSON.stringify(d.bump)}, not the --bump ${override}` : null) ??
    (d.since !== null && typeof d.since !== 'string' ? 'since is neither a tag nor null' : null) ??
    (typeof d.draft !== 'string' || d.draft.split('\n', 1)[0].trimEnd() !== `## ${d.next}` ? `draft does not start with "## ${String(d.next)}"` : null);
  if (problem) throw fail(`printed the wrong shape (${safeText(problem, 200)})`);
  return { bump: { from: d.current, to: d.next, bump: d.bump, inferred: d.inferred, reasons: [...d.reasons], notes: notesPath(root, input.repo) }, draft: d.draft };
}

/**
 * The bump each script repo's recompute takes from release.json: checked as the draft's output is, with `notes`
 * replaced by Forge's own path, so a planted path never reaches argv. A file with no valid bump is refused.
 */
export function fileBumps(root: string, file: Pick<ReleasePlan, 'repos'>): (input: RepoInput) => ReleaseBump {
  return (input) => {
    const label = labelOf(input.repo);
    const entry: unknown = Array.isArray(file.repos) ? file.repos.find((r) => isMap(r) && r.label === label) : undefined;
    const b: unknown = isMap(entry) ? entry.bump : undefined;
    if (!isMap(b) || bumpProblem(b, 'from', 'to') !== null) throw new ForgeError(`release.json: ${label} has no valid release bump; re-run forge release plan`, 'failed', 'forge release plan');
    return { from: b.from, to: b.to, bump: b.bump, inferred: b.inferred, reasons: [...b.reasons], notes: notesPath(root, input.repo) };
  };
}

/**
 * The `pr-merged` check: `node <script> --check merged <to>` in the clone, with the caller's environment (it asks
 * gh). Its detail is the script's last stderr line without the `release: ` prefix.
 */
export function scriptCheck(repo: ReleaseRepo, config: Config, env: NodeJS.ProcessEnv): { ok: boolean; detail?: string } {
  const strategy = repo.repo === null ? config.release : config.repos.find((r) => r.name === repo.repo)?.release;
  const script = strategy?.script;
  const to = repo.bump?.to;
  if (!isReleaseScript(script) || typeof to !== 'string' || !XYZ.test(to)) return { ok: false, detail: 'no release script or version to check' };
  const r = run(process.execPath, [script, '--check', 'merged', to], { cwd: repo.dir, env, timeoutMs: CHECK_TIMEOUT_MS, allowFail: true });
  if (r.ok) return { ok: true };
  return { ok: false, detail: safeText(lastLine(r.stderr).replace(/^release: /, ''), 400) || `the check exited ${r.status ?? 'abnormally'}` };
}
