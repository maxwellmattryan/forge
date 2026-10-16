// policy.protectedPaths: the policy's shape and matching, and its gates end to end on scratch repos
// (forge git add|commit, forge verify, forge pr open, forge job set).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaults, loadConfig, validateConfig } from '../lib/config.ts';
import { hitLine, matchEntry, matchPolicy, policyProblems, policyRules, UNCHECKED_LINK } from '../lib/protected.ts';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../lib/schema.ts';
import { execFileSync } from 'node:child_process';
import { forgeAsync, repoTemplate, tempRepo } from './helpers.ts';

const DEFAULT_RULES = [
  { paths: ['.github/workflows/**', '.gitlab-ci.yml', 'Jenkinsfile', '.circleci/**'], action: 'escalate', reason: 'CI/CD configuration' },
  { paths: ['Dockerfile*', '**/*.tf'], action: 'escalate', reason: 'infrastructure' },
  { paths: ['**/migrations/**'], action: 'escalate', reason: 'database migrations' },
  { paths: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock'], action: 'escalate', reason: 'dependency lockfile' },
  { paths: ['**/.env*'], action: 'escalate', reason: 'environment files can hold credentials' },
  { paths: ['**/*.pem'], action: 'refuse', reason: 'private keys and certificates are never committed by Forge' },
  { paths: ['.forge/config.yml', '.forge/secrets-allow.txt', '.forge/trackers/**'], action: 'refuse', reason: "Forge's own policy changes only by a human on the base branch" },
];

describe('the policy', () => {
  test('policy defaults and an explicit empty list', () => {
    assert.deepEqual(defaults().policy.protectedPaths, DEFAULT_RULES);
    const repo = tempRepo();
    try {
      const file = path.join(repo.dir, '.forge', 'config.yml');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `schemaVersion: ${CONFIG_SCHEMA_VERSION}\n`);
      assert.deepEqual(loadConfig(repo.dir).config.policy.protectedPaths, DEFAULT_RULES, 'no policy key: the defaults');
      fs.writeFileSync(file, `schemaVersion: ${CONFIG_SCHEMA_VERSION}\npolicy:\n  protectedPaths: []\n`);
      const { config } = loadConfig(repo.dir);
      assert.deepEqual(config.policy.protectedPaths, [], 'an explicit empty list turns it off');
      assert.deepEqual(policyRules(config), []);
      assert.deepEqual(validateConfig(config, repo.dir).filter((p) => p.startsWith('policy')), []);
    } finally {
      repo.cleanup();
    }
  });

  test('config v5 migrates to v7 unchanged', () => {
    assert.equal(CONFIG_SCHEMA_VERSION, 10);
    const v5 = { schemaVersion: 5, git: { base: 'trunk' }, approver: { alwaysEscalate: ['x'] } };
    const { config, from } = migrateConfig(structuredClone(v5));
    assert.equal(from, 5);
    assert.deepEqual(config, { ...v5, schemaVersion: 10 }, 'nothing but schemaVersion changes');
  });

  test('invalid policy shapes are reported', () => {
    const problems = (policy: unknown) => policyProblems({ policy });
    const one = (policy: unknown, re: RegExp) => {
      const p = problems(policy);
      assert.equal(p.length, 1, `${JSON.stringify(policy)}: ${JSON.stringify(p)}`);
      assert.match(p[0], re);
    };
    const rule = (r: Record<string, unknown>) => ({ protectedPaths: [{ paths: ['a/**'], action: 'escalate', reason: 'r', ...r }] });
    assert.deepEqual(problems({ protectedPaths: DEFAULT_RULES }), []);
    one('x', /^policy must be a map/);
    one(['x'], /^policy must be a map/);
    one({ protectedPaths: 'x' }, /^policy\.protectedPaths must be a list of rules/);
    one({ protectedPaths: ['x'] }, /^policy\.protectedPaths rule 1 must be a map/);
    one(rule({ paths: [] }), /rule 1: paths must be a non-empty list/);
    one(rule({ paths: 'a/**' }), /rule 1: paths must be a non-empty list/);
    one(rule({ paths: [''] }), /rule 1: paths entries must be non-empty strings/);
    one(rule({ paths: ['/etc/x'] }), /must be relative to the repo/);
    one(rule({ paths: ['a/../b'] }), /must not contain a \.\. segment/);
    for (const g of ['-x', '!x', ':x']) one(rule({ paths: [g] }), /must not start with -, ! or :/);
    one(rule({ action: 'block' }), /rule 1: action must be one of escalate \| refuse/);
    one(rule({ reason: '' }), /rule 1: reason must be a string of 1 to 200 characters/);
    one(rule({ reason: 'x'.repeat(201) }), /reason must be a string/);
    one(rule({ reason: 'a\nb' }), /reason must be a string/);
    one(rule({ reason: 3 }), /reason must be a string/);
    // validateConfig carries them, and policyRules fails closed.
    const c = defaults() as any;
    c.policy = rule({ action: 'block' });
    assert.ok(validateConfig(c, process.cwd()).some((p) => p.startsWith('policy.protectedPaths rule 1: action')));
    assert.throws(() => policyRules(c), (e: any) => e.code === 'config_invalid' && e.exitCode === 2);
    // The generalised glob check keeps worktrees.generated's own wording.
    const g = defaults() as any;
    g.worktrees.generated = ['../x'];
    assert.ok(validateConfig(g, process.cwd()).includes('worktrees.generated entry "../x" must not contain a .. segment'));
  });

  test('policy matching table', () => {
    const rules = defaults().policy.protectedPaths;
    const cases: [string, number | null, string | null, string | null][] = [
      ['.GitHub/Workflows/ci.yml', 1, '.github/workflows/**', 'escalate'],
      ['.github/workflows/ci.yml', 1, '.github/workflows/**', 'escalate'],
      ['Jenkinsfile', 1, 'Jenkinsfile', 'escalate'],
      ['web/package-lock.json', 4, 'package-lock.json', 'escalate'],
      ['infra/main.tf', 2, '**/*.tf', 'escalate'],
      ['Dockerfile.dev', 2, 'Dockerfile*', 'escalate'],
      ['db/migrations/001.sql', 3, '**/migrations/**', 'escalate'],
      ['config/.env.local', 5, '**/.env*', 'escalate'],
      ['certs/key.pem', 6, '**/*.pem', 'refuse'],
      ['.forge/config.yml', 7, '.forge/config.yml', 'refuse'],
      ['.forge/trackers/x.ts', 7, '.forge/trackers/**', 'refuse'],
      ['src/app.ts', null, null, null],
      ['.forge/backlog.md', null, null, null],
      ['docs/migrations.md', null, null, null],
    ];
    for (const [p, rule, glob, action] of cases) {
      const m = matchPolicy(p, rules);
      assert.deepEqual(m && [m.rule, m.glob, m.action], rule === null ? null : [rule, glob, action], p);
    }
    // A path matching both actions reports refuse, even from a later rule.
    const m = matchPolicy('.github/workflows/deploy.pem', rules);
    assert.deepEqual([m?.rule, m?.action, m?.reason], [6, 'refuse', 'private keys and certificates are never committed by Forge']);
    // Within one action the first rule is named.
    const twice = [
      { paths: ['a/**'], action: 'escalate' as const, reason: 'first' },
      { paths: ['a/b'], action: 'escalate' as const, reason: 'second' },
    ];
    assert.equal(matchPolicy('a/b', twice)?.reason, 'first');
  });

  test('a link target that cannot be checked is refused', () => {
    const rules = defaults().policy.protectedPaths;
    const link = (newMode: string) => ({ path: 'lnk', status: 'A', oldMode: '000000', newMode, oldBlob: null, newBlob: 'a'.repeat(40) });
    // Unreadable, or longer than any real link (plain git stores a 120000 blob of any size).
    assert.deepEqual(matchEntry(link('120000'), rules, () => null), UNCHECKED_LINK);
    assert.deepEqual(matchEntry(link('120000'), rules, () => `${'./'.repeat(2100)}.forge/config.yml`), UNCHECKED_LINK);
    assert.equal(hitLine({ path: 'lnk', ...UNCHECKED_LINK }), 'lnk: link target could not be checked');
    // A readable target is matched as before: outside the repo or unprotected is no hit, a protected one names its rule.
    assert.equal(matchEntry(link('120000'), rules, () => '../outside'), null);
    assert.equal(matchEntry(link('120000'), rules, () => 'src/app.ts'), null);
    assert.equal(matchEntry(link('120000'), rules, () => '.forge/config.yml')?.rule, 7);
    // A regular file's blob is never read as a target.
    assert.equal(matchEntry(link('100644'), rules, () => null), null);
  });
});

