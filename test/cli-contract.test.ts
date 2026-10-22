// The CLI's contract for scripts and other runtimes (docs/CLI.md): exit classes, --json errors,
// JSON success output, and `forge git` keeping Forge's own flags to itself.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { forgeInProcess, repoTemplate } from './helpers.ts';
import { ConfigSetError } from '../lib/config-fields.ts';
import { DEFAULT_CODE, ERROR_CODES, ForgeError, run } from '../lib/util.ts';
import { GROUPS, README_END, README_START, findHelp, readmeTable, syncReadme, toCliError } from '../lib/commands/help.ts';

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

/** `forge <args>` without blocking the event loop, so the tests below can overlap their spawns. */
function spawnCli(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (err as any).code : 0;
      resolve({ status: typeof code === 'number' ? code : null, stdout, stderr });
    });
  });
}

const plainRepo = repoTemplate(() => {});
const forgeRepo = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'none' }, pr: { enabled: false }, commands: { test: 'true' }, worktrees: { root: '../{repo}.wt' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: baseEnv({ FORGE_ROOT: dir }), stdio: 'pipe' });
  fs.rmSync(answers);
});

/** A scratch repo with FORGE_ROOT pinned to it, a stub bin dir, and (with `initialized`) Forge set up. */
function scratch(initialized = true) {
  const repo = initialized ? forgeRepo() : plainRepo();
  const tmp = path.dirname(repo.dir);
  const base = path.basename(repo.dir);
  const stubs = path.join(tmp, `stubs-${base}`);
  fs.mkdirSync(stubs);
  const cli = (args: string[], env: Record<string, string> = {}): Promise<Run> => spawnCli(args, repo.dir, baseEnv({ FORGE_ROOT: repo.dir, ...env }));
  const json = async (args: string[]): Promise<any> => {
    const r = await cli(args);
    assert.equal(r.status, 0, `forge ${args.join(' ')}: ${r.stderr}${r.stdout}`);
    return JSON.parse(r.stdout);
  };
  /** Writes an executable into the stub dir and returns the PATH that finds it first. */
  const stub = (name: string, script: string): Record<string, string> => {
    fs.writeFileSync(path.join(stubs, name), script, { mode: 0o755 });
    return { PATH: `${stubs}${path.delimiter}${process.env.PATH}` };
  };
  const cleanup = () => {
    repo.cleanup();
    for (const p of [`${repo.dir}.wt`, stubs]) fs.rmSync(p, { recursive: true, force: true });
  };
  return { root: repo.dir, cli, json, stub, cleanup };
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
async function errorCases(s: ReturnType<typeof scratch>): Promise<ErrorCase[]> {
  const held = (await s.json(['job', 'new', '--title', 'Held', '--session', 'A'])).id;
  const dep = (await s.json(['job', 'new', '--title', 'Dependency'])).id;
  const blocked = (await s.json(['job', 'new', '--title', 'Blocked'])).id;
  await s.json(['job', 'set', blocked, '--field', `dependsOn=["${dep}"]`]);
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

async function withCases(fn: (cases: ErrorCase[], cli: (c: ErrorCase, extra?: string[], env?: Record<string, string>) => Promise<Run>) => Promise<void>): Promise<void> {
  const s = scratch();
  const bare = scratch(false);
  try {
    const cases = await errorCases(s);
    await fn(cases, (c, extra = [], env = {}) => (c.uninitialized ? bare : s).cli([...c.args, ...extra], { ...c.env, ...env }));
  } finally {
    s.cleanup();
    bare.cleanup();
  }
}

/** `forge <args>` in an empty, non-git temp dir with no FORGE_ROOT: help needs neither. */
async function helpCli(...args: string[]): Promise<Run> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-help-'));
  try {
    const env = baseEnv();
    delete env.FORGE_ROOT;
    return await spawnCli(args, dir, env);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The exit codes a command's help lists. */
function helpExits(text: string): number[] {
  const section = text.slice(text.indexOf('Exit codes:'));
  return [...section.matchAll(/^ {2}(\d) {2}/gm)].map((m) => Number(m[1]));
}

const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** A `## heading` section of a markdown file, up to the next `## `. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `${heading} exists`);
  const end = text.indexOf('\n## ', start + heading.length + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

/**
 * Sorted dotted key paths, arrays collapsed to `[]` over the union of their elements' keys. A
 * data-keyed map (keys are reviewer names, roles, …) is recorded as its own path only.
 */
function keyPaths(value: unknown, maps: string[] = []): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, at: string) => {
    if (maps.includes(at)) return;
    if (Array.isArray(v)) for (const x of v) walk(x, `${at}[]`);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        const p = at ? `${at}.${k}` : k;
        out.add(p);
        walk(x, p);
      }
    }
  };
  walk(value, '');
  return [...out].sort();
}

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

