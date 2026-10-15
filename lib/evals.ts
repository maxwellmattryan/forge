// Forge evaluation. An eval task is a request plus a hidden acceptance check. A run executes
// every selected task through the normal pipeline (eval mode: no tracker, no PR, no human gates),
// then grades each job. Runs are stamped with the Forge version and a hash of the repo's
// Forge configuration, so two runs can be compared to tell whether a change helped.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_TEST_PATTERN } from './integrity.ts';
import { createJob, loadJob, logEvent, setJob, jobDir } from './jobs.ts';
import { paths, exists, PLUGIN_ROOT } from './paths.ts';
import { createWorktree } from './worktree.ts';
import { ForgeError, assertSafeRef, fill, now, readJson, readText, run, slugify, tail, withLock, writeJsonAtomic } from './util.ts';
import { repoSlug } from './pr.ts';
import { firstVerifyRun } from './stats.ts';
import * as yaml from './yaml.ts';
import type { Config, EvalCompare, EvalResult, EvalRun, EvalSummary, EvalTask, Job } from './types.ts';

/** An eval task as loadTask reads it: the served EvalTask plus its directory and request text. */
export type LoadedTask = EvalTask & { dir: string; request: string };

export function evalsDir(root: string): string {
  return path.join(paths(root).dir, 'evals');
}

function runsDir(root: string): string {
  return path.join(evalsDir(root), 'runs');
}

export function listTasks(root: string): LoadedTask[] {
  const dir = evalsDir(root);
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'runs' && exists(path.join(dir, d.name, 'task.yml')))
    .map((d) => loadTask(root, d.name));
}

export function loadTask(root: string, name: string): LoadedTask {
  const dir = path.join(evalsDir(root), name);
  const file = path.join(dir, 'task.yml');
  if (!exists(file)) throw new ForgeError(`no eval task "${name}"`);
  const t = yaml.parse(readText(file)) ?? {};
  if (!t.request) throw new ForgeError(`${file} needs a "request"`);
  return {
    name,
    dir,
    title: t.title ?? name,
    request: t.request,
    base: t.base ?? null,
    tags: t.tags ?? [],
    check: { patch: t.check?.patch ?? null, files: t.check?.files ?? null, command: t.check?.command ?? null },
    rubric: t.rubric ?? (exists(path.join(dir, 'rubric.md')) ? 'rubric.md' : null),
    reference: t.reference ?? (exists(path.join(dir, 'reference.patch')) ? 'reference.patch' : null),
    source: t.source ?? null,
  };
}

export function forgeVersion(): string {
  return readJson(path.join(PLUGIN_ROOT, 'package.json'), { version: '0.0.0' }).version;
}

/**
 * Captures everything repo-side that shapes Forge behaviour, so a retro or config change
 * shows up as a different hash between two eval runs.
 */
export function configHash(root: string, config: Config): string {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(config));
  const p = paths(root);
  for (const dir of [p.reviewers, p.notes]) {
    if (!exists(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) h.update(f).update(readText(path.join(dir, f)));
  }
  return h.digest('hex').slice(0, 10);
}

/**
 * Turns a merged PR into a replay eval: start from its base commit, ask for what the PR did,
 * and use the tests it added as the hidden check. Works for any repo whose PRs carry tests.
 */
export function mineFromPr(
  root: string,
  config: Config,
  pr: number,
  opts: { name?: string; testPattern?: string } = {},
): { name: string; dir: string; hasTests: boolean; hasReference: boolean } {
  const slug = repoSlug(root, config);
  // gh output: raw input.
  const info: any = JSON.parse(
    run('gh', ['pr', 'view', String(pr), '-R', slug, '--json', 'number,title,body,state,baseRefOid,mergeCommit,closingIssuesReferences,url'], { cwd: root }).stdout,
  );
  if (info.state !== 'MERGED') throw new ForgeError(`PR #${pr} is not merged`);
  run('git', ['fetch', config.git.remote, info.baseRefOid, info.mergeCommit?.oid ?? ''].filter(Boolean), { cwd: root, allowFail: true });
  const local = info.mergeCommit?.oid ? run('git', ['diff', `${info.baseRefOid}...${info.mergeCommit.oid}`], { cwd: root, allowFail: true }) : null;
  const diff = local?.ok && local.stdout ? local.stdout : run('gh', ['pr', 'diff', String(pr), '-R', slug], { cwd: root }).stdout;
  const testRe = new RegExp(opts.testPattern ?? config.evals?.testPattern ?? DEFAULT_TEST_PATTERN);
  const { tests, rest } = splitDiff(diff, testRe);
  const name = opts.name ?? `pr-${info.number}-${slugify(info.title, 4)}`;
  const dir = path.join(evalsDir(root), name);
  if (exists(dir)) throw new ForgeError(`eval task ${name} already exists`);
  fs.mkdirSync(path.join(dir, 'check'), { recursive: true });
  const issues = (info.closingIssuesReferences ?? []).map((i: any) => i.number);
  let request = `${info.title}\n\n${(info.body ?? '').replace(/<!--[\s\S]*?-->/g, '').trim()}`;
  for (const n of issues) {
    const issue = run('gh', ['issue', 'view', String(n), '-R', slug, '--json', 'title,body'], { cwd: root, allowFail: true });
    if (issue.ok) {
      const i = JSON.parse(issue.stdout);
      request += `\n\n## Issue #${n}: ${i.title}\n\n${(i.body ?? '').trim()}`;
    }
  }
  const task = {
    title: info.title,
    request: request.trim() + '\n',
    base: info.baseRefOid,
    tags: ['replay'],
    check: tests ? { patch: 'check/tests.patch', command: null } : { patch: null, command: null },
    source: { pr: info.number, url: info.url, mergeCommit: info.mergeCommit?.oid ?? null },
  };
  if (tests) fs.writeFileSync(path.join(dir, 'check', 'tests.patch'), tests);
  if (rest) fs.writeFileSync(path.join(dir, 'reference.patch'), rest);
  fs.writeFileSync(path.join(dir, 'task.yml'), yaml.stringify(task));
  return { name, dir, hasTests: Boolean(tests), hasReference: Boolean(rest) };
}

