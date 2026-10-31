// forge verify and the check cache (./cache.ts): a pass `forge run` or an earlier verify recorded for
// the same command on the same clean committed tree is reused, anything else runs; and `--fast`, the
// partial run that verifies nothing. Through the CLI in-process, on a scratch repo whose commands
// count their runs in files under <root>/.git/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, editConfigFile, forgeInProcess, repoTemplate } from '../../../test/helpers.ts';
import { twoRepo } from '../../../test/job-repos-fixture.ts';
import { jobDir, loadJob, readEvents } from '#core/job/store.ts';
import { verifiedHead } from './gate.ts';

// Each run appends a line to count-<name>, then fails while fail-<name> exists.
const counted = (name: string, args = true) => `echo ${name}${args ? ' {args}' : ''} >> {root}/.git/count-${name} && [ ! -e {root}/.git/fail-${name} ]`;
const COMMANDS = { build: counted('build'), lint: counted('lint', false), test: counted('test') };

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '..', `answers-${path.basename(dir)}.json`);
  fs.writeFileSync(answers, JSON.stringify({ commands: COMMANDS, verify: ['build', ['lint', 'test']], worktrees: { root: '../{repo}.wt' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
  fs.writeFileSync(path.join(dir, 'old.test.ts'), 'export {};\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

/** A copy of the template with one job in round 1 and its worktree. */
async function scratch(t: { after: (fn: () => void) => void }) {
  const r = template();
  const root = r.dir;
  t.after(() => {
    r.cleanup();
    fs.rmSync(`${root}.wt`, { recursive: true, force: true });
  });
  const cli = async (args: string[], env?: NodeJS.ProcessEnv) => forgeInProcess(root, args, env ? { env } : {});
  const ok = async (args: string[], env?: NodeJS.ProcessEnv): Promise<any> => {
    const res = await cli(args, env);
    assert.equal(res.status, 0, `forge ${args.join(' ')}: ${JSON.stringify(res.error ?? res.data)}`);
    return res.data;
  };
  const id: string = (await ok(['job', 'new', '--title', 'check cache'])).id;
  await ok(['worktree', 'create', id]);
  await ok(['job', 'round', id]);
  const wt = loadJob(root, id).worktree!;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: wt, stdio: 'pipe', encoding: 'utf8' });
  const marker = (name: string) => path.join(root, '.git', name);
  return {
    root,
    id,
    wt,
    git,
    ok,
    cli,
    count: (name: string) => (fs.existsSync(marker(`count-${name}`)) ? fs.readFileSync(marker(`count-${name}`), 'utf8').split('\n').filter(Boolean).length : 0),
    fail: (name: string, on: boolean) => (on ? fs.writeFileSync(marker(`fail-${name}`), '') : fs.rmSync(marker(`fail-${name}`), { force: true })),
    commit: (files: Record<string, string | null>) => {
      for (const [rel, text] of Object.entries(files)) {
        if (text === null) fs.rmSync(path.join(wt, rel));
        else fs.writeFileSync(path.join(wt, rel), text);
      }
      git('add', '-A');
      git('commit', '-qm', 'work');
    },
    /** `forge run`, which may exit non-zero. */
    run: async (args: string[], env?: NodeJS.ProcessEnv) => (await cli(['run', id, ...args], env)).data as any,
    /** `forge verify`, which may exit non-zero: its result. */
    verify: async (...extra: string[]) => (await cli(['verify', id, ...extra])).data as any,
    cacheFile: path.join(root, '.forge', 'runtime', 'checks', `${id}.jsonl`),
  };
}
type Scratch = Awaited<ReturnType<typeof scratch>>;

const stepOf = (r: any, name: string) => r.steps.find((s: any) => s.name === name);

test('verify reuses a pass recorded on the same clean tree', async (t) => {
  const s = await scratch(t);
  const run = await s.run(['build']);
  assert.equal(run.ok, true);
  assert.equal(s.count('build'), 1);

  const first = await s.verify();
  assert.equal(first.ok, true, JSON.stringify(first.steps));
  assert.equal(s.count('build'), 1, 'verify did not run build');
  assert.deepEqual([s.count('lint'), s.count('test')], [1, 1]);
  const build = stepOf(first, 'build');
  assert.equal(build.cached, true);
  assert.equal(build.durationMs, 0);
  assert.equal(build.log, run.log, "the original run's log");
  assert.equal(typeof build.cachedAt, 'string');
  assert.equal(build.cachedDurationMs, run.durationMs);
  assert.equal(stepOf(first, 'lint').cacheMiss, 'none');
  const events = readEvents(s.root, s.id).filter((e) => e.type === 'command' && e.name === 'build');
  assert.deepEqual(
    events.map((e) => e.cached),
    [undefined, true],
  );
  assert.equal(events[1].durationMs, 0, 'no busy span that did not happen');
  assert.equal(events[1].cachedDurationMs, run.durationMs);
  assert.match(fs.readFileSync(path.join(jobDir(s.root, s.id), 'verify', 'round-1.md'), 'utf8'), /## build: ok \(cached: passed on this tree at /);

  const second = await s.verify();
  assert.equal(second.ok, true);
  assert.deepEqual([s.count('build'), s.count('lint'), s.count('test')], [1, 1, 1], "verify's own passes are reused");
  assert.deepEqual(
    second.steps.filter((x: any) => ['build', 'lint', 'test'].includes(x.name)).map((x: any) => x.cached),
    [true, true, true],
  );
});

/** Rewrites the job's one cache entry with `edit` applied. */
const editEntry = (s: Scratch, edit: (e: any) => void) => {
  const lines = fs.readFileSync(s.cacheFile, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const e = JSON.parse(lines[0]);
  edit(e);
  fs.writeFileSync(s.cacheFile, JSON.stringify(e) + '\n');
};

test('verify does not reuse a pass on another tree, command line, environment or targeted run', async (t) => {
  const s = await scratch(t);
  const rows: { row: string; step: string; miss: string; act: () => Promise<void> }[] = [
    {
      row: 'the worktree was dirty during forge run',
      step: 'build',
      miss: 'none',
      act: async () => {
        fs.writeFileSync(path.join(s.wt, 'scratch.txt'), 'x');
        assert.equal((await s.run(['build'])).ok, true);
        fs.rmSync(path.join(s.wt, 'scratch.txt'));
      },
    },
    {
      row: 'a new commit came before verify',
      step: 'build',
      miss: 'tree',
      act: async () => {
        await s.run(['build']);
        s.commit({ 'a.ts': 'export {};\n' });
      },
    },
    {
      row: 'commands.build was edited',
      step: 'build',
      miss: 'command',
      act: async () => {
        await s.run(['build']);
        editConfigFile(s.root, (c) => (c.commands.build = `${COMMANDS.build} && true`));
      },
    },
    { row: 'forge run build -- x', step: 'build', miss: 'none', act: async () => assert.equal((await s.run(['build', '--', 'x'])).ok, true) },
    {
      row: 'forge run test --changed in files mode',
      step: 'test',
      miss: 'none',
      act: async () => {
        s.commit({ 'b.test.ts': 'export {};\n' });
        const r = await s.run(['test', '--changed']);
        assert.equal(r.related.mode, 'files');
        assert.equal(r.ok, true);
      },
    },
    { row: 'forge run under a different PATH', step: 'build', miss: 'env', act: async () => assert.equal((await s.run(['build'], { PATH: `${path.join(s.root, 'nowhere')}${path.delimiter}${process.env.PATH}` })).ok, true) },
    {
      row: 'a command that commits a change while it runs',
      step: 'build',
      miss: 'none',
      act: async () => {
        const plain = loadConfigBuild(s);
        editConfigFile(s.root, (c) => (c.commands.build = `${plain} && echo x >> c.txt && git add c.txt && git commit -qm during`));
        assert.equal((await s.run(['build'])).ok, true);
        editConfigFile(s.root, (c) => (c.commands.build = plain));
      },
    },
    {
      row: 'a skip-worktree flag on a tracked file during forge run',
      step: 'build',
      miss: 'none',
      act: async () => {
        s.git('update-index', '--skip-worktree', 'README.md');
        assert.equal((await s.run(['build'])).ok, true);
        s.git('update-index', '--no-skip-worktree', 'README.md');
      },
    },
    {
      row: 'a forge run that failed',
      step: 'build',
      miss: 'none',
      act: async () => {
        s.fail('build', true);
        assert.equal((await s.run(['build'])).ok, false);
        s.fail('build', false);
      },
    },
    {
      row: 'a verify step that failed',
      step: 'test',
      miss: 'none',
      act: async () => {
        s.fail('test', true);
        const r = await s.verify();
        assert.equal(r.failure.name, 'test');
        s.fail('test', false);
      },
    },
    // AC4: a hostile or broken cache file reads as no pass.
    {
      row: 'the cache file is a symlink to a valid entry',
      step: 'build',
      miss: 'none',
      act: async () => {
        await s.run(['build']);
        const real = path.join(s.root, '.git', 'planted.jsonl');
        fs.renameSync(s.cacheFile, real);
        fs.symlinkSync(real, s.cacheFile);
      },
    },
    {
      row: 'a line is not JSON',
      step: 'build',
      miss: 'none',
      act: async () => {
        await s.run(['build']);
        fs.writeFileSync(s.cacheFile, fs.readFileSync(s.cacheFile, 'utf8').slice(0, -3) + '\n');
      },
    },
    { row: 'tree is not hex', step: 'build', miss: 'none', act: async () => (await s.run(['build']), editEntry(s, (e) => (e.tree = 'HEAD^{tree}'))) },
    { row: 'log is outside logs/', step: 'build', miss: 'none', act: async () => (await s.run(['build']), editEntry(s, (e) => (e.log = '../job.json'))) },
    { row: 'at is in the future', step: 'build', miss: 'none', act: async () => (await s.run(['build']), editEntry(s, (e) => (e.at = new Date(Date.now() + 3_600_000).toISOString()))) },
    { row: 'at is more than 24 h old', step: 'build', miss: 'none', act: async () => (await s.run(['build']), editEntry(s, (e) => (e.at = new Date(Date.now() - 25 * 3_600_000).toISOString()))) },
  ];
  for (const r of rows) {
    // Each row starts with no pass: what it records is all verify can find.
    fs.rmSync(s.cacheFile, { force: true });
    await r.act();
    const before = s.count(r.step);
    const v = await s.verify();
    assert.equal(s.count(r.step), before + 1, `${r.row}: verify ran ${r.step}`);
    const step = stepOf(v, r.step);
    assert.equal(step.cached, undefined, r.row);
    assert.equal(step.cacheMiss, r.miss, r.row);
    assert.equal(v.ok, true, `${r.row}: ${JSON.stringify(v.failure)}`);
  }
});

/** The configured build command as config.yml holds it now. */
function loadConfigBuild(s: Scratch): string {
  let build = '';
  editConfigFile(s.root, (c) => (build = c.commands.build));
  return build;
}

test('the gates run and member repos skip the cache when steps are cached', async (t) => {
  const s = await scratch(t);
  editConfigFile(s.root, (c) => (c.verifyIntegrity = 'block'));
  s.commit({ 'old.test.ts': null });
  for (const c of ['build', 'lint', 'test']) assert.equal((await s.run([c])).ok, true, c);
  const v = await s.verify();
  assert.deepEqual([s.count('build'), s.count('lint'), s.count('test')], [1, 1, 1], 'every configured step was a hit');
  assert.deepEqual(
    v.steps.filter((x: any) => ['build', 'lint', 'test'].includes(x.name)).map((x: any) => x.cached),
    [true, true, true],
  );
  assert.ok(v.secrets && v.protected && v.integrity, 'secrets, protected and integrity were computed');
  assert.equal(v.ok, false);
  assert.equal(v.failure.name, 'integrity', 'a deleted test still fails the run');

  const p = await twoRepo();
  t.after(p.cleanup);
  const id = (await p.f('job', 'new', '--title', 'members')).id;
  await p.f('job', 'repo', 'add', id, 'lib');
  await p.f('worktree', 'create', id);
  await p.f('job', 'round', id);
  const cacheFile = path.join(p.root, '.forge', 'runtime', 'checks', `${id}.jsonl`);
  assert.equal((await forgeInProcess(p.root, ['run', id, 'test'])).status, 0);
  assert.equal(fs.existsSync(cacheFile), false, 'a job with member repos records no pass');
  const mv = (await forgeInProcess(p.root, ['verify', id])).data as any;
  assert.equal(stepOf(mv, 'test').cacheMiss, 'unsupported');
  assert.equal(fs.existsSync(cacheFile), false);
});

test('verify --fast records a partial pass that verifies nothing', async (t) => {
  const s = await scratch(t);
  const runs = () => loadJob(s.root, s.id).verifyRuns;
  const refused = await s.cli(['verify', s.id, '--fast=1']);
  assert.equal(refused.status, 1);
  assert.match(refused.error!.message, /--fast/);
  assert.equal((await s.cli(['verify', s.id, '--fast', 'now'])).status, 1);
  assert.deepEqual(runs(), [], 'a refused --fast records nothing');

  const fast = await s.verify('--fast');
  assert.equal(fast.ok, true, JSON.stringify(fast.failure));
  assert.equal(fast.partial, true);
  assert.deepEqual(fast.pending, ['lint', 'test']);
  assert.deepEqual([s.count('build'), s.count('lint'), s.count('test')], [1, 0, 0]);
  assert.deepEqual(
    runs().map((r) => [r.partial, r.ok]),
    [[true, true]],
  );
  assert.equal(verifiedHead(s.root, s.id).verified, false, 'a partial pass verifies no HEAD');
  assert.equal(loadJob(s.root, s.id).verify?.[1], undefined, 'nor the legacy round result');
  assert.match(fs.readFileSync(path.join(jobDir(s.root, s.id), 'verify', 'round-1.md'), 'utf8'), /^VERIFY: PASS \(partial\)/);

  const full = await s.verify();
  assert.equal(full.ok, true);
  assert.equal(full.partial, undefined);
  assert.equal(stepOf(full, 'build').cached, true);
  assert.deepEqual([s.count('build'), s.count('lint'), s.count('test')], [1, 1, 1]);
  assert.equal(verifiedHead(s.root, s.id).verified, true);

  editConfigFile(s.root, (c) => (c.verify = ['build']));
  const one = await s.verify('--fast');
  assert.equal(one.partial, undefined, 'one group: --fast runs everything');
  assert.equal(runs().at(-1)!.partial, undefined);
  assert.equal(verifiedHead(s.root, s.id).verified, true);
  assert.ok(
    runs().every((r) => typeof r.durationMs === 'number'),
    'every run records its duration',
  );
});
