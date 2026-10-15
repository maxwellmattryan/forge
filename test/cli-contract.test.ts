// The CLI's contract for scripts and other runtimes (docs/CLI.md): exit classes, --json errors,
// JSON success output, and `forge git` keeping Forge's own flags to itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { ConfigSetError } from '../lib/config-fields.ts';
import { DEFAULT_CODE, ERROR_CODES, ForgeError, run } from '../lib/util.ts';
import { GROUPS, findHelp, toCliError } from '../lib/commands/help.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'bin', 'forge');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };

type Run = { status: number | null; stdout: string; stderr: string };

/** The environment the CLI runs in: no inherited FORGE_DEBUG, which would add stacks to stderr. */
function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (!('FORGE_DEBUG' in extra)) delete env.FORGE_DEBUG;
  return env;
}

/** A scratch repo with FORGE_ROOT pinned to it, a stub bin dir, and (after init()) Forge set up. */
function scratch() {
  const repo = tempRepo();
  const tmp = path.dirname(repo.dir);
  const base = path.basename(repo.dir);
  const stubs = path.join(tmp, `stubs-${base}`);
  fs.mkdirSync(stubs);
  const answers = path.join(tmp, `answers-${base}.json`);
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'none' }, pr: { enabled: false }, commands: { test: 'true' }, worktrees: { root: `../${base}.wt` } }));
  const cli = (args: string[], env: Record<string, string> = {}): Run => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env: baseEnv({ FORGE_ROOT: repo.dir, ...env }) });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const json = (args: string[]): any => {
    const r = cli(args);
    assert.equal(r.status, 0, `forge ${args.join(' ')}: ${r.stderr}${r.stdout}`);
    return JSON.parse(r.stdout);
  };
  const init = () => json(['init', 'write', '--answers', answers]);
  /** Writes an executable into the stub dir and returns the PATH that finds it first. */
  const stub = (name: string, script: string): Record<string, string> => {
    fs.writeFileSync(path.join(stubs, name), script, { mode: 0o755 });
    return { PATH: `${stubs}${path.delimiter}${process.env.PATH}` };
  };
  const cleanup = () => {
    repo.cleanup();
    for (const p of [`${repo.dir}.wt`, stubs, answers]) fs.rmSync(p, { recursive: true, force: true });
  };
  return { root: repo.dir, cli, json, init, stub, cleanup };
}

/** One JSON line on stdout, nothing on stderr: the --json error contract. */
function jsonError(r: Run): { code: string; message: string; exit: number; hint: string | null } {
  assert.equal(r.stderr, '', 'nothing on stderr');
  assert.ok(r.stdout.endsWith('\n') && r.stdout.indexOf('\n') === r.stdout.length - 1, `one line: ${JSON.stringify(r.stdout)}`);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(parsed), ['error']);
  assert.deepEqual(Object.keys(parsed.error), ['code', 'message', 'exit', 'hint'], 'keys in order');
  assert.equal(parsed.error.exit, r.status, 'exit equals the process status');
  return parsed.error;
}

interface ErrorCase {
  name: string;
  args: string[];
  env?: Record<string, string>;
  /** Runs in a repo with no .forge/config.yml. */
  uninitialized?: true;
  exit: number;
  code: string;
  hint: string | null;
}

/** The AC1 cases on one scratch repo: a job held by session A, one waiting on a dependency. */
function errorCases(s: ReturnType<typeof scratch>): ErrorCase[] {
  const held = s.json(['job', 'new', '--title', 'Held', '--session', 'A']).id;
  const dep = s.json(['job', 'new', '--title', 'Dependency']).id;
  const blocked = s.json(['job', 'new', '--title', 'Blocked']).id;
  s.json(['job', 'set', blocked, '--field', `dependsOn=["${dep}"]`]);
  const failingGit = s.stub('git', '#!/bin/sh\necho "fatal: stub" >&2\nexit 128\n');
  return [
    { name: 'usage: unknown subcommand', args: ['job', 'bogus'], exit: 2, code: 'usage', hint: 'forge help job' },
    { name: 'usage: missing --session', args: ['job', 'claim', held], exit: 2, code: 'usage', hint: 'forge help job claim' },
    { name: 'unknown_command', args: ['nosuch'], exit: 2, code: 'unknown_command', hint: 'forge help' },
    { name: 'not_initialized', args: ['status'], uninitialized: true, exit: 2, code: 'not_initialized', hint: '/forge init' },
    { name: 'owned', args: ['job', 'claim', held, '--session', 'B'], exit: 3, code: 'owned', hint: null },
    { name: 'blocked', args: ['job', 'claim', blocked, '--session', 'S'], exit: 4, code: 'blocked', hint: null },
    { name: 'external', args: ['worktree', 'prune'], env: failingGit, exit: 5, code: 'external', hint: null },
    { name: 'not_found', args: ['job', 'show', 'no-such-job'], exit: 1, code: 'not_found', hint: null },
  ];
}