test('protected_path exits 1', () => {
  assert.equal(ERROR_CODES.protected_path, 1);
  const e = new ForgeError('x', 'protected_path');
  assert.equal(e.exitCode, 1);
  assert.equal(e.code, 'protected_path');
  const cli = fs.readFileSync(path.join(ROOT, 'docs', 'CLI.md'), 'utf8');
  assert.ok(cli.includes('| `protected_path` | 1 |'), 'docs/CLI.md documents protected_path');
});

test('the secret scanner has its error code, help and README row', () => {
  assert.equal(ERROR_CODES.secret_found, 1);
  assert.equal(new ForgeError('x', 'secret_found').exitCode, 1);
  const help = findHelp(['secrets', 'scan']);
  assert.ok(help, 'forge help secrets scan resolves');
  const readme = read('README.md');
  assert.ok(readme.slice(readme.indexOf(README_START), readme.indexOf(README_END)).includes('secrets scan'), 'README lists secrets scan');
});

test('docs/CLI.md matches the error code table', () => {
  const doc = read('docs/CLI.md');
  const rows = (heading: string) => [...section(doc, heading).matchAll(/^\| `?([a-z_]+)`? \| (\d) \|/gm)].map((m) => [m[1], Number(m[2])] as const);
  assert.deepEqual(
    rows('## Error codes').sort(([a], [b]) => a.localeCompare(b)),
    Object.entries(ERROR_CODES).sort(([a], [b]) => a.localeCompare(b)),
  );
  const exits = rows('## Exit codes');
  assert.deepEqual(exits, [['ok', 0], ['failed', 1], ['usage', 2], ['owned', 3], ['blocked', 4], ['external', 5]]);
  for (const [name, n] of exits) if (n > 0) assert.equal(DEFAULT_CODE[n as 1 | 2 | 3 | 4 | 5], name);
  for (const h of ['## Output', '## `--json`', '## Help', '## Environment variables', '## Stability']) section(doc, h);
  // Every table row has its header's columns: a bare `|` inside a cell (even in code) splits it, so cells write `\|`.
  const cols = (line: string) => line.split(/(?<!\\)\|/).length;
  let header = 0;
  for (const line of doc.split('\n')) {
    if (!line.startsWith('|')) header = 0;
    else if (!header) header = cols(line);
    else assert.equal(cols(line), header, `docs/CLI.md: ${line.slice(0, 80)}`);
  }
});

