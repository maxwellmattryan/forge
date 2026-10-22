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
import { setJob, updateJob } from '../lib/jobs.ts';
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
      if (fs.statSync(p).isFile() && !/^(build|pr|tasks|notes)\.md$/.test(rel)) parts.push(fs.readFileSync(p, 'utf8'));
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
      assert.deepEqual(r.out.steps.map((x: any) => x.name), ['secrets', 'protected'], 'no configured step ran');
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
      // The branch's own allowlist is also a path the protected-paths policy refuses: take it out again.
      fs.rmSync(path.join(j.wt, '.forge/secrets-allow.txt'));
      commitAll(j.wt, 'drop the branch allowlist');

      s.allow(['# known test key', fingerprint(key)]);
      r = await s.verify(j.id);
      assert.equal(r.status, 0, JSON.stringify(r.out.failure));
      assert.equal(r.out.secrets.count, 0);
      assert.equal(r.out.secrets.allowed, 1);
      assert.deepEqual(r.out.steps.map((x: any) => x.name), ['secrets', 'protected', 'test']);
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
      assert.deepEqual(r.out.steps.map((x: any) => x.name), ['secrets', 'protected', 'test']);
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
      assert.deepEqual(r.out.steps.map((x: any) => x.name), ['worktree-clean', 'secrets', 'protected']);
      const md = fs.readFileSync(path.join(clean.dir, 'verify', 'round-1.md'), 'utf8');
      assert.ok(md.includes('## secrets: FAILED (1 finding)') && md.includes('gitlab-token  c.txt:1  staged  glpa…'), md);
      for (const [dir, k] of [[gone.dir, k1], [msg.dir, k2], [nul.dir, k3], [clean.dir, k4]]) assert.ok(!s.trail(dir).includes(k));
    } finally {
      s.cleanup();
    }
  });

  test('verify scans a merge resolution that a later commit removed, not the base side', async () => {
    const s = await scratch();
    try {
      const base = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: s.repo.dir, encoding: 'utf8' }).trim();
      const merge = (wt: string) => {
        try {
          execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'merge', '--no-edit', '-q', base], { cwd: wt, stdio: 'pipe' });
        } catch {
          // Conflicted: the caller resolves and commits.
        }
      };
      // A clean merge of a base that carries a key: the key is the base's, not the job's.
      const j = await s.job({ 'f.txt': 'a\nours\nc\n' });
      write(s.repo.dir, 'base.txt', `old ${token.aws('merge-base')}\n`);
      write(s.repo.dir, 'f.txt', 'a\ntheirs\nc\n');
      commitAll(s.repo.dir, 'base side');
      const clean = await s.job({ 'g.txt': 'fine\n' });
      merge(clean.wt);
      let r = await s.verify(clean.id);
      assert.equal(r.status, 0, JSON.stringify(r.out.failure));
      assert.equal(r.out.secrets.count, 0);

      // A conflict resolved with a key, then removed: only the merge commit ever held it.
      const key = token.slack('resolution');
      merge(j.wt);
      write(j.wt, 'f.txt', `a\nslack ${key}\nc\n`);
      commitAll(j.wt, 'resolve');
      write(j.wt, 'f.txt', 'a\nboth\nc\n');
      commitAll(j.wt, 'remove it');
      r = await s.verify(j.id);
      assert.equal(r.status, 1);
      assert.equal(r.out.failure.name, 'secrets');
      assert.ok(r.out.secrets.findings.some((f: any) => f.kind === 'slack-token' && f.path === 'f.txt'), JSON.stringify(r.out.secrets.findings));
      assert.ok(!s.trail(j.dir).includes(key));
    } finally {
      s.cleanup();
    }
  });

  test('repo config cannot re-encode commit messages past the scan', async () => {
    const s = await scratch();
    try {
      const key = token.stripe('utf16');
      const j = await s.job({ 'a.txt': 'plain\n' }, `deploy with ${key}`);
      // Worktree-writable repo config that interleaves NULs into `git log` output.
      execFileSync('git', ['config', 'i18n.logOutputEncoding', 'UTF-16'], { cwd: j.wt });
      execFileSync('git', ['config', 'log.showSignature', 'true'], { cwd: j.wt });
      const r = await s.verify(j.id);
      assert.equal(r.status, 1);
      assert.equal(r.out.failure.name, 'secrets');
      assert.ok(r.out.secrets.findings.some((f: any) => f.kind === 'stripe-live-key' && f.path.startsWith('(commit message ')), JSON.stringify(r.out.secrets));
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
      setJob(s.repo.dir, j.id, { owned: { base: 'no-such-branch' } });
      let r = await s.verify(j.id);
      assert.equal(r.status, 1);
      assert.equal(r.out.failure.name, 'secrets');
      assert.match(r.out.secrets.error, /base no-such-branch not found/);
      assert.equal(r.out.secrets.ok, false);
      assert.match(fs.readFileSync(path.join(j.dir, 'verify', 'round-1.md'), 'utf8'), /^## secrets: ERROR \(base no-such-branch not found\)$/m);
      // The scan error leaves a secret-found event too; SC1 still keys on the verify run.
      const [ev] = s.events(j.dir).filter((e) => e.type === 'secret-found');
      assert.deepEqual([ev.gate, ev.blocked, ev.count, ev.findings], ['verify', true, 0, []]);
      assert.match(ev.error, /base no-such-branch not found/);
      await s.configure({ verifySecrets: 'warn' });
      r = await s.verify(j.id);
      assert.equal(r.out.secrets.ok, true);
      assert.match(r.out.secrets.error, /not found/);
      assert.match(r.out.steps.find((x: any) => x.name === 'secrets').reason, /^scan incomplete \(verifySecrets: warn\): base no-such-branch not found/);
    } finally {
      s.cleanup();
    }
  });

  test('forge git commit refuses a secret in the message or staged changes', async () => {
    const s = await scratch();
    try {
      const j = await s.job({});
      const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: j.wt, encoding: 'utf8' }).trim();
      const staged = () => execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: j.wt, encoding: 'utf8' }).trim();
      const start = head();
      write(j.wt, 'notes.txt', 'fine\n');
      const pat = token.github('commit-msg');
      let r = await s.raw(['git', 'commit', j.id, '--message', `add notes with ${pat}`, '--json']);
      assert.equal(r.status, 1);
      assert.equal(JSON.parse(r.stdout).error.code, 'secret_found');
      assert.equal(head(), start, 'nothing committed');
      assert.equal(staged(), '', 'the message is refused before anything is staged');

      const key = token.aws('commit');
      write(j.wt, 'cfg/app.cfg', `key = ${key}\n`);
      r = await s.raw(['git', 'commit', j.id, '--message', 'add config']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /possible secret in the staged changes: aws-access-key at cfg\/app\.cfg:1 \(AKIA…/);
      assert.equal(head(), start, 'HEAD unchanged');
      assert.match(staged(), /cfg\/app\.cfg/, 'the index stays staged');
      let ev = s.events(j.dir).filter((e) => e.type === 'secret-found' && e.gate === 'commit');
      assert.deepEqual(ev.map((e) => [e.blocked, e.count, e.findings[0].path]), [[true, 1, '(commit message)'], [true, 1, 'cfg/app.cfg']]);

      await s.configure({ verifySecrets: 'warn' });
      r = await s.raw(['git', 'commit', j.id, '--message', 'add config']);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.secrets, 1);
      assert.notEqual(head(), start);
      ev = s.events(j.dir).filter((e) => e.type === 'secret-found' && e.gate === 'commit');
      assert.equal(ev.at(-1).blocked, false);
      // The message is text Forge publishes: refused under warn too.
      write(j.wt, 'more.txt', 'x\n');
      r = await s.raw(['git', 'commit', j.id, '--message', `note ${pat}`]);
      assert.equal(r.status, 1);
      const all = s.trail(j.dir);
      assert.ok(!all.includes(key) && !all.includes(pat));
    } finally {
      s.cleanup();
    }
  });

  test('forge pr open refuses before gh and push', async () => {
    const s = await scratch();
    const bin = path.join(s.repo.dir, '..', `fakebin-${path.basename(s.repo.dir)}`);
    const bare = path.join(s.repo.dir, '..', `remote-${path.basename(s.repo.dir)}.git`);
    try {
      fs.mkdirSync(bin);
      const ghLog = path.join(bin, 'gh.log');
      fs.writeFileSync(ghLog, '');
      fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$*" >> "${ghLog}"\nexit 1\n`, { mode: 0o755 });
      execFileSync('git', ['init', '-q', '--bare', bare]);
      execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: s.repo.dir });
      execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: s.repo.dir });
      const env = { PATH: `${bin}:${process.env.PATH}` };
      const remoteBranches = () => execFileSync('git', ['ls-remote', '--heads', bare], { encoding: 'utf8' });

      const j = await s.job({ 'src/a.ts': 'export const a = 1;\n' });
      assert.equal((await s.verify(j.id)).status, 0);
      const pat = token.github('pr-body');
      write(j.dir, 'pr.md', `## Summary\n\nTested with ${pat}.\n`);
      let r = await s.raw(['pr', 'open', j.id, '--json'], env);
      assert.equal(r.status, 1, r.stderr);
      const err = JSON.parse(r.stdout).error;
      assert.equal(err.code, 'secret_found');
      assert.match(err.message, /^possible secret in the PR title or body: github-token at \(pr body\) line 3 \(ghp_…/);
      assert.equal(fs.readFileSync(ghLog, 'utf8'), '', 'gh was never called');
      assert.ok(!remoteBranches().includes('forge/'), 'nothing was pushed');
      let ev = s.events(j.dir).filter((e) => e.type === 'secret-found' && e.gate === 'pr');
      assert.deepEqual(ev.map((e) => e.blocked), [true]);

      // --force on an unverified HEAD whose commit adds a key: refused the same way, before the push.
      fs.rmSync(path.join(j.dir, 'pr.md'));
      const key = token.anthropic('force');
      write(j.wt, 'src/b.ts', `export const k = '${key}';\n`);
      commitAll(j.wt, 'add b');
      r = await s.raw(['pr', 'open', j.id, '--force', '--json'], env);
      assert.equal(r.status, 1, r.stderr);
      assert.equal(JSON.parse(r.stdout).error.code, 'secret_found');
      assert.equal(fs.readFileSync(ghLog, 'utf8'), '');
      assert.ok(!remoteBranches().includes('forge/'));
      ev = s.events(j.dir).filter((e) => e.type === 'secret-found' && e.gate === 'pr');
      assert.deepEqual(ev.map((e) => [e.blocked, e.findings[0].kind]), [[true, 'github-token'], [true, 'anthropic-key']]);

      // A remote-tracking base moved onto the key commit from the worktree is refreshed before the scan.
      execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: j.wt });
      write(j.wt, 'src/c.ts', 'export const c = 3;\n');
      commitAll(j.wt, 'one more');
      r = await s.raw(['pr', 'open', j.id, '--force', '--json'], env);
      assert.equal(r.status, 1, r.stderr);
      assert.equal(JSON.parse(r.stdout).error.code, 'secret_found');
      assert.equal(fs.readFileSync(ghLog, 'utf8'), '');

      // A HEAD verified by a Forge without the scanner is still scanned: pr open is the real exit.
      const old = await s.job({ 'src/old.ts': `export const k = '${key}';\n` });
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: old.wt, encoding: 'utf8' }).trim();
      updateJob(s.repo.dir, old.id, (job) => {
        job.verifyRuns.push({ round: 1, attempt: 1, sha: head, ok: true, at: new Date().toISOString(), file: 'verify/round-1.md', failure: null });
      });
      r = await s.raw(['pr', 'open', old.id, '--json'], env);
      assert.equal(r.status, 1, r.stderr);
      assert.equal(JSON.parse(r.stdout).error.code, 'secret_found');
      assert.equal(fs.readFileSync(ghLog, 'utf8'), '', 'gh was never called');
      assert.ok(!remoteBranches().includes('forge/'), 'nothing was pushed');
      // url and pushurl split: the fetch goes to the push URL, so a broken fetch URL can't keep a
      // moved base in place while the push still reaches the real remote.
      execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: j.wt });
      execFileSync('git', ['config', 'remote.origin.url', path.join(bin, 'no-such-remote.git')], { cwd: j.wt });
      execFileSync('git', ['config', 'remote.origin.pushurl', bare], { cwd: j.wt });
      r = await s.raw(['pr', 'open', j.id, '--force', '--json'], env);
      assert.equal(r.status, 1, r.stderr);
      assert.equal(JSON.parse(r.stdout).error.code, 'secret_found', 'the base was refreshed from the push URL');
      // Under block, a fetch that fails refuses the open instead of scanning against a stale base.
      execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: j.wt });
      execFileSync('git', ['config', 'remote.origin.pushurl', path.join(bin, 'also-missing.git')], { cwd: j.wt });
      r = await s.raw(['pr', 'open', j.id, '--force', '--json'], env);
      assert.equal(r.status, 5, r.stdout);
      const refused = JSON.parse(r.stdout).error;
      assert.equal(refused.code, 'external');
      assert.match(refused.message, /^can't refresh base main from the push remote before the secret scan \(git fetch from origin's push URL exited \d+\)/);
      assert.match(refused.message, new RegExp(`check that origin's push remote is reachable, then retry forge pr open ${j.id}$`));
      assert.equal(refused.hint, `forge pr open ${j.id}`);
      assert.ok(!refused.message.includes('also-missing') && !refused.message.includes(bin), 'the URL is not echoed');
      assert.equal(fs.readFileSync(ghLog, 'utf8'), '', 'gh was never called');
      assert.ok(!remoteBranches().includes('forge/'), 'nothing was pushed');
      const all = s.trail(j.dir) + s.trail(old.dir);
      assert.ok(!all.includes(key) && !all.includes(pat));
    } finally {
      s.cleanup();
      fs.rmSync(bin, { recursive: true, force: true });
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  /** A fake gh that logs its calls and fails, and a bare remote at `<dir>/r.git` holding main. */
  const remoteSetup = (s: Awaited<ReturnType<typeof scratch>>) => {
    const tag = path.basename(s.repo.dir);
    const bin = path.join(s.repo.dir, '..', `fakebin-${tag}`);
    const dir = path.join(s.repo.dir, '..', `remote-${tag}`);
    const bare = path.join(dir, 'r.git');
    fs.mkdirSync(bin);
    fs.mkdirSync(dir);
    const ghLog = path.join(bin, 'gh.log');
    fs.writeFileSync(ghLog, '');
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$*" >> "${ghLog}"\nexit 1\n`, { mode: 0o755 });
    execFileSync('git', ['init', '-q', '--bare', bare]);
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: s.repo.dir });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: s.repo.dir });
    // A scp-like URL left unrewritten would reach for ssh: fail at once instead.
    const env = { PATH: `${bin}:${process.env.PATH}`, GIT_SSH_COMMAND: 'false' };
    const ghCalls = () => fs.readFileSync(ghLog, 'utf8');
    const pushed = () => execFileSync('git', ['ls-remote', '--heads', bare], { encoding: 'utf8' }).includes('forge/');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd });
    /** Sets origin's url to `one:r.git` and replaces every url.* rewrite with `rules` ([to, key]). */
    const rewrite = (cwd: string, rules: [string, 'insteadOf' | 'pushInsteadOf', string][]) => {
      let names = '';
      try {
        names = execFileSync('git', ['config', '--name-only', '--get-regexp', '^url\\.'], { cwd, encoding: 'utf8' });
      } catch {
        // None set: git config exits 1.
      }
      for (const name of new Set(names.split('\n').filter(Boolean))) git(cwd, 'config', '--unset-all', name);
      git(cwd, 'config', 'remote.origin.url', 'one:r.git');
      for (const [to, key, from] of rules) git(cwd, 'config', '--add', `url.${to}.${key}`, from);
    };
    const cleanup = () => {
      fs.rmSync(bin, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    };
    return { bin, dir, bare, env, ghCalls, pushed, git, rewrite, cleanup };
  };

  test('pr open refuses a push URL that insteadOf rewrites again', async () => {
    const s = await scratch();
    const r0 = remoteSetup(s);
    try {
      const key = token.anthropic('chain');
      const j = await s.job({ 'src/k.ts': `export const k = '${key}';\n` });
      const refusedOpen = async (what: string) => {
        const r = await s.raw(['pr', 'open', j.id, '--force', '--json'], r0.env);
        assert.equal(r.status, 5, `${what}: ${r.stdout}${r.stderr}`);
        const err = JSON.parse(r.stdout).error;
        assert.equal(err.code, 'external', what);
        assert.match(err.message, /^can't refresh base main from the push remote before the secret scan \(origin's push URL is rewritten again by url\.\*\.insteadOf, so a fetch would reach another repository\)/, what);
        assert.match(err.message, new RegExp(`fix the git config.s insteadOf/pushInsteadOf entries, then retry forge pr open ${j.id}$`), what);
        assert.equal(err.hint, `forge pr open ${j.id}`);
        for (const u of ['one:', 'two:', r0.dir]) assert.ok(!err.message.includes(u), `${what}: no URL in the message (${u})`);
        assert.equal(r0.ghCalls(), '', `${what}: gh was never called`);
        assert.ok(!r0.pushed(), `${what}: nothing was pushed`);
      };
      // AC1: one: → two: → the bare repo. The push resolves to two:, a fetch of two: to the bare repo.
      r0.rewrite(j.wt, [['two:', 'insteadOf', 'one:'], [`${r0.dir}/`, 'insteadOf', 'two:']]);
      await refusedOpen('a two-step insteadOf chain');
      // AC2: pushInsteadOf one: → two:, then insteadOf two: → the bare repo.
      r0.rewrite(j.wt, [['two:', 'pushInsteadOf', 'one:'], [`${r0.dir}/`, 'insteadOf', 'two:']]);
      await refusedOpen('pushInsteadOf plus insteadOf');
      // AC3: a single pushInsteadOf is an ordinary setup: the base is fetched from the rewritten push
      // URL, so a remote-tracking base moved onto the key commit is put back and the key is found.
      r0.rewrite(j.wt, [[`${r0.dir}/`, 'pushInsteadOf', 'one:']]);
      r0.git(j.wt, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      write(j.wt, 'src/c.ts', 'export const c = 3;\n');
      commitAll(j.wt, 'one more');
      const r = await s.raw(['pr', 'open', j.id, '--force', '--json'], r0.env);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.equal(JSON.parse(r.stdout).error.code, 'secret_found', 'the base was refreshed through the single rewrite');
      assert.equal(r0.ghCalls(), '');
      assert.ok(!r0.pushed());
      assert.ok(!s.trail(j.dir).includes(key));
    } finally {
      s.cleanup();
      r0.cleanup();
    }
  });

  test('refreshBase under warn scans against the ref as it is', async () => {
    const s = await scratch({ verifySecrets: 'warn' });
    const r0 = remoteSetup(s);
    try {
      const key = token.anthropic('warn');
      const j = await s.job({ 'src/k.ts': `export const k = '${key}';\n` });
      const open = async (what: string) => {
        const before = s.events(j.dir).filter((e) => e.type === 'secret-found' && e.gate === 'pr').length;
        const r = await s.raw(['pr', 'open', j.id, '--force', '--json'], r0.env);
        const err = r.stdout ? JSON.parse(r.stdout).error : null;
        assert.ok(!/can't refresh base/.test(String(err?.message ?? '') + r.stderr), `${what}: ${r.stdout}${r.stderr}`);
        const ev = s.events(j.dir).filter((e) => e.type === 'secret-found' && e.gate === 'pr').slice(before);
        assert.deepEqual(ev.map((e) => [e.blocked, e.findings[0]?.kind]), [[false, 'anthropic-key']], what);
      };
      // A push URL that can't be fetched: the fetch fails and the scan goes on.
      r0.git(j.wt, 'config', 'remote.origin.pushurl', path.join(r0.bin, 'no-such-remote.git'));
      await open('a broken push URL');
      // A chained insteadOf: the fetch is skipped and the scan goes on.
      r0.git(j.wt, 'config', '--unset', 'remote.origin.pushurl');
      r0.rewrite(j.wt, [['two:', 'insteadOf', 'one:'], [`${r0.dir}/`, 'insteadOf', 'two:']]);
      await open('a chained insteadOf');
    } finally {
      s.cleanup();
      r0.cleanup();
    }
  });

  test('a pr open scan error logs secret-found so the job parks', async () => {
    const s = await scratch();
    const r0 = remoteSetup(s);
    try {
      const j = await s.job({ 'src/a.ts': 'export const a = 1;\n' });
      // A base with no history in common: the refresh fetches it, then the scan finds no merge-base.
      const orphan = execFileSync('git', ['commit-tree', '-m', 'orphan', execFileSync('git', ['hash-object', '-t', 'tree', '-w', '--stdin'], { cwd: j.wt, input: '' }).toString().trim()], { cwd: j.wt, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.st', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.st' } }).trim();
      r0.git(j.wt, 'push', '-q', r0.bare, `${orphan}:refs/heads/orphan`);
      setJob(s.repo.dir, j.id, { owned: { base: 'orphan' } });
      const scanErrors = () => s.events(j.dir).filter((e) => e.type === 'secret-found' && e.gate === 'pr');
      let r = await s.raw(['pr', 'open', j.id, '--force', '--json'], r0.env);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      const err = JSON.parse(r.stdout).error;
      assert.equal(err.code, 'secret_found');
      assert.match(err.message, /commits could not finish/);
      let ev = scanErrors();
      assert.deepEqual(ev.map((e) => [e.blocked, e.count, e.findings, e.more, typeof e.error]), [[true, 0, [], 0, 'string']]);
      assert.ok(ev[0].error.length > 0 && ev[0].error.length <= 300);
      assert.equal(r0.ghCalls(), '');
      assert.ok(!r0.pushed());
      // Under warn the same error is a note: logged unblocked, and the open goes on past the scan.
      await s.configure({ verifySecrets: 'warn' });
      r = await s.raw(['pr', 'open', j.id, '--force', '--json'], r0.env);
      ev = scanErrors();
      assert.deepEqual(ev.map((e) => [e.blocked, e.count, typeof e.error]), [[true, 0, 'string'], [false, 0, 'string']]);
    } finally {
      s.cleanup();
      r0.cleanup();
    }
  });

  test('forge job agent end notes secrets in agent output', async () => {
    const s = await scratch();
    try {
      const j = await s.job({});
      const pat = token.slack('agent');
      const end = async () => JSON.parse((await s.raw(['job', 'agent', j.id, 'end', '--role', 'builder'])).stdout);
      const found = () => s.events(j.dir).filter((e) => e.type === 'secret-found');
      await s.f('job', 'agent', j.id, 'start', '--role', 'builder');
      write(j.dir, 'build.md', `## Round 1\n\nUsed ${pat} to test.\n`);
      let out = await end();
      assert.equal(out.secrets, 1);
      const [ev] = found();
      assert.equal(ev.gate, 'agent-end');
      assert.equal(ev.role, 'builder');
      assert.equal(ev.blocked, false);
      assert.deepEqual(ev.findings.map((f: any) => [f.kind, f.path, f.line]), [['slack-token', 'build.md', 3]]);

      // Older than the start, outside the role's list, a symlink out of the job dir, or clean: nothing.
      const outside = path.join(s.repo.dir, '..', `outside-${path.basename(s.repo.dir)}.md`);
      const cases: [string, () => void][] = [
        ['older than the start', () => {
          const old = new Date(Date.now() - 3_600_000);
          fs.utimesSync(path.join(j.dir, 'build.md'), old, old);
        }],
        ['outside the list', () => {
          write(j.dir, 'build.md', 'clean\n');
          write(j.dir, 'notes.md', `token ${pat}\n`);
        }],
        ['a symlink out of the job dir', () => {
          fs.rmSync(path.join(j.dir, 'build.md'));
          fs.writeFileSync(outside, `token ${pat}\n`);
          fs.symlinkSync(outside, path.join(j.dir, 'build.md'));
        }],
        ['clean', () => {
          fs.rmSync(path.join(j.dir, 'build.md'));
          write(j.dir, 'build.md', 'all clean\n');
        }],
      ];
      try {
        for (const [what, arrange] of cases) {
          await s.f('job', 'agent', j.id, 'start', '--role', 'builder');
          arrange();
          out = await end();
          assert.equal(out.secrets, undefined, what);
          assert.equal(found().length, 1, what);
        }
      } finally {
        fs.rmSync(outside, { force: true });
      }
      assert.ok(!s.trail(j.dir).includes(pat));
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