function splitDiff(diff: string, testRe: RegExp): { tests: string; rest: string } {
  const chunks = diff.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git'));
  const tests: string[] = [];
  const rest: string[] = [];
  for (const c of chunks) {
    const file = c.match(/^diff --git a\/(\S+) b\/(\S+)/)?.[2] ?? '';
    (testRe.test(file) ? tests : rest).push(c);
  }
  return { tests: tests.join(''), rest: rest.join('') };
}

/** The record has no summary yet: listRuns computes it until the run is done. */
export function startRun(root: string, config: Config, opts: { tasks?: string[]; tags?: string[]; label?: string }): Omit<EvalRun, 'summary'> {
  let tasks = listTasks(root);
  if (opts.tasks?.length) tasks = tasks.filter((t) => opts.tasks?.includes(t.name));
  if (opts.tags?.length) tasks = tasks.filter((t) => t.tags.some((g) => opts.tags?.includes(g)));
  if (!tasks.length) throw new ForgeError('no eval tasks selected (add some under .forge/evals/ or run `forge eval mine --pr <n>`)');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const runId = `${stamp}${opts.label ? `-${slugify(opts.label, 3)}` : ''}`;
  const record: Omit<EvalRun, 'summary'> = {
    schemaVersion: 1,
    id: runId,
    label: opts.label ?? null,
    forgeVersion: forgeVersion(),
    configHash: configHash(root, config),
    models: config.runtime.models,
    startedAt: now(),
    finishedAt: null,
    status: 'running',
    tasks: [],
  };
  for (const t of tasks) {
    const job = createJob(root, config, {
      title: `[eval] ${t.title}`,
      body: t.request,
      kind: 'eval',
      slug: `eval-${t.name}`,
      branch: `forge-eval/${runId}/${t.name}`,
    });
    setJob(root, job.id, { fields: { eval: { run: runId, task: t.name } } });
    const wt = createWorktree(root, config, job.id, { from: t.base ?? undefined, sparseExclude: ['.forge/evals'], isolate: true });
    record.tasks.push({ task: t.name, job: job.id, worktreeOk: wt.ok !== false, result: null });
  }
  writeJsonAtomic(path.join(runsDir(root), `${runId}.json`), record);
  return record;
}

const NOT_APPLIED = 'hidden check did not apply cleanly';

type PatchResult = { ok: true; replaced: string[] } | { ok: false; reason: string; tail: string | null };

function notApplied(stderr: string): PatchResult {
  const last = tail(stderr, 5).trim();
  return { ok: false, reason: last ? `${NOT_APPLIED}: ${last}` : NOT_APPLIED, tail: tail(stderr, 20) };
}

/**
 * Applies a task's hidden patch to the stashed clone. A builder that wrote its own copy of a file
 * the patch touches would make a 3-way apply conflict, grading a merge conflict instead of the
 * code, so the candidate's versions of exactly those files go back to the base first.
 * The clone is the builder's: every path comes from git and goes back to git as a literal
 * pathspec after `--`, and git does every file write, so its own refusal of `..` paths and paths
 * beyond a symlink keeps grading inside the clone.
 */