test('every FORGE_ variable is documented', () => {
  const files: string[] = [path.join(ROOT, 'bin', 'forge')];
  for (const dir of ['lib', 'hooks']) for (const f of fs.readdirSync(path.join(ROOT, dir), { recursive: true })) {
    const full = path.join(ROOT, dir, String(f));
    if (fs.statSync(full).isFile()) files.push(full);
  }
  const names = (text: string) => new Set([...text.matchAll(/\bFORGE_[A-Z][A-Z0-9_]*/g)].map((m) => m[0].replace(/_+$/, '')));
  const used = new Set<string>();
  for (const f of files) for (const n of names(fs.readFileSync(f, 'utf8'))) used.add(n);
  for (const n of ['FORGE_ROOT', 'FORGE_DEBUG', 'FORGE_DAEMON']) assert.ok(used.has(n), `the scan finds ${n}`);
  assert.ok(!used.has('FORGE_TOKEN'), 'the __FORGE_TOKEN__ placeholder is not a variable');

  const env = section(read('docs/CLI.md'), '## Environment variables');
  const documented = new Set([...env.matchAll(/`(FORGE_[A-Z][A-Z0-9_]*)`/g)].map((m) => m[1].replace(/_+$/, '')));
  for (const n of used) assert.ok(documented.has(n), `${n} is read or set in lib/, hooks/ or bin/ but not documented in docs/CLI.md`);
  for (const n of names(env)) assert.ok(used.has(n), `docs/CLI.md documents ${n}, which no code uses`);
  for (const n of ['GH_HOST', 'SHELL', 'PORT', 'ANTHROPIC_API_KEY', 'GIT_CONFIG_COUNT']) assert.ok(env.includes(`\`${n}\``), n);
});

