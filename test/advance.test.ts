// `forge job advance`: step's run actions executed in-process, one compact line back, and the
// ownership and allowlist guards that keep it no wider than step.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { claimJob, jobDir, loadJob, readEvents } from '../lib/jobs.ts';
import { loadConfig } from '../lib/config.ts';
import { dispatch } from '../lib/cli.ts';
import { advance, runnableInProcess, summarize } from '../lib/commands/advance.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'bin', 'forge');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A stand-in `gh`: no PR for the branch, and the repo slug pr.ts asks for.
const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo '[]' ;;
  "repo view") echo o/r ;;
esac
`;

function scratch(answers: Record<string, unknown> = {}) {
  const repo = tempRepo();
  const bin = path.join(path.dirname(repo.dir), `fakebin-${path.basename(repo.dir)}`);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const env = { ...process.env, FORGE_ROOT: repo.dir, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const raw = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env });
  const f = (...args: string[]) => {
    const r = raw(...args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return r.stdout.trim();
    }
  };
  const answersFile = path.join(path.dirname(repo.dir), `answers-${path.basename(repo.dir)}.json`);
  fs.writeFileSync(answersFile, JSON.stringify({ tracker: { kind: 'none' }, pr: { enabled: false }, worktrees: { root: `../${path.basename(repo.dir)}.wt` }, ...answers }));
  f('init', 'write', '--answers', answersFile);
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
    fs.rmSync(answersFile, { force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  };
  return { root: repo.dir, f, raw, cleanup };
}

/** Every path under dir with its bytes (directories marked), so a test can assert nothing changed. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(dir, { recursive: true }).map(String).sort()) {
    const p = path.join(dir, f);
    out[f] = fs.statSync(p).isDirectory() ? '<dir>' : fs.readFileSync(p, 'base64');
  }
  return out;
}

/** The single JSON line advance printed. */
function oneJsonLine(stdout: string): any {
  assert.ok(stdout.endsWith('\n'), 'ends with a newline');
  assert.equal(stdout.indexOf('\n'), stdout.length - 1, 'exactly one line');
  return JSON.parse(stdout);
}

const RAN_KEYS = new Set(['rule', 'command', 'ok', 'result', 'error', 'tell']);
function assertRanShape(ran: any[]): void {
  for (const e of ran) {
    for (const k of Object.keys(e)) assert.ok(RAN_KEYS.has(k), `unexpected ran key ${k}`);
    for (const k of ['result', 'error']) {
      if (e[k] === undefined) continue;
      assert.equal(typeof e[k], 'string');
      assert.ok(!e[k].includes('\n'), `${k} is one line`);
      assert.ok(e[k].length <= 200, `${k} is at most 200 characters`);
    }
  }
}

test('advance runs intake to the first spawn in one call', POSIX, () => {
  const s = scratch({ pr: { enabled: true } });
  try {
    const { id } = s.f('job', 'new', '--title', 'Hello script', '--session', 'S');
    const r = s.raw('job', 'advance', id, '--session', 'S');
    assert.equal(r.status, 0, r.stderr);
    const a = oneJsonLine(r.stdout);
    assert.equal(a.action, 'spawn');
    assert.equal(a.rule, 'SP1');
    assert.equal(a.role, 'spec-writer');
    assert.deepEqual(
      a.ran.map((e: any) => [e.rule, e.command, e.ok]),
      [
        ['I3', ['worktree', 'create', id], true],
        ['I5', ['pr', 'find', id], true],
        ['I8', ['job', 'set', id, '--stage', 'spec', '--state', 'running'], true],
      ],
    );
    assertRanShape(a.ran);
    const job = loadJob(s.root, id);
    assert.equal(job.stage, 'spec');
    assert.ok(job.worktree && fs.existsSync(job.worktree), 'the worktree exists');

    // AC2: what advance returned is what step decides next, and step stays read-only.
    const { ran: _ran, ...action } = a;
    const dir = jobDir(s.root, id);
    const before = snapshot(dir);
    const first = s.raw('job', 'step', id);
    const second = s.raw('job', 'step', id);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), action);
    assert.equal(second.stdout, first.stdout, 'step prints byte-identical output');
    assert.deepEqual(snapshot(dir), before, 'step leaves the job dir byte-identical');
  } finally {
    s.cleanup();
  }
});

test('advance stops at the first failed run and prints no command output', POSIX, () => {
  const s = scratch({ commands: { build: 'true', lint: 'true', test: 'for i in 1 2 3 4 5; do echo TAIL-MARKER; done; exit 1' } });
  try {
    const { id } = s.f('job', 'new', '--title', 'Failing tests', '--session', 'S');
    s.f('worktree', 'create', id);
    // Round 1, as after a build: at round 0 the build stage would first start a round (B1).
    s.f('job', 'round', id);
    s.f('job', 'set', id, '--stage', 'verify', '--state', 'running');
    const r = s.raw('job', 'advance', id, '--session', 'S');
    assert.equal(r.status, 1, r.stderr);
    assert.ok(!r.stdout.includes('TAIL-MARKER'), 'no command tail on stdout');
    const a = oneJsonLine(r.stdout);
    assert.equal(a.action, 'run');
    assert.equal(a.failed, true);
    assert.equal(a.rule, 'V1');
    assert.deepEqual(a.command, ['verify', id]);
    assert.match(a.error, /failure=test/);
    assert.ok(!a.error.includes('\n'));
    assert.equal(a.ran.at(-1).ok, false);
    assert.equal(a.ran.at(-1).error, a.error);
    assertRanShape(a.ran);
    assert.equal(loadJob(s.root, id).stage, 'verify', 'nothing ran after verify');

    const again = s.raw('job', 'advance', id, '--session', 'S');
    assert.equal(again.status, 0, again.stderr);
    const b = oneJsonLine(again.stdout);
    assert.deepEqual(b.ran.map((e: any) => e.rule), ['V3']);
    assert.equal(b.action, 'spawn');
    assert.equal(b.rule, 'B4');
    assert.equal(b.role, 'builder');
  } finally {
    s.cleanup();
  }
});

test('summarize keeps one short line and drops tails', () => {
  assert.equal(summarize(null), 'none');
  assert.equal(summarize(undefined), 'none');
  assert.equal(summarize('  a\nb \t\r\n c  '), 'a b c');
  assert.equal(summarize([1, 2, 3]), '3 items');
  const verifyShaped = {
    ok: false,
    round: 1,
    attempt: 2,
    sha: 'abc',
    file: '.forge/jobs/x/verify/round-1.md',
    steps: [{ name: 'test', ok: false, code: 1, secret: 'STEP-DETAIL' }],
    failure: { name: 'test', code: 1, tail: 'TAIL-MARKER\nTAIL-MARKER' },
  };
  const v = summarize(verifyShaped);
  assert.equal(v, 'ok=false round=1 attempt=2 file=.forge/jobs/x/verify/round-1.md failure=test');
  assert.ok(!/steps|STEP-DETAIL|TAIL-MARKER/.test(v));
  assert.equal(summarize({ failure: 'lint', conflicts: ['a', 'b'] }), 'failure=lint conflicts=2');
  assert.equal(summarize({ brief: 'long text' }), 'ok');
  assert.equal(summarize({ error: 'line one\nline two' }), 'error=line one line two');
  const long = summarize({ ok: true, url: `https://example.com/${'x'.repeat(500)}` });
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
  assert.ok(long.startsWith('ok=true url=https://example.com/'));
  // Collapsing whitespace stays linear on a hostile 10k-character line.
  const hostile = summarize(`${' \n'.repeat(5000)}x${'\t'.repeat(10000)}`);
  assert.equal(hostile, 'x');
  // A cut never leaves half a surrogate pair.
  const emoji = summarize('a'.repeat(198) + '😀'.repeat(10));
  assert.ok(emoji.length <= 200);
  assert.doesNotThrow(() => encodeURIComponent(emoji));
});

