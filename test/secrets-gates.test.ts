// The secret scanner's gates end to end, on scratch repos: verify, forge git commit, forge pr open,
// job agent end and forge secrets scan. Every planted value is built at runtime (secret-fixtures.ts).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, tempRepo } from './helpers.ts';
import { fingerprint } from '../lib/secrets.ts';
import { token } from './secret-fixtures.ts';

const commitAll = (cwd: string, msg: string) => {
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', msg], { cwd });
};
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

/** A scratch repo with Forge initialised (local tracker, no remote) and helpers for its jobs. */
async function scratch(extra: Record<string, unknown> = {}) {
  const repo = tempRepo();
  const name = path.basename(repo.dir);
  const answersFile = path.join(repo.dir, '..', `answers-${name}.json`);
  const outputs: string[] = [];
  const raw = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const r = await forgeAsync(repo.dir, args, env);
    outputs.push(r.stdout, r.stderr);
    return r;
  };
  const f = async (...args: string[]) => {
    const r = await raw(args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return r.stdout.trim();
    }
  };
  const configure = async (more: Record<string, unknown> = {}) => {
    fs.writeFileSync(answersFile, JSON.stringify({ commands: { test: 'echo TEST-RAN' }, verify: ['test'], worktrees: { root: `../${name}.wt` }, ...extra, ...more }));
    await f('init', 'write', '--answers', answersFile, '--force');
  };
  await configure();
  commitAll(repo.dir, 'forge init');
  /** A job whose branch commits `files` (path → text) in one commit with `msg`. */
  const job = async (files: Record<string, string>, msg = 'job work') => {
    const j = await f('job', 'new', '--title', `job ${Object.keys(files).join(' ')}`.slice(0, 60));
    const wt: string = (await f('worktree', 'create', j.id)).path;
    for (const [rel, text] of Object.entries(files)) write(wt, rel, text);
    if (Object.keys(files).length) commitAll(wt, msg);
    await f('job', 'round', j.id);
    return { id: j.id as string, wt, dir: path.join(repo.dir, '.forge', 'jobs', j.id) };
  };
  const verify = async (id: string) => {
    const r = await raw(['verify', id]);
    return { status: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
  };
  const allow = (lines: string[]) => write(repo.dir, '.forge/secrets-allow.txt', lines.join('\n') + '\n');
  const events = (dir: string) => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  /** Everything a gate could have written for a job: its files, events and every CLI output so far. */
  const trail = (dir: string) => {
    const parts = [...outputs];
    for (const rel of fs.readdirSync(dir, { recursive: true }).map(String)) {
      const p = path.join(dir, rel);
      if (fs.statSync(p).isFile() && !/^(build|pr|tasks)\.md$/.test(rel)) parts.push(fs.readFileSync(p, 'utf8'));
    }
    return parts.join('\n');
  };
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(path.join(repo.dir, '..', `${name}.wt`), { recursive: true, force: true });
    fs.rmSync(answersFile, { force: true });
  };
  return { repo, raw, f, configure, job, verify, allow, events, trail, cleanup };
}

describe('secret gates', { concurrency: 4 }, () => {
  test('forge secrets scan reports a job and tracked paths', async () => {
    const s = await scratch();
    try {
      const key = token.aws('scan');
      const pat = token.github('scan-pr');
      const j = await s.job({ 'cfg/app.env': `A=1\nAWS_KEY=${key}\n` });
      write(j.dir, 'pr.md', `## Summary\n\nUses ${pat} for the API.\n`);
      let r = await s.raw(['secrets', 'scan', j.id]);
      assert.equal(r.status, 1, r.stderr);
      const lines = r.stdout.trim().split('\n');
      assert.match(lines[0], new RegExp(`^SECRETS: 2 found, 0 allowed \\(${j.id}, base main @ [0-9a-f]{7}, 1 commit\\)$`));
      assert.ok(lines.some((l) => /^aws-access-key {2}cfg\/app\.env:2 {2}[0-9a-f]{12} {2}AKIA…/.test(l)), r.stdout);
      assert.ok(lines.some((l) => l.startsWith('github-token  (pr body):3  -  ghp_…')), r.stdout);
      r = await s.raw(['secrets', 'scan', j.id, '--json']);
      const out = JSON.parse(r.stdout);
      assert.deepEqual(Object.keys(out).sort(), ['allowed', 'allowedFindings', 'allowlist', 'count', 'findings', 'scanned', 'target'].sort());
      assert.deepEqual(out.target, { job: j.id });
      assert.equal(out.count, 2);
      assert.deepEqual(Object.keys(out.scanned).sort(), ['commits', 'files', 'skipped', 'texts']);
      assert.deepEqual(Object.keys(out.allowlist).sort(), ['entries', 'file', 'present', 'problems']);
      assert.equal(out.findings[0].fingerprint, fingerprint(key));

      // --paths reads the main checkout's tracked files only: not an untracked file, not a symlink.
      write(s.repo.dir, 'cfg/main.cfg', `token ${key}\n`);
      write(s.repo.dir, 'prod.env', `X=${key}\n`);
      commitAll(s.repo.dir, 'tracked config');
      write(s.repo.dir, 'local.env', `X=${key}\n`);
      fs.symlinkSync(path.join(s.repo.dir, 'prod.env'), path.join(s.repo.dir, 'cfg', 'link.cfg'));
      commitAll(s.repo.dir, 'a tracked symlink');
      execFileSync('git', ['rm', '-q', '--cached', 'local.env'], { cwd: s.repo.dir });
      r = await s.raw(['secrets', 'scan', '--paths', 'cfg/**,*.env']);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stdout, /^SECRETS: 2 found, 0 allowed \(paths cfg\/\*\*, \*\.env, 2 files\)/);
      assert.ok(r.stdout.includes('cfg/main.cfg:1') && r.stdout.includes('prod.env:1'), r.stdout);
      assert.ok(!r.stdout.includes('local.env') && !r.stdout.includes('link.cfg'), r.stdout);
      r = await s.raw(['secrets', 'scan', '--paths', 'cfg/**', '--paths', '*.env', '--json']);
      assert.deepEqual(JSON.parse(r.stdout).target, { paths: ['cfg/**', '*.env'] });

      // Both allowlisted (in the main checkout): exit 0, both listed as allowed.
      s.allow(['# test keys', 'cfg/**', fingerprint(pat)]);
      r = await s.raw(['secrets', 'scan', j.id]);
      assert.equal(r.status, 0, r.stdout);
      assert.match(r.stdout, /^SECRETS: 0 found, 2 allowed/);
      assert.ok(r.stdout.includes('.forge/secrets-allow.txt:2') && r.stdout.includes('.forge/secrets-allow.txt:3'), r.stdout);

      for (const args of [['secrets', 'scan'], ['secrets', 'scan', j.id, '--paths', 'cfg/**'], ['secrets', 'scan', '--paths']]) {
        r = await s.raw(args);
        assert.equal(r.status, 2, args.join(' '));
        assert.match(r.stderr, /usage: forge secrets scan \[<id> \| --paths <globs>\]/);
      }
      const all = s.trail(j.dir);
      assert.ok(!all.includes(key) && !all.includes(pat), 'no planted value is printed');
    } finally {
      s.cleanup();
    }
  });
});