function withCases(fn: (cases: ErrorCase[], cli: (c: ErrorCase, extra?: string[], env?: Record<string, string>) => Run) => void): void {
  const s = scratch();
  const bare = scratch();
  try {
    s.init();
    const cases = errorCases(s);
    fn(cases, (c, extra = [], env = {}) => (c.uninitialized ? bare : s).cli([...c.args, ...extra], { ...c.env, ...env }));
  } finally {
    s.cleanup();
    bare.cleanup();
  }
}

test('exit codes follow the table', POSIX, () => {
  withCases((cases, cli) => {
    for (const c of cases) assert.equal(cli(c).status, c.exit, `${c.name}: forge ${c.args.join(' ')}`);
  });
});

test('ForgeError codes and exits', () => {
  const plain = new ForgeError('x');
  assert.equal(plain.code, 'failed');
  assert.equal(plain.exitCode, 1);
  assert.equal(plain.hint, null);
  for (const [n, code] of [[2, 'usage'], [3, 'owned'], [4, 'blocked'], [5, 'external']] as const) {
    const e = new ForgeError('x', n);
    assert.equal(e.code, code, `${n}`);
    assert.equal(e.exitCode, n);
    assert.equal(DEFAULT_CODE[n], code);
  }
  for (const [code, exit] of Object.entries(ERROR_CODES)) {
    const e = new ForgeError('x', code as keyof typeof ERROR_CODES, 'forge help');
    assert.equal(e.code, code);
    assert.equal(e.exitCode, exit, code);
    assert.equal(e.hint, 'forge help');
  }

  const uninit = new ConfigSetError('uninitialized', 'no config');
  assert.equal(uninit.code, 'not_initialized');
  assert.equal(uninit.exitCode, 2);
  for (const reason of ['unknown', 'locked', 'invalid', 'unsupported-yaml'] as const) {
    const e = new ConfigSetError(reason, 'x');
    assert.equal(e.code, 'failed', reason);
    assert.equal(e.exitCode, 1, reason);
  }

  assert.throws(() => run('forge-no-such-binary-xyz', []), (e: unknown) => e instanceof ForgeError && e.code === 'external' && e.exitCode === 5 && /failed to start/.test(e.message));
  assert.throws(() => run(process.execPath, ['-e', 'process.exit(3)']), (e: unknown) => e instanceof ForgeError && e.code === 'external' && e.exitCode === 5 && /exited 3/.test(e.message));

  assert.deepEqual(toCliError(new Error('boom'), []), { code: 'internal', message: 'boom', exit: 1, hint: null });
  assert.deepEqual(toCliError('thrown string', []), { code: 'internal', message: 'thrown string', exit: 1, hint: null });
  assert.deepEqual(toCliError(new ForgeError('missing --session', 'usage'), ['job', 'claim', 'x', '--json']), { code: 'usage', message: 'missing --session', exit: 2, hint: 'forge help job claim' });
  assert.equal(toCliError(new ForgeError('x', 'usage'), ['job', 'nope']).hint, 'forge help job');
  assert.equal(toCliError(new ForgeError('x', 'usage'), ['nope']).hint, 'forge help');
  assert.equal(toCliError(new ForgeError('x', 'usage', 'forge help pr'), ['job']).hint, 'forge help pr', 'a hint set where it was thrown wins');
});

test('--json errors go to stdout only', POSIX, () => {
  withCases((cases, cli) => {
    for (const c of cases) {
      const e = jsonError(cli(c, ['--json']));
      assert.equal(e.code, c.code, c.name);
      assert.equal(e.exit, c.exit, c.name);
      assert.equal(e.hint, c.hint, c.name);
      assert.ok(e.message.length > 0, c.name);
    }
  });
  // Message text is data: a newline or quote in it can't break the line.
  const hostile = toCliError(new ForgeError('a "quoted"\nsecond line {"error":1}'), []);
  assert.equal(JSON.parse(JSON.stringify({ error: hostile })).error.message, 'a "quoted"\nsecond line {"error":1}');
});

