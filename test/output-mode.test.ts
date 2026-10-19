// The output mode (docs/CLI.md "Output mode"): resolving it, stripping --mode, and human output.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, repoTemplate } from './helpers.ts';
import { loadConfig } from '../lib/config.ts';
import { ForgeError } from '../lib/util.ts';
import { dispatch } from '../lib/cli.ts';
import { lenientOutputMode, out, outputMode, resolveOutputMode, setOutputMode, withoutMode } from '../lib/commands/args.ts';
import { GLOBAL_FLAGS, GROUPS, renderCommand, renderOverview } from '../lib/commands/help.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

const repo = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'none' }, pr: { enabled: false }, worktrees: { root: '../{repo}.wt' } }));
  const bin = path.join(ROOT, 'bin', 'forge');
  execFileSync(process.execPath, [bin, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  execFileSync(process.execPath, [bin, 'job', 'new', '--title', 'Mode job', '--ref', 'mode-job'], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

test('helpers pin agent mode', () => {
  assert.equal(process.env.FORGE_MODE, 'agent');
});

test('resolveOutputMode: precedence', () => {
  assert.equal(resolveOutputMode(['job', 'list', '--json', '--mode', 'human'], {}, true), 'agent', '--json beats --mode human');
  assert.equal(resolveOutputMode(['--mode=human', '--json'], { FORGE_MODE: 'human' }, true), 'agent');
  assert.equal(resolveOutputMode(['--mode', 'human'], { FORGE_MODE: 'agent' }, false), 'human', '--mode beats FORGE_MODE');
  assert.equal(resolveOutputMode(['--mode=agent'], { FORGE_MODE: 'human' }, true), 'agent');
  assert.equal(resolveOutputMode(['version'], { FORGE_MODE: 'human' }, false), 'human', 'FORGE_MODE=human with no TTY');
  assert.equal(resolveOutputMode(['version'], { FORGE_MODE: 'agent' }, true), 'agent');
  assert.equal(resolveOutputMode(['version'], { FORGE_MODE: '' }, true), 'human', 'an empty FORGE_MODE counts as unset');
  assert.equal(resolveOutputMode(['version'], {}, true), 'human', 'a terminal gets human');
  assert.equal(resolveOutputMode(['version'], {}, false), 'agent', 'a pipe gets agent');
  assert.equal(resolveOutputMode(['run', 'x', 'test', '--', '--mode', 'human'], {}, false), 'agent', '--mode after -- is ignored');
  assert.equal(resolveOutputMode(['run', 'x', 'test', '--', '--mode=fancy', '--json'], {}, true), 'human', 'nothing after -- counts');
});

test('resolveOutputMode: bad values are usage errors', () => {
  const bad: [string[], NodeJS.ProcessEnv][] = [
    [['--mode'], {}],
    [['job', 'list', '--mode'], {}],
    [['--mode', '--json'], {}],
    [['--mode', 'human', '--mode', 'agent'], {}],
    [['--mode=human', '--mode=human'], {}],
    [['--mode='], {}],
    [['--mode=fancy'], {}],
    [['--mode', 'job-12'], {}],
    [['version'], { FORGE_MODE: 'loud' }],
  ];
  for (const [argv, env] of bad) {
    for (const args of [argv, [...argv, '--json']]) {
      assert.throws(
        () => resolveOutputMode(args, env, true),
        (e: unknown) => e instanceof ForgeError && e.code === 'usage' && e.exitCode === 2 && e.message.includes('human, agent'),
        `${args.join(' ')} ${JSON.stringify(env)}`,
      );
      // Reporting the error must not throw on the same value.
      assert.doesNotThrow(() => lenientOutputMode(args, env, true));
    }
  }
  assert.throws(() => resolveOutputMode(['--mode', 'job-12'], {}, false), /unknown output mode "job-12" \(human, agent\)/);
  assert.throws(() => resolveOutputMode([], { FORGE_MODE: 'loud' }, false), /unknown FORGE_MODE "loud" \(human, agent\)/);
  assert.equal(lenientOutputMode(['--mode=fancy'], { FORGE_MODE: 'human' }, false), 'human', 'a bad flag falls through to FORGE_MODE');
  assert.equal(lenientOutputMode([], { FORGE_MODE: 'loud' }, true), 'human', 'a bad FORGE_MODE falls through to the TTY');
});

test('withoutMode strips only Forge\'s flag', () => {
  assert.deepEqual(withoutMode(['job', 'show', '--mode', 'human', 'x']), ['job', 'show', 'x']);
  assert.deepEqual(withoutMode(['--mode=agent', 'version', '--json']), ['version', '--json']);
  assert.deepEqual(withoutMode(['git', 'log', '--mode', 'human', '-1']), ['git', 'log', '-1']);
  assert.deepEqual(withoutMode(['run', 'x', 'test', '--mode', 'human', '--', 'a', '--mode', 'b', '--mode=c']), ['run', 'x', 'test', '--', 'a', '--mode', 'b', '--mode=c']);
  assert.deepEqual(withoutMode(['job', 'list', '--mode', '--json']), ['job', 'list', '--json'], 'a --flag after a bare --mode stays');
  assert.deepEqual(withoutMode(['job', 'list', '--mode', '--', 'x']), ['job', 'list', '--', 'x'], 'so does --');
  assert.deepEqual(withoutMode(['job', 'list', '--mode']), ['job', 'list']);
  assert.deepEqual(withoutMode(['job', 'set', 'x', '--field', 'a=1', '--moderate', 'y']), ['job', 'set', 'x', '--field', 'a=1', '--moderate', 'y'], 'other flags stay');
});

test('dispatch never re-resolves the mode', async () => {
  const r = repo();
  const prev = outputMode();
  const write = process.stdout.write;
  let printed = '';
  try {
    setOutputMode('agent');
    const { config, initialized } = loadConfig(r.dir);
    const d = await dispatch(['job', 'list', '--mode', 'human'], { root: r.dir, config, initialized });
    assert.equal(outputMode(), 'agent');
    process.stdout.write = ((chunk: string) => {
      printed += chunk;
      return true;
    }) as typeof process.stdout.write;
    out(d.data, {});
    process.stdout.write = write;
    assert.equal(JSON.parse(printed)[0].id, 'mode-job');
  } finally {
    process.stdout.write = write;
    setOutputMode(prev);
    r.cleanup();
  }
});

test('help documents --mode', () => {
  const overview = renderOverview();
  assert.ok(overview.includes('Usage: forge <command> [args] [--json] [--mode human|agent] [--help] [--pretty]'));
  const globals = overview.slice(overview.indexOf('Global flags:'));
  assert.match(globals, /\n {2}--mode human\|agent +output for a terminal/);
  assert.ok(GLOBAL_FLAGS.some(([f]) => f === '--mode human|agent'));
  for (const g of GROUPS) for (const c of g.commands) assert.ok(renderCommand(c).includes('--mode human|agent'), c.command);
});

test('docs name FORGE_MODE', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'docs', 'CLI.md'), 'utf8');
  assert.match(cli, /^## Output mode$/m);
  assert.match(cli, /^\| `FORGE_MODE` \|/m);
  assert.match(cli, /^\| `NO_COLOR` \|/m);
  assert.match(cli, /^\| `CLAUDE_ENV_FILE` \|.*FORGE_MODE=agent/m);
  assert.ok(fs.readFileSync(path.join(ROOT, 'docs', 'PROTOCOL.md'), 'utf8').includes('FORGE_MODE=agent'));
  assert.match(fs.readFileSync(path.join(ROOT, 'docs', 'GLOSSARY.md'), 'utf8'), /\*\*output mode\*\*/);
  assert.ok(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').includes('--mode human|agent'));
});

describe('the CLI in each mode', { concurrency: 4 }, () => {
  test('forge --mode <id> is refused, not help', async () => {
    const r = repo();
    try {
      for (const args of [['--mode', 'job-12'], ['--mode', 'job-12', '--json']]) {
        const res = await forgeAsync(r.dir, args);
        assert.equal(res.status, 2, args.join(' '));
        assert.doesNotMatch(res.stdout + res.stderr, /Usage: forge/, 'no help');
        assert.match(res.stdout + res.stderr, /unknown output mode \\?"job-12\\?" \(human, agent\)/);
      }
      const env = await forgeAsync(r.dir, ['version'], { FORGE_MODE: 'loud' });
      assert.equal(env.status, 2);
      assert.equal(env.stderr, 'forge: unknown FORGE_MODE "loud" (human, agent)\n');
    } finally {
      r.cleanup();
    }
  });

  test('--mode does not swallow a positional', async () => {
    const r = repo();
    try {
      const agent = await forgeAsync(r.dir, ['job', 'show', '--mode', 'agent', 'mode-job']);
      assert.equal(agent.status, 0, agent.stderr);
      assert.equal(JSON.parse(agent.stdout).id, 'mode-job');
      const human = await forgeAsync(r.dir, ['job', 'show', '--mode', 'human', 'mode-job']);
      assert.equal(human.status, 0, human.stderr);
      assert.match(human.stdout, /^id +mode-job$/m);
    } finally {
      r.cleanup();
    }
  });

  test('human mode renders results', async () => {
    const r = repo();
    try {
      const v = JSON.parse((await forgeAsync(r.dir, ['version'])).stdout).version;
      const version = await forgeAsync(r.dir, ['version', '--mode', 'human']);
      assert.equal(version.status, 0, version.stderr);
      assert.equal(version.stdout, `version  ${v}\n`);

      const rows = JSON.parse((await forgeAsync(r.dir, ['job', 'list'])).stdout);
      const list = await forgeAsync(r.dir, ['job', 'list', '--mode', 'human']);
      assert.equal(list.status, 0, list.stderr);
      assert.ok(list.stdout.startsWith(Object.keys(rows[0])[0] + ' '), list.stdout);
      assert.match(list.stdout, /\nmode-job +Mode job/);
      for (const s of [version.stdout, list.stdout]) assert.doesNotMatch(s, /[{"\x1b]/);

      const agentPath = await forgeAsync(r.dir, ['worktree', 'path', 'mode-job']);
      const humanPath = await forgeAsync(r.dir, ['worktree', 'path', 'mode-job', '--mode', 'human']);
      assert.deepEqual(humanPath, agentPath);
      // FORGE_MODE selects it as well as the flag does.
      assert.deepEqual(await forgeAsync(r.dir, ['version'], { FORGE_MODE: 'human' }), version);
    } finally {
      r.cleanup();
    }
  });

  test('human mode errors: error and fix lines', async () => {
    const r = repo();
    try {
      const nope = await forgeAsync(r.dir, ['job', 'show', 'nope', '--mode', 'human']);
      assert.equal(nope.status, 1);
      assert.equal(nope.stdout, '');
      assert.match(nope.stderr, /^error: no job "nope"[^\n]*\n$/);

      const claim = await forgeAsync(r.dir, ['job', 'claim', 'mode-job', '--mode', 'human']);
      assert.equal(claim.status, 2);
      assert.equal(claim.stdout, '');
      assert.match(claim.stderr, /^error: [^\n]+\nfix: forge help job claim\n$/);

      const json = await forgeAsync(r.dir, ['job', 'show', 'nope', '--mode', 'human', '--json']);
      assert.equal(json.status, 1);
      assert.equal(json.stderr, '');
      assert.equal(JSON.parse(json.stdout).error.code, 'not_found');

      const bad = await forgeAsync(r.dir, ['job', 'show', 'mode-job', '--mode', 'loud'], { FORGE_MODE: 'human' });
      assert.equal(bad.status, 2);
      assert.equal(bad.stdout, '');
      assert.match(bad.stderr, /^error: unknown output mode "loud" \(human, agent\)\nfix: forge help job show\n$/);
    } finally {
      r.cleanup();
    }
  });
});
