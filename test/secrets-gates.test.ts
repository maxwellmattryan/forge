// The secret scanner's gates end to end, on scratch repos: verify, forge git commit, forge pr open,
// job agent end and forge secrets scan. Every planted value is built at runtime (secret-fixtures.ts).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, tempRepo } from './helpers.ts';
import { fingerprint } from '../lib/secrets.ts';
import { defaults } from '../lib/config.ts';
import { setJob } from '../lib/jobs.ts';
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
  test('verify blocks a planted key and an allowlist entry clears it', async () => {
    const s = await scratch();
    try {
      const key = token.aws('verify');
      const j = await s.job({ 'cfg/app.cfg': `# app\nregion = eu\nkey = ${key}\n` });
      let r = await s.verify(j.id);
      assert.equal(r.status, 1, r.stderr);
      assert.equal(r.out.failure.name, 'secrets');
      assert.deepEqual(r.out.secrets, { mode: 'block', ok: false, count: 1, allowed: 0, findings: [{ kind: 'aws-access-key', path: 'cfg/app.cfg', line: 3 }], more: 0 });
      assert.deepEqual(r.out.steps.map((x: any) => x.name), ['secrets'], 'no configured step ran');
      assert.ok(r.out.integrity && r.out.integrity.mode, 'the integrity report is still computed');
      assert.match(r.out.failure.tail, /^aws-access-key cfg\/app\.cfg:3 AKIA…[A-Z0-9?]{2} sha256:[0-9a-f]{12}…$/);
      assert.ok(!fs.existsSync(path.join(j.dir, 'logs')) || !fs.readdirSync(path.join(j.dir, 'logs')).some((x) => x.startsWith('verify-test')), 'the test command never ran');
      const md = fs.readFileSync(path.join(j.dir, 'verify', 'round-1.md'), 'utf8');
      assert.ok(md.includes('## secrets: FAILED (1 finding)'), md);
      const sha12 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: j.wt, encoding: 'utf8' }).trim().slice(0, 12);
      assert.ok(md.includes(`aws-access-key  cfg/app.cfg:3  ${sha12}  ${key.slice(0, 4)}…${key.slice(-2)}  ${fingerprint(key)}`), md);

      // An allowlist committed on the job branch is not read: only the main checkout's counts.
      write(j.wt, '.forge/secrets-allow.txt', `cfg/**\n${fingerprint(key)}\n`);
      commitAll(j.wt, 'allow my own key');
      r = await s.verify(j.id);
      assert.equal(r.status, 1);
      assert.equal(r.out.secrets.count, 1);
      assert.equal(r.out.secrets.allowed, 0);

      s.allow(['# known test key', fingerprint(key)]);
      r = await s.verify(j.id);
      assert.equal(r.status, 0, JSON.stringify(r.out.failure));
      assert.equal(r.out.secrets.count, 0);
      assert.equal(r.out.secrets.allowed, 1);
      assert.deepEqual(r.out.steps.map((x: any) => x.name), ['secrets', 'test']);
      const ok = fs.readFileSync(path.join(j.dir, 'verify', 'round-1.md'), 'utf8');
      assert.ok(ok.includes('## secrets: ok') && ok.includes('allowed by .forge/secrets-allow.txt:2'), ok);
      assert.ok(!s.trail(j.dir).includes(key), 'the planted value appears nowhere');
    } finally {
      s.cleanup();
    }
  });

  test('verify under warn reports and passes', async () => {
    const s = await scratch({ verifySecrets: 'warn' });
    try {
      const key = token.github('warn');
      const j = await s.job({ 'src/client.ts': `export const t = "${key}";\n` });
      const r = await s.verify(j.id);
      assert.equal(r.status, 0, JSON.stringify(r.out.failure));
      const step = r.out.steps.find((x: any) => x.name === 'secrets');
      assert.equal(step.ok, true);
      assert.equal(step.reason, '1 possible secret (verifySecrets: warn)');
      assert.equal(r.out.secrets.ok, true);
      assert.equal(r.out.secrets.count, 1);
      assert.equal(r.out.secrets.mode, 'warn');
      assert.deepEqual(r.out.steps.map((x: any) => x.name), ['secrets', 'test']);
      assert.ok(fs.readFileSync(path.join(j.dir, 'verify', 'round-1.md'), 'utf8').includes('## secrets: WARN (1 finding)'));
      const ev = s.events(j.dir).filter((e) => e.type === 'secret-found');
      assert.equal(ev.length, 1);
      assert.equal(ev[0].blocked, false);
      assert.ok(!s.trail(j.dir).includes(key));
    } finally {
      s.cleanup();
    }
  });

  test('verify scans every commit, commit messages and staged changes', async () => {
    const s = await scratch();
    try {
      const fails = async (j: { id: string }, expect: (f: any) => boolean, what: string) => {
        const r = await s.verify(j.id);
        assert.equal(r.status, 1, what);
        assert.equal(r.out.failure.name, 'secrets', what);
        assert.ok(r.out.secrets.findings.some(expect), `${what}: ${JSON.stringify(r.out.secrets.findings)}`);
        return r;
      };
      // Added in one commit, deleted in the next: the net diff is clean, the first commit is not.
      const k1 = token.slack('gone');
      const gone = await s.job({ 'notes.txt': `slack ${k1}\n` });
      write(gone.wt, 'notes.txt', 'nothing here\n');
      commitAll(gone.wt, 'remove it');
      await fails(gone, (f) => f.kind === 'slack-token' && f.path === 'notes.txt', 'added then deleted');

      const k2 = token.stripe('msg');
      const msg = await s.job({ 'a.txt': 'plain\n' }, `deploy with ${k2}`);
      const sha12 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: msg.wt, encoding: 'utf8' }).trim().slice(0, 12);
      await fails(msg, (f) => f.kind === 'stripe-live-key' && f.path === `(commit message ${sha12})`, 'commit message');

      for (const attr of ['*.cfg -diff', '*.cfg binary']) {
        const k = token.aws(attr);
        const j = await s.job({ '.gitattributes': `${attr}\n`, 'svc/app.cfg': `key=${k}\n` });
        await fails(j, (f) => f.kind === 'aws-access-key' && f.path === 'svc/app.cfg', attr);
      }
      const k3 = token.google('nul');
      const nul = await s.job({ 'data/blob.bin': `head\0\0\nkey ${k3}\n` });
      await fails(nul, (f) => f.kind === 'google-api-key' && f.path === 'data/blob.bin', 'NUL byte');

      // A key only on the base branch is not the job's.
      write(s.repo.dir, 'base.txt', `old ${token.aws('base')}\n`);
      commitAll(s.repo.dir, 'base key');
      const clean = await s.job({ 'b.txt': 'fine\n' });
      let r = await s.verify(clean.id);
      assert.equal(r.status, 0, JSON.stringify(r.out.failure));
      assert.equal(r.out.secrets.count, 0);

      // Staged but uncommitted: listed, while the dirty worktree is the failure.
      const k4 = token.gitlab('staged');
      write(clean.wt, 'c.txt', `gl ${k4}\n`);
      execFileSync('git', ['add', 'c.txt'], { cwd: clean.wt });
      r = await s.verify(clean.id);
      assert.equal(r.status, 1);
      assert.equal(r.out.failure.name, 'worktree-clean');
      assert.deepEqual(r.out.steps.map((x: any) => x.name), ['worktree-clean', 'secrets']);
      const md = fs.readFileSync(path.join(clean.dir, 'verify', 'round-1.md'), 'utf8');
      assert.ok(md.includes('## secrets: FAILED (1 finding)') && md.includes('gitlab-token  c.txt:1  staged  glpa…'), md);
      for (const [dir, k] of [[gone.dir, k1], [msg.dir, k2], [nul.dir, k3], [clean.dir, k4]]) assert.ok(!s.trail(dir).includes(k));
    } finally {
      s.cleanup();
    }
  });

  test('repo config in the worktree cannot hide or allow a secret', async () => {
    const s = await scratch();
    try {
      const key = token.openai('cfg');
      const j = await s.job({ 'app.py': `OPENAI = "${key}"\n` });
      const cfg = fs.readFileSync(path.join(j.wt, '.forge', 'config.yml'), 'utf8');
      write(j.wt, '.forge/config.yml', `${cfg}\nverifySecrets: warn\n`.replace(/^verifySecrets: block\n/m, ''));
      commitAll(j.wt, 'loosen the gate');
      const r = await s.verify(j.id);
      assert.equal(r.status, 1);
      assert.equal(r.out.secrets.mode, 'block');
      assert.equal(r.out.failure.name, 'secrets');
    } finally {
      s.cleanup();
    }
  });

  test('no gate prints a planted value', async () => {
    const s = await scratch();
    try {
      const keys = Array.from({ length: 12 }, (_, i) => token.aws(`many${i}`));
      const j = await s.job({ 'keys.txt': keys.map((k, i) => `k${i} ${k}`).join('\n') + '\n' });
      const r = await s.verify(j.id);
      assert.equal(r.status, 1);
      assert.equal(r.out.secrets.count, 12);
      assert.equal(r.out.secrets.findings.length, 10);
      assert.equal(r.out.secrets.more, 2);
      const [ev] = s.events(j.dir).filter((e) => e.type === 'secret-found');
      assert.equal(ev.gate, 'verify');
      assert.equal(ev.blocked, true);
      assert.equal(ev.count, 12);
      assert.equal(ev.allowed, 0);
      assert.equal(ev.round, 1);
      assert.equal(ev.more, 2);
      assert.equal(ev.findings.length, 10);
      for (const f of ev.findings) assert.deepEqual(Object.keys(f).sort(), ['excerpt', 'fingerprint', 'kind', 'line', 'path']);
      const all = s.trail(j.dir);
      for (const k of keys) assert.ok(!all.includes(k) && !all.includes(k.slice(4)), 'neither the value nor its body');
    } finally {
      s.cleanup();
    }
  });

  test('a scan that cannot finish fails under block and passes with an error under warn', async () => {
    const s = await scratch();
    try {
      const j = await s.job({ 'a.txt': 'fine\n' });
      setJob(s.repo.dir, j.id, { fields: { base: 'no-such-branch' } });
      let r = await s.verify(j.id);
      assert.equal(r.status, 1);
      assert.equal(r.out.failure.name, 'secrets');
      assert.match(r.out.secrets.error, /base no-such-branch not found/);
      assert.equal(r.out.secrets.ok, false);
      assert.match(fs.readFileSync(path.join(j.dir, 'verify', 'round-1.md'), 'utf8'), /^## secrets: ERROR \(base no-such-branch not found\)$/m);
      await s.configure({ verifySecrets: 'warn' });
      r = await s.verify(j.id);
      assert.equal(r.out.secrets.ok, true);
      assert.match(r.out.secrets.error, /not found/);
      assert.match(r.out.steps.find((x: any) => x.name === 'secrets').reason, /^scan incomplete \(verifySecrets: warn\): base no-such-branch not found/);
    } finally {
      s.cleanup();
    }
  });

  test('verifySecrets default and validation', async () => {
    assert.equal(defaults().verifySecrets, 'block');
    const s = await scratch();
    try {
      const file = path.join(s.repo.dir, '.forge', 'config.yml');
      assert.match(fs.readFileSync(file, 'utf8'), /^verifySecrets: block$/m);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^verifySecrets: block$/m, 'verifySecrets: strict'));
      const r = await s.raw(['config', 'validate']);
      assert.equal(r.status, 1);
      assert.ok(JSON.parse(r.stdout).problems.includes('verifySecrets must be one of block | warn (got "strict")'), r.stdout);
    } finally {
      s.cleanup();
    }
  });
});
