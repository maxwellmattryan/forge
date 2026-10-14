// `forge doctor` and GET /api/doctor: is this machine and repo ready for Forge?
import path from 'node:path';
import { validateConfig } from './config.ts';
import { apiKeyVars } from './daemon.ts';
import { isActive, listJobs } from './jobs.ts';
import { paths, exists } from './paths.ts';
import type { Config, DoctorCheck, DoctorReport } from './types.ts';
import { hasBinary, run } from './util.ts';

/** package.json `engines`: Node 22.18 is the first with type stripping on by default. */
export function nodeSupported(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 18);
}

export async function doctor(root: string, config: Config, initialized: boolean): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail });
  add('node >= 22.18', nodeSupported(process.versions.node), process.versions.node);
  const gitV = run('git', ['--version'], { allowFail: true });
  add('git', gitV.ok, gitV.stdout.trim());
  const sparse = run('git', ['sparse-checkout', '-h'], { allowFail: true });
  add('git sparse-checkout (evals)', sparse.status === 129 || sparse.ok, '');
  add('config present', initialized, initialized ? path.relative(root, paths(root).config) : 'run /forge init');
  if (initialized) {
    const problems = validateConfig(config, root);
    add('config valid', !problems.length, problems.join('; '));
  }
  const keys = apiKeyVars(process.env);
  if (initialized && config.daemon.enabled && keys.length) {
    const api = config.daemon.auth === 'api-key';
    add('daemon billing', true, api ? `${keys.join(', ')} set: sessions bill that API account (daemon.auth: api-key)` : `${keys.join(', ')} set but ignored: sessions use your Claude login (daemon.auth: subscription)`);
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
  const unsupported = listJobs(root).filter((j) => j._unsupported);
  if (unsupported.length) add('job schema', false, `${unsupported.length} job(s) from a newer Forge`);
  return { ok: checks.every((c) => c.ok), checks };
}
