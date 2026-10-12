// @ts-check
// Forge evaluation. An eval task is a request plus a hidden acceptance check. A run executes
// every selected task through the normal pipeline (eval mode: no tracker, no PR, no human gates),
// then grades each job. Runs are stamped with the Forge version and a hash of the repo's
// Forge configuration, so two runs can be compared to tell whether a change helped.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createJob, loadJob, logEvent, setJob, jobDir } from './jobs.mjs';
import { paths, exists, PLUGIN_ROOT } from './paths.mjs';
import { createWorktree } from './worktree.mjs';
import { ForgeError, fill, now, readJson, readText, run, slugify, tail, withLock, writeJsonAtomic } from './util.mjs';
import { repoSlug } from './pr.mjs';
import { firstVerifyRun } from './stats.mjs';
import * as yaml from './yaml.mjs';

const DEFAULT_TEST_PATTERN = '(^|/)(tests?|__tests__|spec|specs)/|[._-](test|spec)s?\\.[A-Za-z0-9]+$|_test\\.(go|py|rs)$|(^|/)test_[^/]+\\.py$';

/** @param {string} root */
export function evalsDir(root) {
  return path.join(paths(root).dir, 'evals');
}

/** @param {string} root */
function runsDir(root) {
  return path.join(evalsDir(root), 'runs');
}

/** @param {string} root */
export function listTasks(root) {
  const dir = evalsDir(root);
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'runs' && exists(path.join(dir, d.name, 'task.yml')))
    .map((d) => loadTask(root, d.name));
}