test('text errors are unchanged; FORGE_DEBUG adds the stack', POSIX, () => {
  withCases((cases, cli) => {
    for (const c of cases) {
      const r = cli(c);
      const e = jsonError(cli(c, ['--json']));
      assert.equal(r.stdout, '', c.name);
      assert.equal(r.stderr, `forge: ${e.message}\n`, c.name);
    }
    const unknown = cases.find((c) => c.code === 'unknown_command')!;
    assert.equal(cli(unknown).stderr, 'forge: unknown command "nosuch"; run `forge help` to list commands\n');

    const debug = cli(unknown, [], { FORGE_DEBUG: '1' });
    assert.equal(debug.stdout, '');
    assert.ok(debug.stderr.startsWith('forge: unknown command "nosuch"'), debug.stderr);
    assert.match(debug.stderr, /\n\s+at /, 'a stack trace follows');
    const debugJson = cli(unknown, ['--json'], { FORGE_DEBUG: '1' });
    assert.equal(debugJson.status, 2);
    assert.equal(debugJson.stdout.split('\n').length, 2, 'one JSON line');
    assert.equal(JSON.parse(debugJson.stdout).error.code, 'unknown_command');
    assert.match(debugJson.stderr, /\n\s+at /, 'the stack goes to stderr');
  });
});

test('--json success output is one JSON value', POSIX, () => {
  const s = scratch();
  try {
    s.init();
    assert.deepEqual(s.json(['status', '--json']), []);
    assert.equal(s.cli(['status']).stdout, 'no active jobs\n');

    const id = s.json(['job', 'new', '--title', 'Status row', '--ref', 'status-row', '--session', 'session-abcdefghij']).id;
    assert.equal(id, 'status-row');
    const rows = s.json(['status', '--json']);
    assert.deepEqual(rows, [{ id, stage: 'backlog', state: 'queued', waitingOn: null, round: 0, tasks: { done: 0, total: 0 }, pr: null, session: 'session-abcdefghij' }]);
    assert.deepEqual(Object.keys(rows[0]), ['id', 'stage', 'state', 'waitingOn', 'round', 'tasks', 'pr', 'session']);
    // Without --json, the same padded table as before (the session cut to 8 characters).
    assert.equal(s.cli(['status']).stdout, ['job         stage    state   round  tasks  pr  session', 'status-row  backlog  queued  -      -      -   session-'].join('\n') + '\n');

    const p = s.cli(['worktree', 'path', id, '--json']);
    assert.equal(p.status, 0, p.stderr);
    assert.equal(JSON.parse(p.stdout), '');
    assert.equal(s.cli(['worktree', 'path', id]).stdout, '\n', 'raw without --json');
    assert.equal(JSON.parse(s.cli(['job', 'get', id, 'title', '--json']).stdout), 'Status row');
    assert.equal(s.cli(['job', 'get', id, 'title']).stdout, 'Status row\n');
    assert.equal(JSON.parse(s.cli(['config', 'get', 'tracker.kind', '--json']).stdout), 'none');

    const a = s.cli(['--json', 'job', 'list']);
    const b = s.cli(['job', 'list', '--json']);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(a.stdout, b.stdout);
    assert.equal(JSON.parse(a.stdout)[0].id, id);
    // --json takes no value: the word after it is still the command's.
    assert.equal(s.cli(['job', 'show', '--json', id]).status, 0);
  } finally {
    s.cleanup();
  }
});