function applyHiddenPatch(wt: string, job: Job, task: LoadedTask, patch: string): PatchResult {
  // An inherited GIT_DIR or GIT_INDEX_FILE (Forge run from a git hook) would point git elsewhere.
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  const git = (args: string[], extraEnv: NodeJS.ProcessEnv = env) => run('git', args, { cwd: wt, env: extraEnv, allowFail: true });
  const lines = (out: string) => out.split('\0').filter(Boolean);

  const ref = task.base ?? job.base;
  let base: string | null = null;
  try {
    const safe = assertSafeRef(ref, 'eval base');
    const res = git(['rev-parse', '--verify', '--quiet', `${safe}^{commit}`]);
    if (res.ok) base = res.stdout.trim();
  } catch {
    // An unsafe ref fails the check below rather than aborting the grade.
  }
  if (!base) return { ok: false, reason: `eval base ${ref} not found in the eval checkout`, tail: null };

  // Applying to the base in a scratch index lets git parse the patch (renames, quoting, binary,
  // created and deleted files) and proves the patch fits its own base before the worktree changes.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-grade-'));
  let touched: string[];
  try {
    const idx = { ...env, GIT_INDEX_FILE: path.join(tmp, 'index') };
    const read = git(['read-tree', base], idx);
    if (!read.ok) return notApplied(read.stderr);
    const applied = git(['apply', '--cached', '--whitespace=nowarn', patch], idx);
    if (!applied.ok) return notApplied(applied.stderr);
    const listed = git(['diff', '--cached', '--no-ext-diff', '--no-renames', '--name-only', '-z', base], idx);
    if (!listed.ok) return notApplied(listed.stderr);
    touched = lines(listed.stdout);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Without --literal-pathspecs a patch path such as `test/[ab].txt` is a glob over other files.
  const lit = ['--literal-pathspecs'];
  let changed: string[] = [];
  if (touched.length) {
    const diff = git([...lit, 'diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', base, 'HEAD', '--', ...touched]);
    if (!diff.ok) return notApplied(diff.stderr);
    changed = lines(diff.stdout).sort();
  }
  if (changed.length) {
    const tree = git([...lit, 'ls-tree', '-r', '-z', '--name-only', base, '--', ...changed]);
    if (!tree.ok) return notApplied(tree.stderr);
    const inBase = new Set(lines(tree.stdout));
    const restore = changed.filter((p) => inBase.has(p));
    const remove = changed.filter((p) => !inBase.has(p));
    if (restore.length) {
      const res = git([...lit, 'checkout', base, '--', ...restore]);
      if (!res.ok) return notApplied(res.stderr);
    }
    if (remove.length) {
      const res = git([...lit, 'rm', '-q', '-f', '--ignore-unmatch', '--', ...remove]);
      if (!res.ok) return notApplied(res.stderr);
    }
  }
  const res = git(['apply', '--whitespace=nowarn', patch]);
  if (!res.ok) return notApplied(res.stderr);
  return { ok: true, replaced: changed };
}

/**
 * Applies the hidden check on top of the job's final commit and records the job's Forge metrics.
 */
export function gradeJob(root: string, config: Config, jobId: string): EvalResult {
  const job = loadJob(root, jobId);
  const meta = job.eval;
  if (!meta) throw new ForgeError(`job ${jobId} is not an eval job`);
  const task = loadTask(root, meta.task);
  const wt = job.worktree;
  if (!wt || !exists(wt)) throw new ForgeError(`eval job ${jobId} has no worktree`);
  const check: EvalResult['check'] = { ran: false, pass: null, tail: null };
  const cmd = task.check.command ?? config.commands.test;
  if (task.check.patch || task.check.files) {
    run('git', ['stash', '--include-untracked'], { cwd: wt, allowFail: true });
    let applied = true;
    if (task.check.patch) {
      const res = applyHiddenPatch(wt, job, task, path.join(task.dir, task.check.patch));
      // `in` narrows here even under the tests' non-strict tsconfig, where `res.ok` does not.
      if ('replaced' in res) {
        check.replaced = res.replaced;
      } else {
        applied = false;
        check.tail = res.tail;
        check.reason = res.reason;
      }
    }
    if (task.check.files) fs.cpSync(path.join(task.dir, task.check.files), wt, { recursive: true });
    if (applied && cmd) {
      const res = run(process.env.SHELL || '/bin/sh', ['-lc', fill(cmd, { job: jobId, port: job.port ?? '', worktree: wt, args: '' })], { cwd: wt, allowFail: true });
      check.ran = true;
      check.pass = res.ok;
      check.tail = tail(`${res.stdout}\n${res.stderr}`, 30);
    } else if (!applied) {
      check.ran = true;
      check.pass = false;
    }
    run('git', ['reset', '--hard'], { cwd: wt, allowFail: true });
    run('git', ['clean', '-fd'], { cwd: wt, allowFail: true });
  }
  const judgeText = readText(path.join(jobDir(root, jobId), 'eval-judge.md'));
  const score = judgeText.match(/^\s*SCORE:\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+)/im);
  const rounds = Object.keys(job.verdicts).map(Number);
  const result: EvalResult = {
    check,
    judge: score ? { score: Number(score[1]), outOf: Number(score[2]) } : null,
    decision: job.decision,
    rounds: rounds.length ? Math.max(...rounds) : 0,
    firstPass: rounds.length ? Object.values(job.verdicts[Math.min(...rounds)] ?? {}).every((v) => v === 'PASS') : null,
    verifyFirstPass: firstVerifyRun(job),
    tokens: job.usage.totalTokens,
    estCostUsd: job.usage.estCostUsd,
    minutes: job.createdAt ? Math.round((Date.now() - Date.parse(job.createdAt)) / 600) / 100 : null,
    gradedAt: now(),
  };
  const runFile = path.join(runsDir(root), `${meta.run}.json`);
  withLock(path.join(paths(root).locks, `eval-${meta.run}`), () => {
    const rec = readJson(runFile);
    // The run file is JSON on disk: raw input.
    const entry = rec.tasks.find((t: any) => t.job === jobId);
    if (entry) entry.result = result;
    if (rec.tasks.every((t: any) => t.result)) {
      rec.status = 'done';
      rec.finishedAt = now();
      rec.summary = summarize(rec);
    }
    writeJsonAtomic(runFile, rec);
  });
  logEvent(root, jobId, 'eval-graded', { pass: check.pass, judge: result.judge });
  setJob(root, jobId, { stage: 'done', state: 'done', reason: 'eval graded' });
  return result;
}

