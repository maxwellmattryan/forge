// @ts-check
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { enforceBudget } from './budget.mjs';
import { worktreeRoot } from './config.mjs';
import { listJobs, isActive, loadJob, logEvent, setJob, touchJob, updateJob, jobDir } from './jobs.mjs';
import { exists, resolveFrom } from './paths.mjs';
import { ForgeError, fill, now, readJson, run, tail, writeJsonAtomic } from './util.mjs';

/** @param {string} root @param {string} branch @param {string} remote */
function branchState(root, branch, remote) {
  const local = run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root, allowFail: true }).ok;
  const remoteRef = run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`], { cwd: root, allowFail: true }).ok;
  return { local, remote: remoteRef };
}

/**
 * @param {string} root @param {any} config @param {string} id
 * @param {{from?:string, sparseExclude?:string[]}} [opts]
 */
export function createWorktree(root, config, id, opts = {}) {
  const job = loadJob(root, id);
  const wtRoot = worktreeRoot(root, config);
  const dir = path.join(wtRoot, id);
  if (job.worktree && exists(job.worktree)) return { path: job.worktree, created: false };
  fs.mkdirSync(wtRoot, { recursive: true });
  const remote = config.git.remote;
  run('git', ['fetch', remote, '--prune'], { cwd: root, allowFail: true });
  const st = branchState(root, job.branch, remote);
  const checkoutArgs = opts.sparseExclude?.length ? ['--no-checkout'] : [];
  if (st.local) {
    run('git', ['worktree', 'add', ...checkoutArgs, dir, job.branch], { cwd: root });
  } else if (st.remote) {
    run('git', ['worktree', 'add', ...checkoutArgs, '--track', '-b', job.branch, dir, `${remote}/${job.branch}`], { cwd: root });
  } else {
    const start = opts.from ?? (run('git', ['rev-parse', '--verify', '--quiet', `${remote}/${job.base}`], { cwd: root, allowFail: true }).ok ? `${remote}/${job.base}` : job.base);
    run('git', ['worktree', 'add', ...checkoutArgs, '--no-track', '-b', job.branch, dir, start], { cwd: root });
  }
  if (opts.sparseExclude?.length) {
    run('git', ['sparse-checkout', 'set', '--no-cone', '/*', ...opts.sparseExclude.map((p) => `!/${p.replace(/^\/+/, '')}`)], { cwd: dir });
    run('git', ['checkout'], { cwd: dir });
  }
  copyUntracked(root, dir, config.worktrees.copy ?? []);
  if (config.worktrees.cargo?.sharedTarget) writeSharedCargoTarget(root, config, wtRoot);
  const port = allocatePort(root, config, id);
  setJob(root, id, { fields: { worktree: dir, port } });
  logEvent(root, id, 'worktree', { path: dir, port });
  const setupLog = [];
  for (const cmd of config.worktrees.setup ?? []) {
    const res = shell(fill(cmd, vars(root, job, dir, port)), dir, envFor(job, dir, port));
    setupLog.push({ cmd, ok: res.ok, tail: tail(res.output, 15) });
    if (!res.ok) {
      logEvent(root, id, 'worktree-setup-failed', { cmd });
      return { path: dir, created: true, port, setup: setupLog, ok: false };
    }
  }
  return { path: dir, created: true, port, setup: setupLog, ok: true };
}

/**
 * Worktrees only contain tracked files; instructions like a gitignored CLAUDE.md or local .env
 * would otherwise be invisible to agents working there.
 * @param {string} root @param {string} dir @param {string[]} entries
 */
function copyUntracked(root, dir, entries) {
  for (const entry of entries) {
    const matches = entry.includes('*') ? globFiles(root, entry) : [entry];
    for (const rel of matches) {
      const src = path.join(root, rel);
      const dst = path.join(dir, rel);
      if (!exists(src) || exists(dst)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }
  }
}

/**
 * Minimal glob: "**" crosses directories, "*" does not. Untracked-only lookups keep it fast
 * because git already knows which ignored files exist.
 * @param {string} root @param {string} pattern
 */
function globFiles(root, pattern) {
  const re = new RegExp(
    '^' +
      pattern
        .split('**/')
        .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
        .join('(?:.*/)?') +
      '$',
  );
  const listed = run('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], { cwd: root, allowFail: true }).stdout;
  const plain = run('git', ['ls-files', '--others', '--ignored', '--exclude-standard'], { cwd: root, allowFail: true }).stdout;
  const all = new Set([...listed.split('\n'), ...plain.split('\n')].map((s) => s.replace(/\/$/, '')).filter(Boolean));
  return [...all].filter((f) => re.test(f) && !/(^|\/)(node_modules|target|\.git)(\/|$)/.test(f));
}

/**
 * Cargo discovers config by walking up from the working directory, so one file above all
 * worktrees points every job at a single target dir: dependencies compile once, not per job.
 * @param {string} root @param {any} config @param {string} wtRoot
 */
function writeSharedCargoTarget(root, config, wtRoot) {
  const td = config.worktrees.cargo.targetDir;
  const target = td === 'main' ? path.join(root, 'target') : td ? resolveFrom(root, td) : path.join(wtRoot, '.cargo-target');
  const cfgDir = path.join(wtRoot, '.cargo');
  const file = path.join(cfgDir, 'config.toml');
  const body = `# Written by Forge: shares one build directory across job worktrees.\n[build]\ntarget-dir = ${JSON.stringify(target)}\n`;
  fs.mkdirSync(cfgDir, { recursive: true });
  if (!exists(file) || fs.readFileSync(file, 'utf8') !== body) fs.writeFileSync(file, body);
}

