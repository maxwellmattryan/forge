// The output mode (docs/CLI.md "Output mode"): resolving it, stripping --mode, and human output.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, forgeInProcess, repoTemplate } from './helpers.ts';
import { loadConfig } from '../lib/core/config/load.ts';
import { forgeVersion } from '../lib/evals.ts';
import { ForgeError } from '../lib/core/errors.ts';
import { dispatch } from '../lib/cli.ts';
import { lenientOutputMode, out, outputMode, parseArgs, renderKeyOf, resolveOutputMode, setOutputMode, setRenderKey, withoutMode } from '../lib/commands/args.ts';
import { GLOBAL_FLAGS, GROUPS, renderCommand, renderOverview, reportError, toCliError } from '../lib/commands/help.ts';
import { renderError } from '../lib/commands/render.ts';
import { renderKey } from '../lib/commands/render/index.ts';
import { versionCmd } from '../lib/commands/version.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

const repo = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'none' }, pr: { enabled: false }, worktrees: { root: '../{repo}.wt' } }));
  const bin = path.join(ROOT, 'bin', 'forge');
  execFileSync(process.execPath, [bin, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  execFileSync(process.execPath, [bin, 'job', 'new', '--title', 'Mode job', '--ref', 'mode-job'], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

/**
 * Runs `fn` with process.stdout and process.stderr writes collected (Buffer chunks, which carry the
 * test runner's own reports, pass through) and returns what it wrote. Restores both in finally.
 */
function capture(fn: () => void): { stdout: string; stderr: string } {
  const got = { stdout: '', stderr: '' };
  const writes = { stdout: process.stdout.write, stderr: process.stderr.write };
  for (const name of ['stdout', 'stderr'] as const) {
    const stream = process[name];
    const original = writes[name];
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk !== 'string') return (original as (...a: unknown[]) => boolean).call(stream, chunk, ...rest);
      got[name] += chunk;
      return true;
    }) as typeof stream.write;
  }
  try {
    fn();
  } finally {
    process.stdout.write = writes.stdout;
    process.stderr.write = writes.stderr;
  }
  return got;
}

/**
 * One call as main() makes it, in-process: `mode` stands for what main resolved, --mode is
 * stripped, the render key comes from the argv, and the result goes through out(). Returns stdout;
 * restores the mode and render key in finally.
 */
async function inMode(root: string, mode: 'human' | 'agent', argv: string[]): Promise<string> {
  const prevMode = outputMode();
  const prevKey = renderKeyOf();
  try {
    setOutputMode(mode);
    const args = withoutMode(argv);
    const { pos, flags } = parseArgs(args);
    setRenderKey(renderKey(pos));
    // version is routed by main(), before dispatch.
    if (pos[0] === 'version') return capture(() => versionCmd(flags)).stdout;
    const { config, initialized } = loadConfig(root);
    const d = await dispatch(args, { root, config, initialized });
    assert.equal(d.exitCode ?? 0, 0, argv.join(' '));
    return capture(() => out(d.data, flags)).stdout;
  } finally {
    setOutputMode(prevMode);
    setRenderKey(prevKey);
  }
}

/** The error a call throws, as main() would report it under `argv` (stdout and stderr). */
async function reported(root: string, argv: string[]): Promise<{ stdout: string; stderr: string; exit: number }> {
  const { config, initialized } = loadConfig(root);
  const err = await dispatch(withoutMode(argv), { root, config, initialized }).then(() => assert.fail(`${argv.join(' ')} did not throw`), (e: unknown) => e);
  let exit = 0;
  const got = capture(() => {
    exit = reportError(err, argv);
  });
  return { ...got, exit };
}

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
  assert.equal(resolveOutputMode(['job', 'show', '--mode', 'human', 'mode-job'], {}, false), 'human', '--mode takes its value, not the positional after it');
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
  try {
    setOutputMode('agent');
    const { config, initialized } = loadConfig(r.dir);
    const d = await dispatch(['job', 'list', '--mode', 'human'], { root: r.dir, config, initialized });
    assert.equal(outputMode(), 'agent');
    const printed = capture(() => out(d.data, {})).stdout;
    assert.equal(JSON.parse(printed)[0].id, 'mode-job');
  } finally {
    setOutputMode(prev);
    r.cleanup();
  }
});

test('help documents --mode', () => {
  const overview = renderOverview();
  const usageLine = overview.split('\n').find((l) => l.startsWith('Usage: forge'));
  assert.ok(usageLine?.includes('[--mode human|agent]'), usageLine);
  const globals = overview.slice(overview.indexOf('Global flags:'));
  assert.match(globals, /\n {2}--mode human\|agent +output for a terminal/);
  assert.ok(GLOBAL_FLAGS.some(([f]) => f === '--mode human|agent'));
  for (const g of GROUPS) for (const c of g.commands) assert.ok(renderCommand(c).includes('--mode human|agent'), c.command);
});