export function summarize(rec: Pick<EvalRun, 'tasks'>): EvalSummary {
  // filter(Boolean) drops the ungraded tasks' null results.
  const rs = rec.tasks.map((t) => t.result).filter(Boolean) as EvalResult[];
  const avg = (f: (r: EvalResult) => number | null) => {
    const xs = rs.map(f).filter((x) => typeof x === 'number');
    return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null;
  };
  const checked = rs.filter((r) => r.check?.ran);
  return {
    tasks: rec.tasks.length,
    graded: rs.length,
    checkPassRate: checked.length ? Math.round((checked.filter((r) => r.check.pass).length / checked.length) * 1000) / 1000 : null,
    avgJudgeScore: avg((r) => (r.judge ? r.judge.score / r.judge.outOf : null)),
    firstPassRate: avg((r) => (r.firstPass === null ? null : r.firstPass ? 1 : 0)),
    avgRounds: avg((r) => r.rounds),
    escalationRate: avg((r) => (r.decision ? (r.decision === 'ESCALATE' ? 1 : 0) : null)),
    avgTokens: avg((r) => r.tokens),
    avgCostUsd: avg((r) => r.estCostUsd),
    avgMinutes: avg((r) => r.minutes),
  };
}

export function listRuns(root: string): EvalRun[] {
  const dir = runsDir(root);
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const r = readJson(path.join(dir, f));
      return { ...r, summary: r.summary ?? summarize(r) };
    })
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export function compareRuns(root: string, a: string, b: string): EvalCompare {
  const runs = listRuns(root);
  const ra = runs.find((r) => r.id === a);
  const rb = runs.find((r) => r.id === b);
  if (!ra || !rb) throw new ForgeError(`unknown run ${!ra ? a : b}`);
  const delta: Record<string, any> = {};
  // A summary has exactly EvalSummary's keys.
  for (const k of Object.keys(ra.summary) as (keyof EvalSummary)[]) {
    const x = ra.summary[k];
    const y = rb.summary[k];
    delta[k] = { a: x, b: y, change: typeof x === 'number' && typeof y === 'number' ? Math.round((y - x) * 1000) / 1000 : null };
  }
  const perTask = ra.tasks.map((t) => {
    const other = rb.tasks.find((u) => u.task === t.task);
    return { task: t.task, a: t.result?.check?.pass ?? null, b: other?.result?.check?.pass ?? null };
  });
  return { a: { id: ra.id, configHash: ra.configHash, forgeVersion: ra.forgeVersion }, b: { id: rb.id, configHash: rb.configHash, forgeVersion: rb.forgeVersion }, delta, perTask };
}

export function createTask(root: string, name: string, title: string, request: string): { dir: string } {
  const dir = path.join(evalsDir(root), slugify(name, 6));
  if (exists(dir)) throw new ForgeError(`eval task ${name} already exists`);
  fs.mkdirSync(path.join(dir, 'check'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'task.yml'),
    yaml.stringify({ title, request, base: null, tags: [], check: { patch: null, files: 'check/files', command: null } }),
  );
  fs.mkdirSync(path.join(dir, 'check', 'files'), { recursive: true });
  return { dir };
}