/** @param {string} root @param {any} config @param {string} id */
function allocatePort(root, config, id) {
  const taken = new Set(listJobs(root).filter((j) => isActive(j) && j.id !== id && j.port).map((j) => j.port));
  for (let p = config.ports.base; p < config.ports.base + config.ports.span; p++) if (!taken.has(p)) return p;
  throw new ForgeError(`no free port in ${config.ports.base}-${config.ports.base + config.ports.span - 1}`);
}

/** @param {string} root @param {any} job @param {string} dir @param {number|null} port */
function vars(root, job, dir, port) {
  return { job: job.id, port: port ?? '', worktree: dir, root, branch: job.branch, base: job.base };
}

/** @param {any} job @param {string} dir @param {number|null} port */
function envFor(job, dir, port) {
  return { ...process.env, FORGE_JOB: job.id, FORGE_WORKTREE: dir, PORT: port ? String(port) : '', FORGE_PORT: port ? String(port) : '' };
}

/** @param {string} cmd @param {string} cwd @param {NodeJS.ProcessEnv} env */
function shell(cmd, cwd, env) {
  const res = run(process.env.SHELL || '/bin/sh', ['-lc', cmd], { cwd, env, allowFail: true });
  return { ok: res.ok, status: res.status, output: `${res.stdout}${res.stderr ? `\n${res.stderr}` : ''}` };
}

/**
 * Runs a configured command inside the job's worktree. Full output goes to a log file and only
 * a tail comes back, so agents spend context on failures rather than on passing build noise.
 * @param {string} root @param {any} config @param {string} id @param {string} name @param {{tail?:number, label?:string}} [opts]
 */