// In-process, outside any concurrent block: these set the module-wide output mode and render key.
test('human mode renders results; --mode does not swallow a positional', async () => {
  const r = repo();
  try {
    const agentShow = await inMode(r.dir, 'agent', ['job', 'show', '--mode', 'agent', 'mode-job']);
    assert.equal(JSON.parse(agentShow).id, 'mode-job');
    const show = await inMode(r.dir, 'human', ['job', 'show', '--mode', 'human', 'mode-job']);
    assert.equal(show.split('\n')[0], 'mode-job  Mode job');
    assert.match(show, /^Stage$/m);

    const version = await inMode(r.dir, 'human', ['version', '--mode', 'human']);
    assert.equal(version, `forge ${forgeVersion()}\n`);
    assert.deepEqual(JSON.parse(await inMode(r.dir, 'agent', ['version'])), { version: forgeVersion() });

    const rows = JSON.parse(await inMode(r.dir, 'agent', ['job', 'list']));
    const list = await inMode(r.dir, 'human', ['job', 'list', '--mode', 'human']);
    assert.ok(list.startsWith(Object.keys(rows[0])[0] + ' '), list);
    assert.match(list, /\nmode-job +backlog +.* Mode job$/m);

    const status = await inMode(r.dir, 'human', ['status', '--mode', 'human']);
    assert.match(status, /^job +stage +state +round +tasks +pr +session\n/);
    assert.match(status, /\nmode-job +backlog +/);
    for (const s of [version, list, status]) assert.doesNotMatch(s, /[{"\x1b]/);

    const agentPath = await inMode(r.dir, 'agent', ['worktree', 'path', 'mode-job']);
    assert.equal(await inMode(r.dir, 'human', ['worktree', 'path', 'mode-job', '--mode', 'human']), agentPath, 'worktree path is the same in both modes');

    // --json beats human: main resolves agent, and out() prints JSON whatever the mode.
    assert.equal(resolveOutputMode(['job', 'show', 'mode-job', '--mode', 'human', '--json'], {}, true), 'agent');
    assert.equal(JSON.parse(await inMode(r.dir, 'human', ['job', 'show', 'mode-job', '--json'])).id, 'mode-job');
  } finally {
    r.cleanup();
  }
});

test('human mode errors: error and fix lines', async () => {
  const r = repo();
  try {
    const nope = await reported(r.dir, ['job', 'show', 'nope', '--mode', 'human']);
    assert.equal(nope.exit, 1);
    assert.equal(nope.stdout, '');
    assert.match(nope.stderr, /^error: no job "nope"[^\n]*\n$/);

    // --json beats human for errors too: one JSON line on stdout, nothing on stderr.
    const json = await reported(r.dir, ['job', 'show', 'nope', '--mode', 'human', '--json']);
    assert.equal(json.exit, 1);
    assert.equal(json.stderr, '');
    assert.equal(JSON.parse(json.stdout).error.code, 'not_found');

    // A bad --mode under FORGE_MODE=human is reported in human mode, with the command's help as the fix.
    const argv = ['job', 'show', 'mode-job', '--mode', 'loud'];
    assert.equal(lenientOutputMode(argv, { FORGE_MODE: 'human' }, false), 'human');
    const err = (() => {
      try {
        resolveOutputMode(argv, { FORGE_MODE: 'human' }, false);
      } catch (e) {
        return e;
      }
      return assert.fail('a bad --mode must throw');
    })();
    const e = toCliError(err, argv);
    assert.equal(e.exit, 2);
    assert.match(renderError(e, { color: false }), /^error: unknown output mode "loud" \(human, agent\)\nfix: forge help job show\n$/);
  } finally {
    r.cleanup();
  }
});

describe('the CLI in each mode', { concurrency: 4 }, () => {
  test('forge --mode <id> is refused, not help', async () => {
    const r = repo();
    try {
      const res = await forgeAsync(r.dir, ['--mode', 'job-12']);
      assert.equal(res.status, 2);
      assert.doesNotMatch(res.stdout + res.stderr, /Usage: forge/, 'no help');
      assert.match(res.stdout + res.stderr, /unknown output mode \\?"job-12\\?" \(human, agent\)/);
    } finally {
      r.cleanup();
    }
  });

  test('human mode renders a result', async () => {
    const r = repo();
    try {
      const rows = (await forgeInProcess(r.dir, ['job', 'list'])).data as Record<string, unknown>[];
      const list = await forgeAsync(r.dir, ['job', 'list', '--mode', 'human']);
      assert.equal(list.status, 0, list.stderr);
      assert.ok(list.stdout.startsWith(Object.keys(rows[0])[0] + ' '), list.stdout);
      assert.match(list.stdout, /\nmode-job +backlog +.* Mode job$/m);
    } finally {
      r.cleanup();
    }
  });

  test('human mode reports an error with error and fix lines', async () => {
    const r = repo();
    try {
      const claim = await forgeAsync(r.dir, ['job', 'claim', 'mode-job', '--mode', 'human']);
      assert.equal(claim.status, 2);
      assert.equal(claim.stdout, '');
      assert.match(claim.stderr, /^error: [^\n]+\nfix: forge help job claim\n$/);
    } finally {
      r.cleanup();
    }
  });

  test('FORGE_MODE=human selects human output', async () => {
    const r = repo();
    try {
      const version = await forgeAsync(r.dir, ['version'], { FORGE_MODE: 'human' });
      assert.equal(version.status, 0, version.stderr);
      assert.equal(version.stdout, `forge ${forgeVersion()}\n`);
    } finally {
      r.cleanup();
    }
  });
});