test('forge git keeps --json and --help to itself', POSIX, () => {
  const s = scratch();
  try {
    s.init();
    for (const args of [['log', '--json', '--output=x'], ['log', '--output=x', '--json']]) {
      const r = s.cli(['git', ...args]);
      assert.equal(r.status, 1, args.join(' '));
      const e = jsonError(r);
      assert.match(e.message, /forge git refuses --output=x/);
      assert.equal(fs.existsSync(path.join(s.root, 'x')), false, 'no file x');
    }
    const log = s.cli(['git', 'log', '-n', '1', '--json']);
    assert.equal(log.status, 0, log.stderr);
    assert.match(log.stdout, /init/);

    // A git stub that records its argv shows what reaches git.
    const marker = path.join(path.dirname(s.root), `git-argv-${path.basename(s.root)}`);
    const recorder = s.stub('git', `#!/bin/sh\nprintf '%s\\n' "$@" > '${marker}'\n`);
    try {
      for (const sub of ['log', 'diff']) {
        const r = s.cli(['git', sub, '--help'], recorder);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.stdout.startsWith(`forge git ${sub} `), r.stdout);
        assert.match(r.stdout, /Exit codes:/);
      }
      assert.equal(fs.existsSync(marker), false, 'git never started for --help');
      assert.equal(s.cli(['git', 'log', '-n', '1', '--json'], recorder).status, 0);
      assert.ok(!fs.readFileSync(marker, 'utf8').split('\n').includes('--json'), 'git never sees --json');
      assert.equal(s.cli(['git', 'log', '--', '--json'], recorder).status, 0);
      const argv = fs.readFileSync(marker, 'utf8').split('\n');
      assert.deepEqual(argv.slice(argv.indexOf('--')), ['--', '--json', ''], 'a path after -- is untouched');
    } finally {
      fs.rmSync(marker, { force: true });
      fs.rmSync(path.join(path.dirname(s.root), `stubs-${path.basename(s.root)}`, 'git'), { force: true });
    }

    const id = s.json(['job', 'new', '--title', 'Commit']).id;
    const wt = s.json(['worktree', 'create', id]).path;
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'x\n');
    const c = s.cli(['git', 'commit', id, '--message', 'feat: x', '--json']);
    assert.equal(c.status, 0, c.stderr);
    const commit = JSON.parse(c.stdout);
    assert.equal(commit.id, id);
    assert.match(commit.sha, /^[0-9a-f]{40}$/);
    assert.deepEqual(commit.files, ['feature.txt']);
  } finally {
    s.cleanup();
  }
});

