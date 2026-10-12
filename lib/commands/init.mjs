// @ts-check
// `forge init write`, `forge doctor` and `forge migrate`: setting a repo up and keeping it healthy.
import fs from 'node:fs';
import path from 'node:path';
import { defaults, stringifyConfig, validateConfig } from '../config.mjs';
import { isActive, listJobs, jobDir } from '../jobs.mjs';
import { paths, exists, PLUGIN_ROOT } from '../paths.mjs';
import { migrateConfig, normalizeJob, serializeJob } from '../schema.mjs';
import { ForgeError, deepMerge, hasBinary, readJson, readText, run, writeJsonAtomic } from '../util.mjs';
import * as yaml from '../yaml.mjs';

/** @param {string} root @param {any} answers @param {boolean} force */
export function initWrite(root, answers, force) {
  const p = paths(root);
  if (exists(p.config) && !force) {
    const current = yaml.parse(readText(p.config)) ?? {};
    answers = deepMerge(current, answers);
  }
  const config = deepMerge(defaults(), answers);
  if (Array.isArray(answers?.review?.panel)) config.review.panel = answers.review.panel;
  const problems = validateConfig(config, root);
  if (problems.length) throw new ForgeError(`config would be invalid:\n- ${problems.join('\n- ')}`);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.config, stringifyConfig(config));
  const written = [path.relative(root, p.config)];
  const tpl = path.join(PLUGIN_ROOT, 'templates');
  /** @type {[string, string][]} */
  const seeds = [
    [path.join(tpl, 'gitignore'), path.join(p.dir, '.gitignore')],
    [path.join(tpl, 'learnings.md'), path.join(p.notes, 'learnings.md')],
    [path.join(tpl, 'README.md'), path.join(p.dir, 'README.md')],
  ];
  if (config.tracker.kind === 'local') seeds.push([path.join(tpl, 'backlog.md'), path.join(root, config.tracker.local.path)]);
  for (const [src, dst] of seeds) {
    if (exists(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    written.push(path.relative(root, dst));
  }
  return { ok: true, written };
}

/** @param {string} root @param {any} config @param {boolean} initialized */
export async function doctor(root, config, initialized) {
  const checks = [];
  const add = (/** @type {string} */ name, /** @type {boolean} */ ok, /** @type {string} */ detail = '') => checks.push({ name, ok, detail });
  add('node >= 20', Number(process.versions.node.split('.')[0]) >= 20, process.versions.node);
  const gitV = run('git', ['--version'], { allowFail: true });
  add('git', gitV.ok, gitV.stdout.trim());
  const sparse = run('git', ['sparse-checkout', '-h'], { allowFail: true });
  add('git sparse-checkout (evals)', sparse.status === 129 || sparse.ok, '');
  add('config present', initialized, initialized ? path.relative(root, paths(root).config) : 'run /forge init');
  if (initialized) {
    const problems = validateConfig(config, root);
    add('config valid', !problems.length, problems.join('; '));
  }
  const needsGh = config.pr.enabled || config.tracker.kind === 'github';
  if (needsGh) {
    const auth = hasBinary('gh') ? run('gh', ['auth', 'status'], { allowFail: true }) : null;
    add('gh installed + authenticated', Boolean(auth?.ok), auth ? (auth.ok ? 'ok' : (auth.stderr || auth.stdout).trim().split('\n')[0]) : 'gh not found');
    if (auth?.ok && ['project', 'both'].includes(config.tracker.github.statusSync)) {
      const scopes = `${auth.stdout}${auth.stderr}`;
      add('gh token has "project" scope', /project/.test(scopes), 'run: gh auth refresh -s project');
    }
  }
  const remote = run('git', ['remote', 'get-url', config.git.remote], { cwd: root, allowFail: true });
  add(`remote "${config.git.remote}"`, remote.ok, remote.ok ? 'ok' : 'missing (PRs need a remote)');
  const base = run('git', ['rev-parse', '--verify', '--quiet', config.git.base], { cwd: root, allowFail: true });
  add(`base branch "${config.git.base}"`, base.ok, '');
  for (const j of listJobs(root).filter((x) => isActive(x) && x.port)) {
    if (j.worktree && !exists(j.worktree)) add(`job ${j.id} worktree`, false, `missing: ${j.worktree}`);
  }
  const unsupported = listJobs(root).filter((j) => /** @type {any} */ (j)._unsupported);
  if (unsupported.length) add('job schema', false, `${unsupported.length} job(s) from a newer Forge`);
  return { ok: checks.every((c) => c.ok), checks };
}

/** @param {string} root */
export function migrate(root) {
  const p = paths(root);
  const changed = [];
  if (exists(p.config)) {
    const raw = yaml.parse(readText(p.config)) ?? {};
    const m = migrateConfig(raw);
    if (m.from !== undefined) {
      fs.writeFileSync(p.config, stringifyConfig(m.config));
      changed.push(path.relative(root, p.config));
    }
  }
  for (const j of listJobs(root)) {
    const file = path.join(jobDir(root, j.id), 'job.json');
    const raw = readJson(file);
    const next = serializeJob(normalizeJob(raw));
    if (JSON.stringify(raw) !== JSON.stringify(next)) {
      writeJsonAtomic(file, next);
      changed.push(path.relative(root, file));
    }
  }
  return { changed };
}