// Every test below starts the CLI. Each has its own scratch repos (or temp dirs) and none changes
// process.env or the cwd, so they overlap their spawns.
describe('the spawned CLI', { concurrency: 4 }, () => {
  test('exit codes follow the table', POSIX, async () => {
    await withCases(async (cases, cli) => {
      for (const c of cases) assert.equal((await cli(c)).status, c.exit, `${c.name}: forge ${c.args.join(' ')}`);
    });
  });

  test('--json errors go to stdout only', POSIX, async () => {
    await withCases(async (cases, cli) => {
      for (const c of cases) {
        const e = jsonError(await cli(c, ['--json']));
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

  test('text errors are unchanged; FORGE_DEBUG adds the stack', POSIX, async () => {
    await withCases(async (cases, cli) => {
      for (const c of cases) {
        const r = await cli(c);
        const e = jsonError(await cli(c, ['--json']));
        assert.equal(r.stdout, '', c.name);
        assert.equal(r.stderr, `forge: ${e.message}\n`, c.name);
      }
      const unknown = cases.find((c) => c.code === 'unknown_command')!;
      assert.equal((await cli(unknown)).stderr, 'forge: unknown command "nosuch"; run `forge help` to list commands\n');

      const debug = await cli(unknown, [], { FORGE_DEBUG: '1' });
      assert.equal(debug.stdout, '');
      assert.ok(debug.stderr.startsWith('forge: unknown command "nosuch"'), debug.stderr);
      assert.match(debug.stderr, /\n\s+at /, 'a stack trace follows');
      const debugJson = await cli(unknown, ['--json'], { FORGE_DEBUG: '1' });
      assert.equal(debugJson.status, 2);
      assert.equal(debugJson.stdout.split('\n').length, 2, 'one JSON line');
      assert.equal(JSON.parse(debugJson.stdout).error.code, 'unknown_command');
      assert.match(debugJson.stderr, /\n\s+at /, 'the stack goes to stderr');
    });
  });

  test('--json success output is one JSON value', POSIX, async () => {
    const s = scratch();
    try {
      assert.deepEqual(await s.json(['status', '--json']), []);
      assert.equal((await s.cli(['status'])).stdout, 'no active jobs\n');

      const id = (await s.json(['job', 'new', '--title', 'Status row', '--ref', 'status-row', '--session', 'session-abcdefghij'])).id;
      assert.equal(id, 'status-row');
      const rows = await s.json(['status', '--json']);
      assert.deepEqual(rows, [{ id, stage: 'backlog', state: 'queued', waitingOn: null, round: 0, tasks: { done: 0, total: 0 }, pr: null, session: 'session-abcdefghij', foremanHandoff: null }]);
      assert.deepEqual(Object.keys(rows[0]), ['id', 'stage', 'state', 'waitingOn', 'round', 'tasks', 'pr', 'session', 'foremanHandoff']);
      // Without --json, the same padded table as before (the session cut to 8 characters).
      assert.equal((await s.cli(['status'])).stdout, ['job         stage    state   round  tasks  pr  session', 'status-row  backlog  queued  -      -      -   session-'].join('\n') + '\n');

      const p = await s.cli(['worktree', 'path', id, '--json']);
      assert.equal(p.status, 0, p.stderr);
      assert.equal(JSON.parse(p.stdout), '');
      assert.equal((await s.cli(['worktree', 'path', id])).stdout, '\n', 'raw without --json');
      assert.equal(JSON.parse((await s.cli(['job', 'get', id, 'title', '--json'])).stdout), 'Status row');
      assert.equal((await s.cli(['job', 'get', id, 'title'])).stdout, 'Status row\n');
      assert.equal(JSON.parse((await s.cli(['config', 'get', 'tracker.kind', '--json'])).stdout), 'none');

      const a = await s.cli(['--json', 'job', 'list']);
      const b = await s.cli(['job', 'list', '--json']);
      assert.equal(a.status, 0, a.stderr);
      assert.equal(a.stdout, b.stdout);
      assert.equal(JSON.parse(a.stdout)[0].id, id);
      // --json takes no value: the word after it is still the command's.
      assert.equal((await s.cli(['job', 'show', '--json', id])).status, 0);
    } finally {
      s.cleanup();
    }
  });

  test('forgeInProcess matches the CLI\'s exit, error code and JSON', POSIX, async () => {
    const s = scratch();
    try {
      const id = (await s.json(['job', 'new', '--title', 'Parity'])).id;
      const show = await forgeInProcess(s.root, ['job', 'show', id]);
      assert.equal(show.status, 0);
      assert.equal(show.error, null);
      assert.deepEqual(show.data, await s.json(['job', 'show', id]));

      const missing = await forgeInProcess(s.root, ['job', 'show', 'nope']);
      const cliMissing = await s.cli(['job', 'show', 'nope', '--json']);
      assert.equal(missing.data, null);
      assert.deepEqual({ status: missing.status, code: missing.error?.code }, { status: cliMissing.status, code: jsonError(cliMissing).code });
      assert.deepEqual({ status: missing.status, code: missing.error?.code }, { status: 1, code: 'not_found' });

      const claim = await forgeInProcess(s.root, ['job', 'claim', id]);
      assert.deepEqual({ status: claim.status, code: claim.error?.code }, { status: 2, code: 'usage' });

      // Commands main() routes or that print for themselves are refused before anything runs.
      await assert.rejects(forgeInProcess(s.root, ['config', 'get', 'x']), /forgeAsync/);
      await assert.rejects(forgeInProcess(s.root, ['job', 'list', '--mode', 'human']), /forgeAsync/);
    } finally {
      s.cleanup();
    }
  });

  test('forge git keeps --json and --help to itself', POSIX, async () => {
    const s = scratch();
    try {
      for (const args of [['log', '--json', '--output=x'], ['log', '--output=x', '--json']]) {
        const r = await s.cli(['git', ...args]);
        assert.equal(r.status, 1, args.join(' '));
        const e = jsonError(r);
        assert.match(e.message, /forge git refuses --output=x/);
        assert.equal(fs.existsSync(path.join(s.root, 'x')), false, 'no file x');
      }
      const log = await s.cli(['git', 'log', '-n', '1', '--json']);
      assert.equal(log.status, 0, log.stderr);
      assert.match(log.stdout, /init/);

      // A git stub that records its argv shows what reaches git.
      const marker = path.join(path.dirname(s.root), `git-argv-${path.basename(s.root)}`);
      const recorder = s.stub('git', `#!/bin/sh\nprintf '%s\\n' "$@" > '${marker}'\n`);
      try {
        for (const sub of ['log', 'diff']) {
          const r = await s.cli(['git', sub, '--help'], recorder);
          assert.equal(r.status, 0, r.stderr);
          assert.ok(r.stdout.startsWith(`forge git ${sub} `), r.stdout);
          assert.match(r.stdout, /Exit codes:/);
        }
        assert.equal(fs.existsSync(marker), false, 'git never started for --help');
        assert.equal((await s.cli(['git', 'log', '-n', '1', '--json'], recorder)).status, 0);
        assert.ok(!fs.readFileSync(marker, 'utf8').split('\n').includes('--json'), 'git never sees --json');
        assert.equal((await s.cli(['git', 'log', '--', '--json'], recorder)).status, 0);
        const argv = fs.readFileSync(marker, 'utf8').split('\n');
        assert.deepEqual(argv.slice(argv.indexOf('--')), ['--', '--json', ''], 'a path after -- is untouched');
      } finally {
        fs.rmSync(marker, { force: true });
        fs.rmSync(path.join(path.dirname(s.root), `stubs-${path.basename(s.root)}`, 'git'), { force: true });
      }

      const id = (await s.json(['job', 'new', '--title', 'Commit'])).id;
      const wt = (await s.json(['worktree', 'create', id])).path;
      fs.writeFileSync(path.join(wt, 'feature.txt'), 'x\n');
      const c = await s.cli(['git', 'commit', id, '--message', 'feat: x', '--json']);
      assert.equal(c.status, 0, c.stderr);
      const commit = JSON.parse(c.stdout);
      assert.equal(commit.id, id);
      assert.match(commit.sha, /^[0-9a-f]{40}$/);
      assert.deepEqual(commit.files, ['feature.txt']);
    } finally {
      s.cleanup();
    }
  });

  test('forge git: --mode never reaches git', POSIX, async () => {
    const s = scratch();
    try {
      const plain = await s.cli(['git', 'log', '-1', '--format=%s']);
      assert.equal(plain.status, 0, plain.stderr);
      assert.equal(plain.stdout, 'init\n');
      for (const args of [['git', 'log', '--mode', 'agent', '-1', '--format=%s'], ['git', 'log', '--mode=human', '-1', '--format=%s'], ['--mode', 'human', 'git', 'log', '-1', '--format=%s']]) {
        const r = await s.cli(args);
        assert.deepEqual(r, plain, args.join(' '));
      }
    } finally {
      s.cleanup();
    }
  });

  test('agent mode is today\'s output, whatever selects it', POSIX, async () => {
    const s = scratch();
    try {
      const id = (await s.json(['job', 'new', '--title', 'Agent mode'])).id;
      /** The CLI with FORGE_MODE removed from its env, or set to `mode`; execFile's stdout is a pipe. */
      const cli = (args: string[], mode?: string): Promise<Run> => {
        const env = baseEnv({ FORGE_ROOT: s.root });
        delete env.FORGE_MODE;
        if (mode !== undefined) env.FORGE_MODE = mode;
        return spawnCli(args, s.root, env);
      };
      const calls: [string[], boolean][] = [
        [['version'], true],
        [['job', 'list'], true],
        [['job', 'show', id], true],
        [['status'], false],
        [['worktree', 'path', id], false],
        [['help'], false],
        [['job', 'show', 'nope'], false],
      ];
      for (const [args, isObject] of calls) {
        const unset = await cli(args);
        const name = args.join(' ');
        assert.deepEqual(await cli(args, 'agent'), unset, `${name}: FORGE_MODE=agent`);
        assert.deepEqual(await cli([...args, '--mode', 'agent']), unset, `${name}: --mode agent`);
        assert.deepEqual(await cli([...args, '--json'], 'human'), await cli([...args, '--json']), `${name}: --json beats FORGE_MODE=human`);
        if (isObject) {
          assert.equal(unset.status, 0, unset.stderr);
          assert.doesNotThrow(() => JSON.parse(unset.stdout), name);
        }
      }
      const nope = await cli(['job', 'show', 'nope']);
      assert.equal(nope.status, 1);
      assert.match(nope.stderr, /^forge: /, 'agent errors keep the forge: prefix');
    } finally {
      s.cleanup();
    }
  });

  test('help works outside a repo, without FORGE_ROOT', async () => {
    const r = await helpCli('help');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /forge status \[--all\]/);
  });

  test('help: overview, group, command', async () => {
    const overview = await helpCli('help');
    assert.equal(overview.status, 0, overview.stderr);
    assert.equal(overview.stderr, '');
    for (const args of [['--help'], []]) {
      const r = await helpCli(...args);
      assert.equal(r.status, 0, args.join(' '));
      assert.equal(r.stdout, overview.stdout, `forge ${args.join(' ')} prints the overview`);
    }
    // The spec's /…\|acs\|[^\n]*\|step\|advance\b/ needs a word between acs and step, which the
    // job usage order (…|scope|acs|step|advance, AC9) never has; this is the satisfiable form.
    assert.match(overview.stdout, /^  forge job acs\|advance\|agent\|[^\n]*\|step\|verdicts\b/m);
    assert.ok(overview.stdout.includes('forge status [--all]'));
    assert.ok(overview.stdout.includes('--json'));
    assert.ok(overview.stdout.includes('docs/CLI.md'));
    assert.match(overview.stdout, /0 ok · 1 failed · 2 usage · 3 owned · 4 blocked · 5 external/);
    for (const g of GROUPS) assert.match(overview.stdout, new RegExp(`^  forge ${g.name}\\b`, 'm'), `the overview lists ${g.name}`);

    const group = await helpCli('help', 'job');
    assert.equal(group.status, 0);
    assert.equal((await helpCli('job', '--help')).stdout, group.stdout);
    assert.ok(group.stdout.includes('forge job advance <id> --session S [--epoch N] [--max N]'));
    assert.ok(group.stdout.includes('Run forge help job <subcommand> for flags and exit codes.'));

    const step = await helpCli('help', 'job', 'step');
    assert.equal(step.status, 0);
    assert.equal((await helpCli('job', 'step', '--help')).stdout, step.stdout);
    assert.equal((await helpCli('job', 'step', 'some-id', '--help')).stdout, step.stdout);
    for (const want of ['forge job step <id> [--session S]', 'Flags:', '--session', 'Exit codes:']) assert.ok(step.stdout.includes(want), want);
    assert.deepEqual(helpExits(step.stdout).filter((c) => c === 0 || c === 2), [0, 2]);

    const unknown = await helpCli('help', 'nosuch');
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stderr, 'forge: unknown command "nosuch"; run `forge help` to list commands\n');
    assert.equal((await helpCli('nosuch', '--help')).status, 2);
    // A word that is not a subcommand falls back to the group's help.
    assert.equal((await helpCli('help', 'job', 'nope')).stdout, group.stdout);

    const json = await helpCli('help', 'job', 'step', '--json');
    assert.equal(json.status, 0);
    assert.equal(JSON.parse(json.stdout).command, 'job step');
    const jobJson = await helpCli('help', 'job', '--json');
    assert.equal(JSON.parse(jobJson.stdout).name, 'job');
    const allRun = await helpCli('help', '--json');
    const all = JSON.parse(allRun.stdout);
    assert.deepEqual(Object.keys(all), ['version', 'groups']);
    assert.deepEqual(all.groups.map((g: any) => g.name), GROUPS.map((g) => g.name));
    assert.equal(JSON.parse((await helpCli('--json')).stdout).groups.length, GROUPS.length);
    // `readme` is internal (it picks README rows): it never reaches the JSON, where docs/CLI.md
    // "Stability" would freeze it. Only these keys may appear on a command.
    const PUBLIC = new Set(['command', 'args', 'summary', 'flags', 'exits', 'docs']);
    const link = await helpCli('help', 'job', 'link', '--json');
    const update = await helpCli('help', 'update', '--json');
    const commands = [...all.groups.flatMap((g: any) => g.commands), ...JSON.parse(jobJson.stdout).commands, JSON.parse(link.stdout), JSON.parse(update.stdout)];
    assert.ok(GROUPS.flatMap((g) => g.commands).some((c) => c.readme), 'the tables do mark README rows');
    for (const c of commands) for (const k of Object.keys(c)) assert.ok(PUBLIC.has(k), `forge help --json prints ${k} on ${c.command}`);
    for (const [r, args] of [[allRun, 'help --json'], [jobJson, 'help job --json'], [link, 'help job link --json'], [update, 'help update --json']] as const) assert.ok(!r.stdout.includes('"readme"'), args);
  });

  test('help lists each command\'s exits', async () => {
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
      const r = await helpCli('help', ...words);
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

  test('help covers every routed command', async () => {
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
      const r = await s.cli(['job', 'bogus']);
      assert.equal(r.status, 2);
      assert.ok(r.stderr.includes('usage: forge job acs|advance|agent|archive|assist|audit|budget|claim|decision|delete|effort|findings|from-ref|get|handoff|human|interim|link|links|list|new|note|panel|paths|progress|prune|refresh-request|release|repo|round|scope|score|set|show|step|verdicts; run `forge help job`'), r.stderr);
    } finally {
      s.cleanup();
    }
    assert.deepEqual(findHelp(['job', 'step'])?.command?.command, 'job step');
    assert.equal(findHelp(['nosuch']), null);
  });

  test('README CLI table is generated from the help tables', async () => {
    const readme = read('README.md');
    const start = readme.indexOf(README_START);
    const end = readme.indexOf(README_END);
    assert.ok(start >= 0 && end > start, 'README has the generated region');
    const region = readme.slice(start + README_START.length + 1, end).replace(/\n$/, '');
    assert.equal(region, readmeTable());
    assert.equal(syncReadme(readme), readme, 'npm run docs:commands would change nothing');

    const rows = region.split('\n').slice(2);
    assert.equal(rows.length, GROUPS.flatMap((g) => g.commands).filter((c) => c.readme).length);
    assert.ok(rows.length >= 11);
    for (const row of rows) {
      // Cells are separated by ` | `; a pipe inside a cell is written `\|`, never with a space before it.
      const cells = row.slice(2, -2).split(' | ').map((c) => c.replace(/\\\|/g, '|'));
      assert.equal(cells.length, 2, row);
      const usage = cells[0].replace(/^`|`$/g, '');
      const summary = cells[1].replace(/ \(see \[[^\]]+\]\([^)]+\)\)$/, '');
      const words = usage.split(' ').slice(1, 3);
      const help = await helpCli('help', ...words);
      assert.equal(help.status, 0, usage);
      assert.ok(help.stdout.includes(usage), `forge help ${words.join(' ')} shows ${usage}`);
      assert.ok(help.stdout.includes(summary), `forge help ${words.join(' ')} shows its summary`);
    }
    // A README without the markers is refused rather than silently left alone.
    assert.throws(() => syncReadme('# no markers\n'), /no <!-- forge:commands:start/);
  });

  test('CLI JSON keys are stable', POSIX, async () => {
    assert.deepEqual(keyPaths([{ a: 1, b: { c: [{ d: 1 }, { e: 2 }] } }, { f: null }], []), ['[].a', '[].b', '[].b.c', '[].b.c[].d', '[].b.c[].e', '[].f']);
    assert.deepEqual(keyPaths({ m: { anything: { x: 1 } } }, ['m']), ['m']);

    const s = scratch();
    try {
      const id = (await s.json(['job', 'new', '--title', 'Key snapshot', '--ref', 'key-snapshot', '--session', 'S'])).id;
      await s.json(['worktree', 'create', id]);
      const verify = await s.json(['verify', id]);
      assert.equal(verify.ok, true);
      // Renaming or dropping one of these keys is a breaking change (docs/CLI.md "Stability").
      assert.deepEqual(keyPaths(await s.json(['job', 'list'])), ['[].effort', '[].id', '[].owner', '[].pr', '[].round', '[].stage', '[].state', '[].title', '[].waitingOn']);
      assert.deepEqual(keyPaths(await s.json(['job', 'show', id]), ['lastVerdicts', 'ports']), [
        'base', 'branch', 'decision', 'effort', 'estCostUsd', 'foremanHandoff', 'id', 'issues', 'issues[].ref', 'issues[].tracker', 'issues[].url', 'kind', 'lastVerdicts', 'maxRounds', 'noIssue', 'owner', 'port', 'ports', 'pr', 'progress', 'progress.done', 'progress.total',
        'reason', 'reviewers', 'round', 'stage', 'state', 'title', 'tokens', 'verified', 'verified.attempt',
        'verified.ok', 'verified.round', 'verified.sha', 'verify', 'waitingOn', 'worktree',
      ]);
      assert.deepEqual(keyPaths(await s.json(['job', 'step', id])), ['action', 'command', 'id', 'rule', 'shell', 'why']);
      assert.deepEqual(keyPaths(await s.json(['status', '--json'])), ['[].foremanHandoff', '[].id', '[].pr', '[].round', '[].session', '[].stage', '[].state', '[].tasks', '[].tasks.done', '[].tasks.total', '[].waitingOn']);
      assert.deepEqual(keyPaths(verify), [
        'attempt', 'file', 'integrity', 'integrity.base', 'integrity.blocking', 'integrity.configEdits', 'integrity.deletedTests', 'integrity.findings', 'integrity.linkOverrides', 'integrity.mode', 'integrity.more',
        'integrity.ok', 'integrity.renamedTests', 'integrity.skipMarkers', 'integrity.testCount', 'integrity.testCount.after', 'integrity.testCount.before', 'integrity.testCount.delta',
        'ok', 'protected', 'protected.escalated', 'protected.more', 'protected.ok', 'protected.refused', 'round', 'secrets', 'secrets.allowed', 'secrets.count', 'secrets.findings', 'secrets.mode', 'secrets.more', 'secrets.ok', 'sha', 'steps', 'steps[].cmd', 'steps[].durationMs', 'steps[].exit', 'steps[].log', 'steps[].name', 'steps[].ok', 'steps[].skipped',
      ]);
      assert.deepEqual(keyPaths(await s.json(['stats', '--json']), ['waitingOn', 'cost.byRole', 'cost.byModel', 'reviewers', 'verifiers']), [
        'cost', 'cost.avgCostPerJobUsd', 'cost.avgTokensPerJob', 'cost.byModel', 'cost.byRole', 'cost.estCostUsd', 'cost.reportingCoverage', 'cost.reportingCoverage.agentRuns',
        'cost.reportingCoverage.exact', 'cost.reportingCoverage.withUsage', 'cost.totalTokens', 'counts', 'counts.active', 'counts.archived', 'counts.cancelled', 'counts.done', 'counts.failed',
        'counts.total', 'counts.waiting', 'generatedAt', 'quality', 'quality.autonomyRate', 'quality.autonomyRateStrict', 'quality.avgRounds', 'quality.churnRate', 'quality.escalationRate', 'quality.firstPassReviewRate', 'quality.followUpRate',
        'quality.foremanDecisions', 'quality.foremanReworks', 'quality.humanDeltaCoverage',
        'quality.humanDeltaCoverage.measured', 'quality.humanDeltaCoverage.merged', 'quality.humanDeltaRate', 'quality.humanFeedbackOnPrRate', 'quality.humanReworks',
        'quality.medianHumanDeltaLines', 'quality.medianScore', 'quality.outcomeCoverage', 'quality.outcomeCoverage.final', 'quality.outcomeCoverage.merged', 'quality.outcomeCoverage.open', 'quality.recurringFindings', 'quality.revertRate',
        'quality.scoreByBuilderModel', 'quality.scoreCoverage', 'quality.scoreCoverage.failed', 'quality.scoreCoverage.held', 'quality.scoreCoverage.merged', 'quality.scoreCoverage.queued', 'quality.scoreCoverage.sampled', 'quality.scoreCoverage.scored',
        'quality.specFirstApprovalRate', 'quality.verifyFirstPassRate', 'reviewers', 'since', 'speed', 'speed.medianMinutesToDone',
        'speed.medianMinutesToPr', 'verifiers', 'waitingOn',
      ]);
      assert.deepEqual(keyPaths(await s.json(['version', '--json'])), ['commit', 'installedAs', 'node', 'version']);
    } finally {
      s.cleanup();
    }
  });
});