test('help works outside a repo, without FORGE_ROOT', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-help-'));
  try {
    const env = baseEnv();
    delete env.FORGE_ROOT;
    const r = spawnSync(process.execPath, [BIN, 'help'], { cwd: dir, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /forge status \[--all\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** `forge <args>` in an empty, non-git temp dir with no FORGE_ROOT: help needs neither. */
function helpCli(...args: string[]): Run {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-help-'));
  try {
    const env = baseEnv();
    delete env.FORGE_ROOT;
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The exit codes a command's help lists. */
function helpExits(text: string): number[] {
  const section = text.slice(text.indexOf('Exit codes:'));
  return [...section.matchAll(/^ {2}(\d) {2}/gm)].map((m) => Number(m[1]));
}

test('help: overview, group, command', () => {
  const overview = helpCli('help');
  assert.equal(overview.status, 0, overview.stderr);
  assert.equal(overview.stderr, '');
  for (const args of [['--help'], []]) {
    const r = helpCli(...args);
    assert.equal(r.status, 0, args.join(' '));
    assert.equal(r.stdout, overview.stdout, `forge ${args.join(' ')} prints the overview`);
  }
  // The spec's /…\|acs\|[^\n]*\|step\|advance\b/ needs a word between acs and step, which the
  // job usage order (…|scope|acs|step|advance, AC9) never has; this is the satisfiable form.
  assert.match(overview.stdout, /^  forge job new\|from-ref\|[^\n]*\|acs\|step\|advance\b/m);
  assert.ok(overview.stdout.includes('forge status [--all]'));
  assert.ok(overview.stdout.includes('--json'));
  assert.ok(overview.stdout.includes('docs/CLI.md'));
  assert.match(overview.stdout, /0 ok · 1 failed · 2 usage · 3 owned · 4 blocked · 5 external/);
  for (const g of GROUPS) assert.match(overview.stdout, new RegExp(`^  forge ${g.name}\\b`, 'm'), `the overview lists ${g.name}`);

  const group = helpCli('help', 'job');
  assert.equal(group.status, 0);
  assert.equal(helpCli('job', '--help').stdout, group.stdout);
  assert.ok(group.stdout.includes('forge job advance <id> --session S [--max N]'));
  assert.ok(group.stdout.includes('Run forge help job <subcommand> for flags and exit codes.'));

  const step = helpCli('help', 'job', 'step');
  assert.equal(step.status, 0);
  assert.equal(helpCli('job', 'step', '--help').stdout, step.stdout);
  assert.equal(helpCli('job', 'step', 'some-id', '--help').stdout, step.stdout);
  for (const want of ['forge job step <id> [--session S]', 'Flags:', '--session', 'Exit codes:']) assert.ok(step.stdout.includes(want), want);
  assert.deepEqual(helpExits(step.stdout).filter((c) => c === 0 || c === 2), [0, 2]);

  const unknown = helpCli('help', 'nosuch');
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stderr, 'forge: unknown command "nosuch"; run `forge help` to list commands\n');
  assert.equal(helpCli('nosuch', '--help').status, 2);
  // A word that is not a subcommand falls back to the group's help.
  assert.equal(helpCli('help', 'job', 'nope').stdout, group.stdout);

  const json = helpCli('help', 'job', 'step', '--json');
  assert.equal(json.status, 0);
  assert.equal(JSON.parse(json.stdout).command, 'job step');
  assert.equal(JSON.parse(helpCli('help', 'job', '--json').stdout).name, 'job');
  const all = JSON.parse(helpCli('help', '--json').stdout);
  assert.deepEqual(Object.keys(all), ['version', 'groups']);
  assert.deepEqual(all.groups.map((g: any) => g.name), GROUPS.map((g) => g.name));
  assert.equal(JSON.parse(helpCli('--json').stdout).groups.length, GROUPS.length);
});

test('help lists each command\'s exits', () => {
  const required: [string[], number[]][] = [
    [['job', 'claim'], [3, 4]],
    [['job', 'advance'], [1, 3]],
    [['verify'], [1]],
    [['requests', 'claim'], [3]],
    [['job', 'link'], [3]],
    [['worktree', 'create'], [5]],
    [['pr', 'merge'], [1]],
  ];
  for (const [words, codes] of required) {
    const r = helpCli('help', ...words);
    assert.equal(r.status, 0, words.join(' '));
    const exits = helpExits(r.stdout);
    for (const c of [0, 2, ...codes]) assert.ok(exits.includes(c), `forge help ${words.join(' ')} lists ${c}: ${exits}`);
  }
  // Every row: valid exit codes only, never 0 or 2 (those print for every command), each once.
  for (const g of GROUPS) {
    for (const c of g.commands) {
      const codes = (c.exits ?? []).map(([code]) => code);
      assert.ok(codes.every((x) => [1, 3, 4, 5].includes(x)), c.command);
      assert.equal(new Set(codes).size, codes.length, `${c.command}: each exit once`);
      assert.ok(c.command === g.name || c.command.startsWith(`${g.name} `), c.command);
      assert.ok(c.summary && !c.summary.includes('\n'), c.command);
    }
  }
});

test('help covers every routed command', () => {
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const labels = (src: string) => new Set([...src.matchAll(/case '([^']+)':/g)].map((m) => m[1]));
  const cli = read('lib/cli.ts');
  const routed = labels(cli.slice(cli.indexOf('export async function dispatch')));
  for (const extra of ['help', 'version', 'update']) routed.add(extra);
  assert.deepEqual([...routed].sort(), GROUPS.map((g) => g.name).sort());

  const subcommands = (name: string) => GROUPS.find((g) => g.name === name)!.commands.map((c) => c.command.slice(name.length + 1)).sort();
  const job = labels(read('lib/commands/job.ts'));
  job.add('advance');
  assert.deepEqual([...job].sort(), subcommands('job'));
  assert.deepEqual([...labels(read('lib/commands/eval.ts'))].sort(), subcommands('eval'));
  assert.deepEqual([...labels(read('lib/commands/tracker.ts'))].sort(), subcommands('tracker'));

  // lib/cli.ts only routes: no help or usage text of its own (AC10).
  assert.doesNotMatch(cli, /usage:|Usage:|HELP/);

  const s = scratch();
  try {
    s.init();
    const r = s.cli(['job', 'bogus']);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes('usage: forge job new|from-ref|link|list|show|get|set|claim|release|note|human|agent|round|budget|verdicts|decision|progress|paths|scope|acs|step|advance; run `forge help job`'), r.stderr);
  } finally {
    s.cleanup();
  }
  assert.deepEqual(findHelp(['job', 'step'])?.command?.command, 'job step');
  assert.equal(findHelp(['nosuch']), null);
});