test('advance --max caps the commands it runs', POSIX, () => {
  const s = scratch({ pr: { enabled: true } });
  try {
    const { id } = s.f('job', 'new', '--title', 'Capped', '--session', 'S');
    const dir = jobDir(s.root, id);
    for (const bad of ['-1', 'abc']) {
      const before = snapshot(dir);
      const r = s.raw('job', 'advance', id, '--session', 'S', '--max', bad);
      assert.equal(r.status, 1, `--max ${bad}`);
      assert.match(r.stderr, /--max must be a non-negative integer/);
      assert.equal(r.stdout, '');
      assert.deepEqual(snapshot(dir), before, `--max ${bad} writes nothing`);
    }

    const zero = s.raw('job', 'advance', id, '--session', 'S', '--max', '0');
    assert.equal(zero.status, 0, zero.stderr);
    const z = oneJsonLine(zero.stdout);
    const { ran: zr, capped: zc, ...zAction } = z;
    assert.deepEqual(zr, []);
    assert.equal(zc, true);
    assert.deepEqual(zAction, s.f('job', 'step', id));
    assert.equal(z.rule, 'I3');

    const one = s.raw('job', 'advance', id, '--session', 'S', '--max', '1');
    assert.equal(one.status, 0, one.stderr);
    const o = oneJsonLine(one.stdout);
    assert.equal(o.action, 'run');
    assert.equal(o.rule, 'I5');
    assert.equal(o.capped, true);
    assert.deepEqual(o.ran.map((e: any) => e.rule), ['I3']);
    assert.ok(!readEvents(s.root, id).some((e) => e.type === 'pr-find'), 'I5 did not run');
  } finally {
    s.cleanup();
  }
});