/** @param {string} root @param {string} name */
export function loadTask(root, name) {
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

export function forgeVersion() {
  return readJson(path.join(PLUGIN_ROOT, 'package.json'), { version: '0.0.0' }).version;
}

/**
 * Captures everything repo-side that shapes Forge behaviour, so a retro or config change
 * shows up as a different hash between two eval runs.
 * @param {string} root @param {any} config
 */
export function configHash(root, config) {
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
 * @param {string} root @param {any} config @param {number} pr @param {{name?:string, testPattern?:string}} [opts]
 */
export function mineFromPr(root, config, pr, opts = {}) {
  const slug = repoSlug(root, config);
  const info = JSON.parse(
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
  const issues = (info.closingIssuesReferences ?? []).map((/** @type {any} */ i) => i.number);
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

/** @param {string} diff @param {RegExp} testRe */
function splitDiff(diff, testRe) {
  const chunks = diff.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git'));
  const tests = [];
  const rest = [];
  for (const c of chunks) {
    const file = c.match(/^diff --git a\/(\S+) b\/(\S+)/)?.[2] ?? '';
    (testRe.test(file) ? tests : rest).push(c);
  }
  return { tests: tests.join(''), rest: rest.join('') };
}

/**
 * @param {string} root @param {any} config
 * @param {{tasks?:string[], tags?:string[], label?:string}} opts
 */
export function startRun(root, config, opts) {
  let tasks = listTasks(root);
  if (opts.tasks?.length) tasks = tasks.filter((t) => opts.tasks?.includes(t.name));
  if (opts.tags?.length) tasks = tasks.filter((t) => t.tags.some((/** @type {string} */ g) => opts.tags?.includes(g)));
  if (!tasks.length) throw new ForgeError('no eval tasks selected (add some under .forge/evals/ or run `forge eval mine --pr <n>`)');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const runId = `${stamp}${opts.label ? `-${slugify(opts.label, 3)}` : ''}`;
  const record = {
    schemaVersion: 1,
    id: runId,
    label: opts.label ?? null,
    forgeVersion: forgeVersion(),
    configHash: configHash(root, config),
    models: config.runtime.models,
    startedAt: now(),
    finishedAt: null,
    status: 'running',
    tasks: /** @type {any[]} */ ([]),
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
    const wt = createWorktree(root, config, job.id, { from: t.base ?? undefined, sparseExclude: ['.forge/evals'] });
    record.tasks.push({ task: t.name, job: job.id, worktreeOk: wt.ok !== false, result: null });
  }
  writeJsonAtomic(path.join(runsDir(root), `${runId}.json`), record);
  return record;
}

/**
 * Applies the hidden check on top of the job's final commit and records the job's Forge metrics.
 * @param {string} root @param {any} config @param {string} jobId
 */
export function gradeJob(root, config, jobId) {
  const job = loadJob(root, jobId);
  const meta = /** @type {any} */ (job).eval;
  if (!meta) throw new ForgeError(`job ${jobId} is not an eval job`);
  const task = loadTask(root, meta.task);
  const wt = job.worktree;
  if (!wt || !exists(wt)) throw new ForgeError(`eval job ${jobId} has no worktree`);
  /** @type {any} */
  const check = { ran: false, pass: null, tail: null };
  const cmd = task.check.command ?? config.commands.test;
  if (task.check.patch || task.check.files) {
    run('git', ['stash', '--include-untracked'], { cwd: wt, allowFail: true });
    let applied = true;
    if (task.check.patch) {
      const res = run('git', ['apply', '--3way', '--whitespace=nowarn', path.join(task.dir, task.check.patch)], { cwd: wt, allowFail: true });
      applied = res.ok;
      if (!res.ok) check.tail = tail(res.stderr, 20);
    }
    if (task.check.files) fs.cpSync(path.join(task.dir, task.check.files), wt, { recursive: true });
    if (applied && cmd) {
      const res = run(process.env.SHELL || '/bin/sh', ['-lc', fill(cmd, { job: jobId, port: job.port ?? '', worktree: wt })], { cwd: wt, allowFail: true });
      check.ran = true;
      check.pass = res.ok;
      check.tail = tail(`${res.stdout}\n${res.stderr}`, 30);
    } else if (!applied) {
      check.ran = true;
      check.pass = false;
      check.reason = 'hidden check did not apply cleanly';
    }
    run('git', ['reset', '--hard'], { cwd: wt, allowFail: true });
    run('git', ['clean', '-fd'], { cwd: wt, allowFail: true });
  }
  const judgeText = readText(path.join(jobDir(root, jobId), 'eval-judge.md'));
  const score = judgeText.match(/^\s*SCORE:\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+)/im);
  const rounds = Object.keys(job.verdicts).map(Number);
  const result = {
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
    const entry = rec.tasks.find((/** @type {any} */ t) => t.job === jobId);
    if (entry) entry.result = result;
    if (rec.tasks.every((/** @type {any} */ t) => t.result)) {
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

/** @param {any} rec */
export function summarize(rec) {
  const rs = rec.tasks.map((/** @type {any} */ t) => t.result).filter(Boolean);
  const avg = (/** @type {(r:any)=>number|null} */ f) => {
    const xs = rs.map(f).filter((/** @type {any} */ x) => typeof x === 'number');
    return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null;
  };
  const checked = rs.filter((/** @type {any} */ r) => r.check?.ran);
  return {
    tasks: rec.tasks.length,
    graded: rs.length,
    checkPassRate: checked.length ? Math.round((checked.filter((/** @type {any} */ r) => r.check.pass).length / checked.length) * 1000) / 1000 : null,
    avgJudgeScore: avg((r) => (r.judge ? r.judge.score / r.judge.outOf : null)),
    firstPassRate: avg((r) => (r.firstPass === null ? null : r.firstPass ? 1 : 0)),
    avgRounds: avg((r) => r.rounds),
    escalationRate: avg((r) => (r.decision ? (r.decision === 'ESCALATE' ? 1 : 0) : null)),
    avgTokens: avg((r) => r.tokens),
    avgCostUsd: avg((r) => r.estCostUsd),
    avgMinutes: avg((r) => r.minutes),
  };
}

/** @param {string} root */
export function listRuns(root) {
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

/** @param {string} root @param {string} a @param {string} b */
export function compareRuns(root, a, b) {
  const runs = listRuns(root);
  const ra = runs.find((r) => r.id === a);
  const rb = runs.find((r) => r.id === b);
  if (!ra || !rb) throw new ForgeError(`unknown run ${!ra ? a : b}`);
  /** @type {Record<string, any>} */
  const delta = {};
  for (const k of Object.keys(ra.summary)) {
    const x = ra.summary[k];
    const y = rb.summary[k];
    delta[k] = { a: x, b: y, change: typeof x === 'number' && typeof y === 'number' ? Math.round((y - x) * 1000) / 1000 : null };
  }
  const perTask = ra.tasks.map((/** @type {any} */ t) => {
    const other = rb.tasks.find((/** @type {any} */ u) => u.task === t.task);
    return { task: t.task, a: t.result?.check?.pass ?? null, b: other?.result?.check?.pass ?? null };
  });
  return { a: { id: ra.id, configHash: ra.configHash, forgeVersion: ra.forgeVersion }, b: { id: rb.id, configHash: rb.configHash, forgeVersion: rb.forgeVersion }, delta, perTask };
}

/** @param {string} root @param {string} name @param {string} title @param {string} request */
export function createTask(root, name, title, request) {
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