export function runCommand(root, config, id, name, opts = {}) {
  const job = loadJob(root, id);
  const service = job.services.length === 1 ? config.services.find((/** @type {any} */ s) => s.name === job.services[0]) : null;
  const template = service?.commands?.[name] ?? config.commands[name];
  if (!template) throw new ForgeError(`no "${name}" command configured (commands.${name} in .forge/config.yml)`);
  if (!job.worktree) throw new ForgeError(`job ${id} has no worktree yet; run: forge worktree create ${id}`);
  const cwd = service?.path ? path.join(job.worktree, service.path) : job.worktree;
  const cmd = fill(template, vars(root, job, job.worktree, job.port));
  // Agents run commands all through a build; each one proves the session is alive.
  touchJob(root, id);
  const started = Date.now();
  const res = shell(cmd, cwd, envFor(job, job.worktree, job.port));
  const logDir = path.join(jobDir(root, id), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${opts.label ?? name}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  fs.writeFileSync(logFile, `$ ${cmd}\n(cwd ${cwd})\n\n${res.output}\n\n[exit ${res.status}]\n`);
  const result = { name, cmd, ok: res.ok, exit: res.status, durationMs: Date.now() - started, log: path.relative(jobDir(root, id), logFile), tail: tail(res.output, opts.tail ?? 40) };
  logEvent(root, id, 'command', { name, ok: res.ok, exit: res.status, durationMs: result.durationMs });
  return result;
}

/**
 * The deterministic gate between build and review: cheap commands catch what would
 * otherwise cost a full round of reviewer agents. Every run is evidence bound to the commit
 * it checked: it records the HEAD sha and keeps earlier attempts instead of overwriting them.
 * Uncommitted changes fail the gate first, because reviewers and the PR only ever see commits.
 * @param {string} root @param {any} config @param {string} id
 */
export function verify(root, config, id) {
  const job = loadJob(root, id);
  if (!job.worktree || !exists(job.worktree)) throw new ForgeError(`job ${id} has no worktree yet; run: forge worktree create ${id}`);
  const sha = run('git', ['rev-parse', 'HEAD'], { cwd: job.worktree }).stdout.trim();
  const dirty = run('git', ['status', '--porcelain'], { cwd: job.worktree }).stdout.trim();
  /** @type {any[]} */
  const results = [];
  if (dirty) {
    results.push({ name: 'worktree-clean', ok: false, exit: null, tail: dirty });
  } else {
    for (const step of config.verify ?? []) {
      if (!config.commands[step]) {
        results.push({ name: step, ok: true, skipped: true });
        continue;
      }
      const r = runCommand(root, config, id, step, { label: `verify-${step}` });
      results.push(r);
      if (!r.ok) break;
    }
  }
  const ok = results.every((r) => r.ok);
  const attempt = job.verifyRuns.filter((/** @type {any} */ r) => r.round === job.round).length + 1;
  const lines = [`VERIFY: ${ok ? 'PASS' : 'FAIL'}`, '', `Round ${job.round} · attempt ${attempt} · ${sha.slice(0, 12)} · ${now()}`, ''];
  for (const r of results) {
    if (r.name === 'worktree-clean') {
      lines.push('## worktree-clean: FAILED (uncommitted changes)', '', 'Commit or discard these before verify can run:', '', '```', r.tail, '```', '');
      continue;
    }
    lines.push(`## ${r.name}: ${r.skipped ? 'skipped (no command configured)' : r.ok ? 'ok' : `FAILED (exit ${r.exit})`}`);
    if ('cmd' in r) lines.push('', '`' + r.cmd + '` · log: `' + r.log + '`');
    if ('tail' in r && !r.ok) lines.push('', '```', r.tail, '```');
    lines.push('');
  }
  const dir = path.join(jobDir(root, id), 'verify');
  fs.mkdirSync(dir, { recursive: true });
  const latest = path.join(dir, `round-${job.round}.md`);
  const previous = job.verifyRuns.filter((/** @type {any} */ r) => r.round === job.round).pop();
  if (previous && exists(latest)) fs.renameSync(latest, path.join(dir, `round-${job.round}-attempt-${previous.attempt}.md`));
  fs.writeFileSync(latest, lines.join('\n'));
  const rec = { round: job.round, attempt, sha, ok, at: now(), file: path.relative(jobDir(root, id), latest) };
  updateJob(root, id, (j) => {
    j.verify[job.round] = ok ? 'PASS' : 'FAIL';
    j.verifyRuns.push(rec);
    // Every failure, a dirty worktree included, asks for one retry; a pass does not reset it.
    if (!ok) j.verifyRetries[String(job.round)] = (j.verifyRetries[String(job.round)] ?? 0) + 1;
  });
  logEvent(root, id, 'verify', rec);
  const budget = enforceBudget(root, config, id, 'verify');
  return { ok, round: job.round, attempt, sha, file: path.relative(root, latest), steps: results.map(({ tail: _t, ...r }) => r), failure: results.find((r) => !r.ok), ...(budget ? { budget } : {}) };
}

/**
 * Whether the worktree's HEAD is the commit the latest verify run passed on. Anything that
 * publishes a branch should refuse when it is not: evidence for an older commit is not evidence.
 * @param {string} root @param {string} id
 */
export function verifiedHead(root, id) {
  const job = loadJob(root, id);
  if (!job.worktree || !exists(job.worktree)) throw new ForgeError(`job ${id} has no worktree`);
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: job.worktree }).stdout.trim();
  const last = job.verifyRuns[job.verifyRuns.length - 1] ?? null;
  return { head, last, verified: Boolean(last && last.ok && last.sha === head) };
}