test('advance refuses a job its session does not hold', () => {
  const s = scratch();
  try {
    const held = s.f('job', 'new', '--title', 'Held', '--session', 'A').id;
    const free = s.f('job', 'new', '--title', 'Free').id;
    const cases: [string, string[], number, RegExp][] = [
      [held, ['--session', 'B'], 3, /job \S+ is being driven by session A; advance only drives a job its session holds/],
      [free, ['--session', 'B'], 3, /job \S+ is not claimed by session B; run: forge job claim \S+ --session B/],
      [held, [], 1, /missing --session/],
    ];
    for (const [id, args, code, msg] of cases) {
      const dir = jobDir(s.root, id);
      const before = snapshot(dir);
      const r = s.raw('job', 'advance', id, ...args);
      assert.equal(r.status, code, r.stderr);
      assert.match(r.stderr, msg);
      assert.equal(r.stdout, '');
      assert.deepEqual(snapshot(dir), before, `${args.join(' ')}: the job dir is byte-identical`);
    }
    const unknown = s.raw('job', 'advance', 'no-such-job', '--session', 'S');
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /no job "no-such-job"/);
  } finally {
    s.cleanup();
  }
});

test('advance continues past releasing its own claim and refreshes the heartbeat', async () => {
  const s = scratch();
  try {
    const { id } = s.f('job', 'new', '--title', 'Waits on review', '--session', 'S');
    s.f('job', 'set', id, '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review');
    const r = s.raw('job', 'advance', id, '--session', 'S');
    assert.equal(r.status, 0, r.stderr);
    const a = oneJsonLine(r.stdout);
    assert.equal(a.action, 'wait');
    assert.equal(a.rule, 'G3');
    assert.deepEqual(a.ran.map((e: any) => [e.rule, e.command, e.ok]), [['G3', ['job', 'release', id], true]]);
    assert.equal(loadJob(s.root, id).owner, null);

    const kept = s.f('job', 'new', '--title', 'Still held', '--session', 'S').id;
    const before = loadJob(s.root, kept).owner!.heartbeat!;
    await sleep(20);
    const k = s.raw('job', 'advance', kept, '--session', 'S', '--max', '0');
    assert.equal(k.status, 0, k.stderr);
    const after = loadJob(s.root, kept).owner!.heartbeat!;
    assert.ok(Date.parse(after) > Date.parse(before), `${after} is later than ${before}`);
  } finally {
    s.cleanup();
  }
});