// ---------- the gates, on scratch repos ----------

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
/** Writes a marker when FORGE_TEST_MARK is set, so a test can tell whether verify ran a configured command. */
const MARK_CMD = '[ -z "$FORGE_TEST_MARK" ] || touch "$FORGE_TEST_MARK"';

const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const commitAll = (cwd: string, msg: string) => {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', msg);
};

const fresh = repoTemplate((dir) => {
  const answers = path.join(dir, '..', `answers-${path.basename(dir)}.json`);
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: MARK_CMD }, verify: ['test'], worktrees: { root: '../{repo}.wt' } }));
  try {
    execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  } finally {
    fs.rmSync(answers, { force: true });
  }
  write(dir, 'notes.txt', 'notes\n');
  write(dir, '.forge/secrets-allow.txt', '# nothing allowed\n');
  write(dir, 'package-lock.json', '{"lockfileVersion":1}\n');
  commitAll(dir, 'forge init');
});

/** A copy of the template repo with helpers for its jobs. */
function scratch() {
  const repo = fresh();
  const raw = (args: string[], env: NodeJS.ProcessEnv = {}) => forgeAsync(repo.dir, args, env);
  const f = async (...args: string[]) => {
    const r = await raw(args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return r.stdout.trim();
    }
  };
  /** Runs a forge command with --json and returns its status and parsed output (or error). */
  const json = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const r = await raw([...args.slice(0, 2), '--json', ...args.slice(2)], env);
    let out: any = null;
    try {
      out = JSON.parse(r.stdout);
    } catch {}
    return { status: r.status, out, err: out?.error ?? null, stderr: r.stderr };
  };
  const job = async () => {
    const j = await f('job', 'new', '--title', 'protected job');
    const wt: string = (await f('worktree', 'create', j.id)).path;
    await f('job', 'round', j.id);
    return { id: j.id as string, wt, dir: path.join(repo.dir, '.forge', 'jobs', j.id) };
  };
  const events = (dir: string) => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const flag = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8')).protectedPaths;
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(path.join(repo.dir, '..', `${path.basename(repo.dir)}.wt`), { recursive: true, force: true });
  };
  return { repo, raw, f, json, job, events, flag, cleanup };
}