/**
 * Long-running commands (dev servers) are detached and tracked by pid so a later session can stop them.
 * @param {string} root @param {any} config @param {string} id @param {string} name
 */
export function startBackground(root, config, id, name) {
  const job = loadJob(root, id);
  const template = config.commands[name];
  if (!template) throw new ForgeError(`no "${name}" command configured`);
  if (!job.worktree) throw new ForgeError(`job ${id} has no worktree yet`);
  touchJob(root, id);
  const logFile = path.join(jobDir(root, id), 'logs', `${name}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.env.SHELL || '/bin/sh', ['-lc', fill(template, vars(root, job, job.worktree, job.port))], {
    cwd: job.worktree,
    env: envFor(job, job.worktree, job.port),
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  const pidFile = path.join(jobDir(root, id), 'runtime.json');
  const rt = readJson(pidFile, {});
  rt[name] = { pid: child.pid, startedAt: now(), log: path.relative(jobDir(root, id), logFile), port: job.port };
  writeJsonAtomic(pidFile, rt);
  logEvent(root, id, 'background-start', { name, pid: child.pid, port: job.port });
  return { pid: child.pid, port: job.port, log: logFile };
}

/** @param {string} root @param {string} id */
export function stopBackground(root, id) {
  const pidFile = path.join(jobDir(root, id), 'runtime.json');
  const rt = readJson(pidFile, {});
  const stopped = [];
  for (const [name, info] of Object.entries(rt)) {
    try {
      process.kill(-/** @type {any} */ (info).pid, 'SIGTERM');
      stopped.push(name);
    } catch {
      try {
        process.kill(/** @type {any} */ (info).pid, 'SIGTERM');
        stopped.push(name);
      } catch {}
    }
  }
  writeJsonAtomic(pidFile, {});
  if (stopped.length) logEvent(root, id, 'background-stop', { names: stopped });
  return stopped;
}

/** @param {string} root @param {string} id @param {{deleteBranch?:boolean, force?:boolean}} [opts] */
export function removeWorktree(root, id, opts = {}) {
  const job = loadJob(root, id);
  stopBackground(root, id);
  if (job.worktree && exists(job.worktree)) {
    run('git', ['worktree', 'remove', ...(opts.force ? ['--force'] : []), job.worktree], { cwd: root });
  }
  run('git', ['worktree', 'prune'], { cwd: root, allowFail: true });
  if (opts.deleteBranch) run('git', ['branch', '-D', job.branch], { cwd: root, allowFail: true });
  setJob(root, id, { fields: { worktree: null } });
  logEvent(root, id, 'worktree-removed', { branchDeleted: Boolean(opts.deleteBranch) });
  return { removed: job.worktree };
}

/** Port probing lets `forge doctor` warn when something outside Forge holds a job's port. @param {number} port */
export function portInUse(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '127.0.0.1');
  });
}