test('advance stops when another session takes the job mid-call', async () => {
  const s = scratch();
  try {
    const { id } = s.f('job', 'new', '--title', 'Taken', '--session', 'S');
    const { config, initialized } = loadConfig(s.root);
    const ctx = { root: s.root, config, initialized };
    let calls = 0;
    const wrapper = (argv: string[], c: typeof ctx) => {
      if (++calls === 1) claimJob(s.root, id, 'B', true);
      return dispatch(argv, c);
    };
    const saved = process.exitCode;
    const r = await advance(ctx, id, { session: 'S', max: 20 }, wrapper);
    process.exitCode = saved;
    assert.equal(r.exitCode, 3);
    const d = r.data as any;
    assert.equal(d.refused, true);
    assert.equal(d.owner, 'B');
    assert.equal(d.ran.length, 1);
    assert.equal(calls, 1);
    assert.equal(loadJob(s.root, id).owner!.session, 'B');
  } finally {
    s.cleanup();
  }
});

test('only the commands step emits run in-process', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'step.ts'), 'utf8');
  const groups = new Set([...src.matchAll(/\brun\(x, '[A-Z0-9]+', \['([a-z]+)'/g)].map((m) => m[1]));
  assert.ok(groups.size >= 5, `found ${[...groups].join(',')}`);
  groups.add('job');
  for (const g of groups) assert.equal(runnableInProcess([g, 'x']), true, g);
  for (const argv of [['config', 'set'], ['init', 'write'], ['migrate'], ['update'], ['dash'], ['daemon', 'status'], ['git', 'log'], ['requests'], ['tracker', 'list'], ['next'], ['sync'], ['job', 'advance', 'x']]) {
    assert.equal(runnableInProcess(argv), false, argv.join(' '));
  }
});

test('dispatch returns data and exit codes without printing', POSIX, async () => {
  const s = scratch({ commands: { build: 'true', lint: 'true', test: 'echo TAIL-MARKER; exit 1' } });
  const write = process.stdout.write;
  const written: string[] = [];
  const saved = process.exitCode;
  try {
    const { id } = s.f('job', 'new', '--title', 'Dispatched');
    s.f('worktree', 'create', id);
    const { config, initialized } = loadConfig(s.root);
    const ctx = { root: s.root, config, initialized };
    process.exitCode = undefined;
    process.stdout.write = ((chunk: any) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const shown = await dispatch(['job', 'show', id], ctx);
    const verified = await dispatch(['verify', id], ctx);
    const exitAfter = process.exitCode;
    process.stdout.write = write;
    assert.equal(shown.exitCode, 0);
    assert.equal((shown.data as any).id, id);
    assert.equal(verified.exitCode, 1);
    assert.equal((verified.data as any).ok, false);
    assert.equal(exitAfter, undefined, 'process.exitCode is untouched');
    assert.deepEqual(written, [], 'nothing on stdout');
  } finally {
    process.stdout.write = write;
    process.exitCode = saved;
    s.cleanup();
  }
});

test('job usage and help list advance', () => {
  const s = scratch();
  try {
    const bogus = s.raw('job', 'bogus');
    assert.equal(bogus.status, 1);
    assert.match(bogus.stderr, /usage: forge job [^\n]*\|advance\b/);
    assert.match(bogus.stderr, /usage: forge job [^\n]*\|acs/);
    assert.match(bogus.stderr, /usage: forge job [a-z|-]*\|step\b/);
    const help = s.raw('help');
    assert.equal(help.status, 0);
    assert.ok(help.stdout.includes('forge job advance <id> --session S [--max N]'));
  } finally {
    s.cleanup();
  }
});