const CONFIG_REASON = "Forge's own policy changes only by a human on the base branch";

describe('forge git add and commit', { concurrency: 4 }, () => {
  test('add refuses a refuse path without staging', async () => {
    const s = scratch();
    try {
      const j = await s.job();
      write(j.wt, '.forge/config.yml', 'schemaVersion: 6\npolicy:\n  protectedPaths: []\n');
      const before = git(j.wt, 'diff', '--cached', '--name-only');
      const r = await s.json(['git', 'add', j.id, '--', '.forge/config.yml']);
      assert.equal(r.status, 1, r.stderr);
      assert.equal(r.err.code, 'protected_path');
      assert.match(r.err.message, /^forge git add refuses protected paths:\n/);
      assert.ok(r.err.message.includes(`.forge/config.yml: rule 7 (.forge/config.yml): ${CONFIG_REASON}`), r.err.message);
      assert.equal(git(j.wt, 'diff', '--cached', '--name-only'), before, 'nothing staged');
      const ev = s.events(j.dir).filter((e) => e.type === 'protected-path');
      assert.deepEqual(ev.map((e) => [e.gate, e.action, e.blocked, e.more]), [['add', 'refuse', true, 0]]);
      assert.deepEqual(ev[0].paths, [{ path: '.forge/config.yml', rule: 7, glob: '.forge/config.yml', reason: CONFIG_REASON }]);
    } finally {
      s.cleanup();
    }
  });

  test('commit refuses without writing', async () => {
    const s = scratch();
    try {
      const j = await s.job();
      const head = git(j.wt, 'rev-parse', 'HEAD');
      write(j.wt, 'certs/key.pem', 'not a real key\n');
      write(j.wt, 'src/ok.ts', 'export const ok = 1;\n');
      const r = await s.json(['git', 'commit', j.id, '--message', 'm']);
      assert.equal(r.status, 1, r.stderr);
      assert.equal(r.err.code, 'protected_path');
      assert.match(r.err.message, /^forge git commit refuses protected paths:\n {2}certs\/key\.pem: rule 6 \(\*\*\/\*\.pem\): private keys and certificates are never committed by Forge$/);
      assert.equal(git(j.wt, 'rev-parse', 'HEAD'), head, 'HEAD unchanged');
      assert.equal(git(j.wt, 'diff', '--cached', '--name-only'), '', 'the index unchanged');
      assert.equal(fs.readFileSync(path.join(j.wt, 'certs/key.pem'), 'utf8'), 'not a real key\n', 'the worktree file unchanged');
      assert.deepEqual(fs.readdirSync(j.dir).filter((n) => n.startsWith('.protected-index')), [], 'no temp index left');
    } finally {
      s.cleanup();
    }
  });

  test('commit escalates and records the flag', async () => {
    const s = scratch();
    try {
      const j = await s.job();
      write(j.wt, 'package-lock.json', '{"lockfileVersion":2}\n');
      const r = await s.json(['git', 'commit', j.id, '--message', 'bump lock']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.out.protected, 1);
      const blob = git(j.wt, 'rev-parse', 'HEAD:package-lock.json');
      const flag = s.flag(j.dir);
      assert.deepEqual(flag.hits, [{ path: 'package-lock.json', rule: 4, glob: 'package-lock.json', reason: 'dependency lockfile', blob }]);
      assert.deepEqual([flag.gate, flag.head, flag.more], ['commit', r.out.sha, 0]);
      const ev = s.events(j.dir).filter((e) => e.type === 'protected-path');
      assert.deepEqual(ev.map((e) => [e.gate, e.action, e.blocked, e.head]), [['commit', 'escalate', false, r.out.sha]]);
      const diff = fs.readFileSync(path.join(j.dir, 'protected.diff'), 'utf8');
      assert.match(diff, /^diff --git a\/package-lock\.json b\/package-lock\.json$/m);
      assert.match(diff, /^\+\{"lockfileVersion":2\}$/m);
      // A commit with no escalate path on the branch any more clears the flag and the diff.
      write(j.wt, 'package-lock.json', '{"lockfileVersion":1}\n');
      const back = await s.json(['git', 'commit', j.id, '--message', 'restore lock']);
      assert.equal(back.status, 0, back.stderr);
      assert.equal(back.out.protected, undefined);
      assert.equal(s.flag(j.dir), null);
      assert.equal(fs.existsSync(path.join(j.dir, 'protected.diff')), false);
    } finally {
      s.cleanup();
    }
  });

  test('flag at moves only on new content', async () => {
    const s = scratch();
    try {
      const j = await s.job();
      write(j.wt, '.github/workflows/ci.yml', 'on: push\n');
      const added = await s.json(['git', 'add', j.id, '--', '.github/workflows/ci.yml']);
      assert.equal(added.status, 0, added.stderr);
      assert.equal(added.out.protected, 1);
      const first = s.flag(j.dir);
      assert.deepEqual([first.gate, first.head, first.hits[0].rule, first.hits[0].path], ['add', null, 1, '.github/workflows/ci.yml']);
      const c1 = await s.json(['git', 'commit', j.id, '--message', 'ci']);
      assert.equal(c1.status, 0, c1.stderr);
      const second = s.flag(j.dir);
      assert.equal(second.gate, 'commit');
      assert.equal(second.at, first.at, 'the same content keeps at');
      write(j.wt, '.github/workflows/ci.yml', 'on: [push, pull_request]\n');
      const c2 = await s.json(['git', 'commit', j.id, '--message', 'ci again']);
      assert.equal(c2.status, 0, c2.stderr);
      const third = s.flag(j.dir);
      assert.ok(third.at > first.at, 'new content moves at');
      assert.equal(third.hits[0].blob, git(j.wt, 'rev-parse', 'HEAD:.github/workflows/ci.yml'));
    } finally {
      s.cleanup();
    }
  });

  test('the flag covers escalate paths past the stored 200', async () => {
    const s = scratch();
    try {
      const j = await s.job();
      // 200 paths that sort before the one that matters, so it falls past the stored hits.
      for (let i = 0; i < 200; i++) write(j.wt, `.a/migrations/${String(i).padStart(3, '0')}.sql`, `-- ${i}\n`);
      write(j.wt, '.github/workflows/x.yml', 'on: push\n');
      const c1 = await s.json(['git', 'commit', j.id, '--message', 'many migrations']);
      assert.equal(c1.status, 0, c1.stderr);
      assert.equal(c1.out.protected, 201);
      const first = s.flag(j.dir);
      assert.deepEqual([first.hits.length, first.more], [200, 1]);
      assert.ok(!first.hits.some((h: any) => h.path === '.github/workflows/x.yml'), 'the workflow is past the stored hits');
      assert.match(first.digest, /^[0-9a-f]{64}$/);
      const diff = fs.readFileSync(path.join(j.dir, 'protected.diff'), 'utf8');
      assert.match(diff, /^diff --git a\/\.github\/workflows\/x\.yml b\/\.github\/workflows\/x\.yml$/m, 'protected.diff holds every path, not only the stored ones');
      assert.match(diff, /^diff --git a\/\.a\/migrations\/000\.sql /m);
      // A change elsewhere keeps at; new content in the path past the cap moves it.
      write(j.wt, 'notes.txt', 'more notes\n');
      const c2 = await s.json(['git', 'commit', j.id, '--message', 'notes']);
      assert.equal(c2.status, 0, c2.stderr);
      const second = s.flag(j.dir);
      assert.equal(second.at, first.at, 'the same set keeps at');
      assert.equal(second.digest, first.digest);
      write(j.wt, '.github/workflows/x.yml', 'on: [push, pull_request]\n');
      const c3 = await s.json(['git', 'commit', j.id, '--message', 'workflow']);
      assert.equal(c3.status, 0, c3.stderr);
      const third = s.flag(j.dir);
      assert.equal(third.more, 1);
      assert.notEqual(third.digest, first.digest);
      assert.ok(third.at > first.at, 'new content past the stored hits moves at');
    } finally {
      s.cleanup();
    }
  });

  test('renames and deletions check both sides', async () => {
    const s = scratch();
    try {
      const j = await s.job();
      const reset = () => {
        git(j.wt, 'reset', '-q', '--hard');
        git(j.wt, 'clean', '-qfd');
      };
      const refused = async (paths: string[], named: string, rule: string) => {
        const before = git(j.wt, 'diff', '--cached', '--name-status');
        const r = await s.json(['git', 'add', j.id, '--', ...paths]);
        assert.equal(r.status, 1, `${paths}: ${r.stderr}${JSON.stringify(r.out)}`);
        assert.equal(r.err.code, 'protected_path');
        assert.ok(r.err.message.includes(`\n  ${named}: rule 7 (${rule}): `), r.err.message);
        assert.equal(r.err.message.split('\n').length, 2, 'only the protected side is named');
        assert.equal(git(j.wt, 'diff', '--cached', '--name-status'), before);
        reset();
      };
      fs.renameSync(path.join(j.wt, '.forge/config.yml'), path.join(j.wt, 'notes.yml'));
      await refused(['.forge/config.yml', 'notes.yml'], '.forge/config.yml', '.forge/config.yml');
      fs.mkdirSync(path.join(j.wt, '.forge/trackers'), { recursive: true });
      fs.renameSync(path.join(j.wt, 'notes.txt'), path.join(j.wt, '.forge/trackers/x.ts'));
      await refused(['notes.txt', '.forge/trackers/x.ts'], '.forge/trackers/x.ts', '.forge/trackers/**');
      fs.rmSync(path.join(j.wt, '.forge/secrets-allow.txt'));
      await refused(['.forge/secrets-allow.txt'], '.forge/secrets-allow.txt', '.forge/secrets-allow.txt');
    } finally {
      s.cleanup();
    }
  });

  test('reverting a refused path is allowed', async () => {
    const s = scratch();
    try {
      const j = await s.job();
      const original = fs.readFileSync(path.join(j.wt, '.forge/config.yml'), 'utf8');
      write(j.wt, '.forge/config.yml', `${original}# sneaked in\n`);
      commitAll(j.wt, 'plain git, outside forge git');
      write(j.wt, '.forge/config.yml', original);
      const r = await s.json(['git', 'commit', j.id, '--message', 'revert the config']);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.out.files, ['.forge/config.yml']);
      assert.equal(git(j.wt, 'diff', '--name-only', 'main', 'HEAD', '--', '.forge'), '');
    } finally {
      s.cleanup();
    }
  });

  test('symlinks and case variants are caught', async () => {
    const s = scratch();
    try {
      // A symlink pointing at a refuse path.
      const a = await s.job();
      fs.symlinkSync('.forge/config.yml', path.join(a.wt, 'cfg'));
      const r = await s.json(['git', 'add', a.id, '--', 'cfg']);
      assert.equal(r.status, 1, r.stderr);
      assert.ok(r.err.message.includes(`\n  cfg: rule 7 (.forge/config.yml): ${CONFIG_REASON}`), r.err.message);
      assert.equal(git(a.wt, 'diff', '--cached', '--name-only'), '');

      // A symlink standing in for a protected directory.
      const b = await s.job();
      write(b.wt, 'ci/workflows/x.yml', 'on: push\n');
      fs.symlinkSync('ci/', path.join(b.wt, '.github'));
      const rb = await s.json(['git', 'add', b.id, '--', '.github', 'ci']);
      assert.equal(rb.status, 0, rb.stderr);
      assert.equal(rb.out.protected, 1);
      assert.deepEqual(s.flag(b.dir).hits.map((h: any) => [h.path, h.rule, h.glob]), [['.github', 1, '.github/workflows/**']]);

      // A case variant of a protected directory.
      const c = await s.job();
      write(c.wt, '.GitHub/Workflows/x.yml', 'on: push\n');
      const rc = await s.json(['git', 'add', c.id, '--', '.GitHub']);
      assert.equal(rc.status, 0, rc.stderr);
      assert.deepEqual(s.flag(c.dir).hits.map((h: any) => [h.path, h.rule]), [['.GitHub/Workflows/x.yml', 1]]);
    } finally {
      s.cleanup();
    }
  });

  test("a base merge's own changes do not count", async () => {
    const s = scratch();
    try {
      const j = await s.job();
      write(j.wt, 'README.md', '# ours\n');
      commitAll(j.wt, 'ours');
      write(s.repo.dir, 'README.md', '# theirs\n');
      fs.appendFileSync(path.join(s.repo.dir, '.forge/config.yml'), '# a human changed the policy on main\n');
      commitAll(s.repo.dir, 'theirs');
      const r = await s.json(['integrate', j.id, '--strategy', 'merge', '--keep-conflicts'], { GIT_EDITOR: 'true' });
      assert.equal(r.status, 1, r.stderr);
      assert.deepEqual(r.out.conflicts, ['README.md']);
      assert.ok(git(j.wt, 'diff', '--cached', '--name-only').split('\n').includes('.forge/config.yml'), 'the base side is staged by the merge');
      write(j.wt, 'README.md', '# both\n');
      const added = await s.json(['git', 'add', j.id, '--', 'README.md']);
      assert.equal(added.status, 0, `${added.stderr}${JSON.stringify(added.out)}`);
    } finally {
      s.cleanup();
    }
  });

  test('the flag is not settable by job set', async () => {
    const s = scratch();
    try {
      const j = await s.job();
      for (const field of ['protectedPaths=null', 'protectedPaths.hits=[]']) {
        const r = await s.raw(['job', 'set', j.id, '--field', field]);
        assert.equal(r.status, 1, field);
        assert.match(r.stderr, /--field protectedPaths is not settable; use forge git add\|commit, forge verify or forge pr open/);
      }
    } finally {
      s.cleanup();
    }
  });

  test('invalid policy fails closed', async () => {
    const s = scratch();
    try {
      const j = await s.job();
      const cfg = path.join(s.repo.dir, '.forge/config.yml');
      const text = fs.readFileSync(cfg, 'utf8');
      assert.match(text, /^policy:\n/m, 'init write records the policy');
      fs.writeFileSync(cfg, text.replace(/^policy:\n(?:[ #].*\n|\n)*/m, 'policy:\n  protectedPaths: everything\n'));
      const head = git(j.wt, 'rev-parse', 'HEAD');
      write(j.wt, 'src/a.ts', 'export const a = 1;\n');
      for (const args of [['git', 'commit', j.id, '--message', 'm'], ['git', 'add', j.id, '--', 'src/a.ts']]) {
        const r = await s.json(args);
        assert.equal(r.status, 2, `${args[1]}: ${r.stderr}`);
        assert.equal(r.err.code, 'config_invalid');
        assert.match(r.err.message, /policy\.protectedPaths must be a list of rules/);
      }
      assert.equal(git(j.wt, 'rev-parse', 'HEAD'), head, 'HEAD unchanged');
      assert.equal(git(j.wt, 'diff', '--cached', '--name-only'), '', 'the index unchanged');
    } finally {
      s.cleanup();
    }
  });
});

describe('verify and pr open', { concurrency: 4 }, () => {
  test('verify refuses a path committed outside forge git', async () => {
    const s = scratch();
    const mark = path.join(s.repo.dir, '..', `mark-${path.basename(s.repo.dir)}`);
    try {
      const j = await s.job();
      fs.appendFileSync(path.join(j.wt, '.forge/config.yml'), '# loosened on the branch\n');
      commitAll(j.wt, 'plain git');
      const r = await s.json(['verify', j.id], { FORGE_TEST_MARK: mark });
      assert.equal(r.status, 1, r.stderr);
      assert.equal(r.out.ok, false);
      assert.equal(r.out.failure.name, 'protected');
      assert.deepEqual(r.out.protected, { ok: false, refused: ['.forge/config.yml'], escalated: [], more: 0 });
      assert.equal(fs.existsSync(mark), false, 'no configured command ran');
      assert.ok(!r.out.steps.some((st: any) => st.name === 'test'), 'the test step is not listed as run');
      const md = fs.readFileSync(path.join(j.dir, 'verify', 'round-1.md'), 'utf8');
      assert.match(md, /^## protected: FAILED$/m);
      assert.ok(md.includes(`- \`.forge/config.yml\`: rule 7 (.forge/config.yml): ${CONFIG_REASON}`), md);
      const job = JSON.parse(fs.readFileSync(path.join(j.dir, 'job.json'), 'utf8'));
      assert.equal(job.verifyRuns.at(-1).failure, 'protected');
      const ev = s.events(j.dir).filter((e) => e.type === 'protected-path');
      assert.deepEqual(ev.map((e) => [e.gate, e.action, e.blocked]), [['verify', 'refuse', true]]);
    } finally {
      s.cleanup();
      fs.rmSync(mark, { force: true });
    }
  });

  test('verify flags an escalate path committed outside forge git', async () => {
    const s = scratch();
    const mark = path.join(s.repo.dir, '..', `mark-${path.basename(s.repo.dir)}`);
    try {
      const j = await s.job();
      write(j.wt, 'Dockerfile', 'FROM scratch\n');
      commitAll(j.wt, 'plain git');
      const r = await s.json(['verify', j.id], { FORGE_TEST_MARK: mark });
      assert.equal(r.status, 0, `${r.stderr}${JSON.stringify(r.out)}`);
      assert.equal(r.out.ok, true);
      assert.deepEqual(r.out.protected, { ok: true, refused: [], escalated: ['Dockerfile'], more: 0 });
      assert.equal(r.out.steps.find((st: any) => st.name === 'protected').reason, '1 protected paths need a human');
      assert.equal(fs.existsSync(mark), true, 'the configured command ran');
      const flag = s.flag(j.dir);
      assert.deepEqual([flag.gate, flag.head, flag.hits[0].path, flag.hits[0].rule], ['verify', git(j.wt, 'rev-parse', 'HEAD'), 'Dockerfile', 2]);
      assert.match(fs.readFileSync(path.join(j.dir, 'verify', 'round-1.md'), 'utf8'), /^## protected: ok$/m);
      assert.match(fs.readFileSync(path.join(j.dir, 'protected.diff'), 'utf8'), /^\+FROM scratch$/m);
    } finally {
      s.cleanup();
      fs.rmSync(mark, { force: true });
    }
  });

  test('pr open re-checks the full diff', async () => {
    const s = scratch();
    const bin = path.join(s.repo.dir, '..', `fakebin-${path.basename(s.repo.dir)}`);
    const bare = path.join(s.repo.dir, '..', `remote-${path.basename(s.repo.dir)}.git`);
    try {
      fs.mkdirSync(bin);
      const ghLog = path.join(bin, 'gh.log');
      fs.writeFileSync(ghLog, '');
      fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$*" >> "${ghLog}"\nexit 1\n`, { mode: 0o755 });
      execFileSync('git', ['init', '-q', '--bare', bare]);
      git(s.repo.dir, 'remote', 'add', 'origin', bare);
      git(s.repo.dir, 'push', '-q', 'origin', 'main');
      const env = { PATH: `${bin}:${process.env.PATH}` };
      const pushed = () => execFileSync('git', ['ls-remote', '--heads', bare], { encoding: 'utf8' }).includes('forge/');
      const gh = () => fs.readFileSync(ghLog, 'utf8');

      // (a) An escalate path committed by plain git on a verified HEAD: refused before gh, flag at the pr gate.
      const j = await s.job();
      write(j.wt, 'Dockerfile', 'FROM scratch\n');
      commitAll(j.wt, 'plain git');
      assert.equal((await s.json(['verify', j.id])).status, 0);
      const before = s.flag(j.dir);
      let r = await s.json(['pr', 'open', j.id], env);
      assert.equal(r.status, 1, r.stderr);
      assert.equal(r.err.code, 'protected_path');
      assert.equal(r.err.message, `protected paths need a human approval: 1 paths; /forge approve ${j.id}`);
      assert.equal(gh(), '', 'gh was never called');
      assert.equal(pushed(), false, 'nothing was pushed');
      assert.equal(s.flag(j.dir).gate, 'pr');
      assert.equal(s.flag(j.dir).at, before.at, 'the same content keeps at');

      // (b) A human approve at the PP1 park lets it through to gh.
      await s.f('job', 'set', j.id, '--state', 'waiting', '--waiting-on', 'human', '--reason', 'protected paths: Dockerfile');
      await s.f('job', 'human', j.id, 'approve');
      await s.f('job', 'set', j.id, '--state', 'running');
      r = await s.json(['pr', 'open', j.id], env);
      assert.notEqual(r.err?.code, 'protected_path', JSON.stringify(r.out));
      assert.notEqual(gh(), '', 'gh was called');

      // (e) A hand-cleared flag changes nothing: the set is recomputed and at moves.
      fs.writeFileSync(ghLog, '');
      const file = path.join(j.dir, 'job.json');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), protectedPaths: null }));
      r = await s.json(['pr', 'open', j.id], env);
      assert.equal(r.err?.code, 'protected_path', JSON.stringify(r.out));
      assert.equal(gh(), '');

      // (c) A refuse path on a HEAD marked verified (by a Forge without the policy, say) exits before gh.
      const k = await s.job();
      fs.appendFileSync(path.join(k.wt, '.forge/config.yml'), '# loosened\n');
      commitAll(k.wt, 'plain git');
      const head = git(k.wt, 'rev-parse', 'HEAD');
      const kfile = path.join(k.dir, 'job.json');
      const kjob = JSON.parse(fs.readFileSync(kfile, 'utf8'));
      kjob.verifyRuns.push({ round: 1, attempt: 1, sha: head, ok: true, at: new Date().toISOString(), file: 'verify/round-1.md', failure: null });
      fs.writeFileSync(kfile, JSON.stringify(kjob));
      r = await s.json(['pr', 'open', k.id], env);
      assert.equal(r.err?.code, 'protected_path', JSON.stringify(r.out));
      assert.match(r.err.message, /^forge pr open refuses protected paths:\n {2}\.forge\/config\.yml: rule 7/);
      assert.equal(gh(), '');
      assert.deepEqual(s.events(k.dir).filter((e) => e.type === 'protected-path').map((e) => [e.gate, e.action, e.blocked]), [['pr', 'refuse', true]]);

      // (d) --force on an unverified HEAD does not skip it.
      write(k.wt, 'src/b.ts', 'export const b = 2;\n');
      commitAll(k.wt, 'one more');
      r = await s.json(['pr', 'open', k.id, '--force'], env);
      assert.equal(r.err?.code, 'protected_path', JSON.stringify(r.out));
      assert.equal(gh(), '');
      assert.equal(pushed(), false, 'nothing was pushed');
    } finally {
      s.cleanup();
      fs.rmSync(bin, { recursive: true, force: true });
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  test('pr open pushes the commit it checked, never a later HEAD', { skip: process.platform === 'win32' }, async () => {
    const s = scratch();
    const bin = path.join(s.repo.dir, '..', `racebin-${path.basename(s.repo.dir)}`);
    const bare = path.join(s.repo.dir, '..', `raceremote-${path.basename(s.repo.dir)}.git`);
    try {
      fs.mkdirSync(bin);
      // gh reports an open PR for the branch, so pr open records pushedSha and returns.
      fs.writeFileSync(
        path.join(bin, 'gh'),
        `#!/bin/sh\ncase "$1 $2" in\n  "repo view") echo o/r ;;\n  "pr list") printf '[{"number":7,"url":"https://github.com/o/r/pull/7","state":"OPEN","isDraft":false,"isCrossRepository":false,"headRefName":"%s","baseRefName":"main"}]' "$RACE_BRANCH" ;;\nesac\n`,
        { mode: 0o755 },
      );
      // A stand-in git: the first \`rev-list --count\` (after every check) commits a refuse path in the
      // worktree, as a stale session or a leftover background process could.
      const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      fs.writeFileSync(
        path.join(bin, 'git'),
        `#!/bin/sh\nif [ -n "$RACE_WT" ] && [ "$1" = rev-list ] && [ "$2" = --count ] && [ ! -e "$RACE_MARK" ]; then\n  : > "$RACE_MARK"\n  echo "# raced" >> "$RACE_WT/.forge/config.yml"\n  "${real}" -C "$RACE_WT" -c user.email=t@e.st -c user.name=T commit -qam raced\nfi\nexec "${real}" "$@"\n`,
        { mode: 0o755 },
      );
      execFileSync('git', ['init', '-q', '--bare', bare]);
      git(s.repo.dir, 'remote', 'add', 'origin', bare);
      git(s.repo.dir, 'push', '-q', 'origin', 'main');
      const remoteSha = (branch: string) => execFileSync('git', ['ls-remote', bare, `refs/heads/${branch}`], { encoding: 'utf8' }).split('\t')[0] || null;
      const jobJson = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));
      const race = (j: { wt: string; dir: string }) => ({ PATH: `${bin}:${process.env.PATH}`, RACE_WT: j.wt, RACE_MARK: path.join(j.dir, 'race.mark'), RACE_BRANCH: jobJson(j.dir).branch });

      // (a) No scrub: the checked HEAD is pushed and recorded, the raced commit stays local.
      const j = await s.job();
      write(j.wt, 'src/a.ts', 'export const a = 1;\n');
      commitAll(j.wt, 'feat: a');
      assert.equal((await s.json(['verify', j.id])).status, 0);
      const checked = git(j.wt, 'rev-parse', 'HEAD');
      let r = await s.json(['pr', 'open', j.id], race(j));
      assert.equal(r.status, 0, `${r.stderr}${JSON.stringify(r.out)}`);
      assert.notEqual(git(j.wt, 'rev-parse', 'HEAD'), checked, 'the race commit landed');
      assert.equal(remoteSha(jobJson(j.dir).branch), checked, 'the remote got the checked commit');
      assert.equal(jobJson(j.dir).pr.pushedSha, checked, 'pushedSha is the checked commit');

      // (b) A scrub starts from the checked commit, and a moved branch stops it before the push.
      const k = await s.job();
      const branch = jobJson(k.dir).branch;
      write(k.wt, 'src/b.ts', 'export const b = 1;\n');
      commitAll(k.wt, 'feat: b\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
      assert.equal((await s.json(['verify', k.id])).status, 0);
      const kChecked = git(k.wt, 'rev-parse', 'HEAD');
      r = await s.json(['pr', 'open', k.id], race(k));
      assert.equal(r.status, 1, JSON.stringify(r.out));
      assert.match(r.err.message, /moved off .* nothing was pushed/);
      assert.equal(remoteSha(branch), null, 'nothing was pushed');

      // (c) Without the race the scrubbed commit is pushed: its tree is the checked one.
      git(k.wt, 'reset', '-q', '--hard', kChecked);
      r = await s.json(['pr', 'open', k.id], { ...race(k), RACE_WT: '' });
      assert.equal(r.status, 0, `${r.stderr}${JSON.stringify(r.out)}`);
      const pushed = jobJson(k.dir).pr.pushedSha;
      assert.equal(remoteSha(branch), pushed);
      assert.notEqual(pushed, kChecked, 'the message was scrubbed');
      assert.equal(git(k.wt, 'rev-parse', `${pushed}^{tree}`), git(k.wt, 'rev-parse', `${kChecked}^{tree}`));
      assert.equal(git(k.wt, 'rev-parse', 'HEAD'), pushed, 'the branch follows the scrub');
    } finally {
      s.cleanup();
      fs.rmSync(bin, { recursive: true, force: true });
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
