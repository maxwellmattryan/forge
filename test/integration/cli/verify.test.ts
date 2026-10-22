// `forge verify` through the CLI. Groups (config schemaVersion 3): the steps of a list entry run at
// the same time, the next entry waits for all of them, results keep config order, and verify
// refuses a config it can't read. And e2e: when verify appends commands.e2e and how it reports it.
// The pure decisions (verify list shape, e2ePlan) are in test/verify.test.ts.
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, forgeSync, repoTemplate } from '../../helpers.ts';
import { defaults, loadConfig, stringifyConfig, validateConfig } from '../../../lib/config.ts';
import { createJob, jobDir, loadJob, readEvents, setJob, updateJob } from '../../../lib/jobs.ts';
import { CONFIG_SCHEMA_VERSION } from '../../../lib/schema.ts';
import { deepMerge } from '../../../lib/shape.ts';
import { createWorktree } from '../../../lib/worktree.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/**
 * One verify step: `node rv.mjs <markers> <events> <me> [--needs X,Y] [--meet A,B] [--after X] [--fail] [--within MS]`.
 * --needs fails unless X and Y already finished; --meet marks this step started and waits up to
 * 10 s (--within) for A and B to start too, so steps run one after another fail; --after waits
 * until Forge has recorded X's `command` event, i.e. X has finished as verify sees it; --fail
 * exits 1. Every step marks itself finished on the way out, failing or not.
 */
const RV = `import fs from 'node:fs';
import path from 'node:path';
const [dir, events, me, ...rest] = process.argv.slice(2);
const opt = (k) => { const i = rest.indexOf(k); return i < 0 ? null : rest[i + 1] ?? ''; };
const list = (k) => (opt(k) ?? '').split(',').filter(Boolean);
fs.mkdirSync(dir, { recursive: true });
const mark = (name, kind) => fs.writeFileSync(path.join(dir, name + '.' + kind), '');
const has = (name, kind) => fs.existsSync(path.join(dir, name + '.' + kind));
const recorded = (name) => { try { return fs.readFileSync(events, 'utf8').split('\\n').some((l) => l.includes('"type":"command"') && l.includes('"name":"' + name + '"')); } catch { return false; } };
const sleep = new Int32Array(new SharedArrayBuffer(4));
const within = Number(opt('--within') ?? 10000);
const quit = (code, why) => { if (why) console.error(me + ': ' + why); mark(me, 'done'); process.exit(code); };
const waitFor = (ok, what) => {
  const until = Date.now() + within;
  while (!ok()) {
    if (Date.now() > until) quit(2, 'no ' + what + ' after ' + within + ' ms');
    Atomics.wait(sleep, 0, 0, 20);
  }
};
for (const n of list('--needs')) if (!has(n, 'done')) quit(3, n + ' has not finished');
mark(me, 'start');
for (const s of list('--meet')) waitFor(() => has(s, 'start'), s + '.start');
for (const s of list('--after')) waitFor(() => recorded(s), s + "'s command event");
console.log(me + ' ran');
quit(rest.includes('--fail') ? 1 : 0);
`;

function writeAnswers(root: string, answers: unknown): string {
  const file = path.join(root, '..', `answers-${path.basename(root)}.json`);
  fs.writeFileSync(file, JSON.stringify(answers));
  return file;
}

/** `forge init write` with `answers` in `dir`. */
function initWrite(dir: string, answers: unknown, ...flags: string[]) {
  const file = writeAnswers(dir, answers);
  try {
    const r = forgeSync(dir, ['init', 'write', '--answers', file, ...flags]);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

const commitAll = (cwd: string, msg: string) => {
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['commit', '-qm', msg], { cwd });
};

/** A git repo with one commit and no Forge config, for the tests that write their own. */
const bareRepo = repoTemplate(() => {});

const GROUPS_BASE = { tracker: { kind: 'none' }, worktrees: { root: '../{repo}.wt' } };
const groupsRepo = repoTemplate((dir) => {
  fs.writeFileSync(path.join(dir, 'rv.mjs'), RV);
  initWrite(dir, GROUPS_BASE);
  commitAll(dir, 'forge + rv');
});

/** One scratch repo for the file, with Forge initialised and rv.mjs committed; each case gets its own job. */
function scratch() {
  const repo = groupsRepo();
  const root = repo.dir;
  const markers = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rv-')));
  const step = (me: string, flags = '') => `node rv.mjs '${markers}/{job}' '{root}/.forge/jobs/{job}/events.jsonl' ${me}${flags ? ` ${flags}` : ''}`;
  const cfgFile = path.join(root, '.forge', 'config.yml');
  return {
    root,
    cfgFile,
    step,
    /** Writes config.yml from defaults plus `answers`, unvalidated: some cases are invalid on purpose. */
    configure(answers: Record<string, any>) {
      const config: any = deepMerge(deepMerge(defaults(), structuredClone(GROUPS_BASE)), structuredClone(answers));
      if (answers.verify) config.verify = answers.verify;
      fs.writeFileSync(cfgFile, stringifyConfig(config));
    },
    /** A job in round 1 with a worktree on a fresh branch, set up in-process: only verify is under test. */
    job(title: string) {
      const { config } = loadConfig(root);
      const id = createJob(root, config, { title }).id;
      const wt = createWorktree(root, config, id);
      assert.equal(wt.ok, true, JSON.stringify(wt));
      updateJob(root, id, (j) => (j.round = 1));
      return { id, dir: jobDir(root, id), wt: wt.path };
    },
    verify(id: string, extraEnv: NodeJS.ProcessEnv = {}) {
      const r = forgeSync(root, ['verify', id], extraEnv);
      let out: any = null;
      try {
        out = JSON.parse(r.stdout);
      } catch {}
      return { status: r.status, out, stdout: r.stdout, stderr: r.stderr };
    },
    logs: (dir: string) => (fs.existsSync(path.join(dir, 'logs')) ? fs.readdirSync(path.join(dir, 'logs')).sort() : []),
    /** `command` events in the order verify recorded them, i.e. the order the steps finished. */
    commands: (id: string) => readEvents(root, id).filter((e) => e.type === 'command').map((e: any) => e.name as string),
    roundMd: (dir: string) => fs.readFileSync(path.join(dir, 'verify', 'round-1.md'), 'utf8'),
    cleanup() {
      repo.cleanup();
      fs.rmSync(`${root}.wt`, { recursive: true, force: true });
      fs.rmSync(markers, { recursive: true, force: true });
    },
  };
}

let shared: ReturnType<typeof scratch> | null = null;
const s = () => (shared ??= scratch());
after(() => shared?.cleanup());

test('forge migrate rewrites a v1 or v2 config, and grouped verify round-trips through init', () => {
  const repo = bareRepo();
  const cfg = path.join(repo.dir, '.forge', 'config.yml');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  try {
    for (const v of [1, 2]) {
      fs.writeFileSync(cfg, `schemaVersion: ${v}\nverify:\n  - build\n  - lint\n`);
      const loaded = loadConfig(repo.dir);
      assert.equal(loaded.config.schemaVersion, CONFIG_SCHEMA_VERSION, `v${v}`);
      assert.deepEqual(loaded.config.verify, ['build', 'lint'], `v${v}: verify unchanged`);
      assert.equal(loaded.migratedFrom, v);
    }
    const m = forgeSync(repo.dir, ['migrate']);
    assert.equal(m.status, 0, m.stderr);
    assert.deepEqual(JSON.parse(m.stdout).changed, ['.forge/config.yml']);
    assert.match(fs.readFileSync(cfg, 'utf8'), new RegExp(`^schemaVersion: ${CONFIG_SCHEMA_VERSION}$`, 'm'));
    assert.deepEqual(loadConfig(repo.dir).config.verify, ['build', 'lint']);

    fs.rmSync(cfg);
    initWrite(repo.dir, { verify: ['build', ['lint', 'test'], 'e2e'] });
    const loaded = loadConfig(repo.dir);
    assert.deepEqual(loaded.config.verify, ['build', ['lint', 'test'], 'e2e']);
    assert.equal(loaded.config.schemaVersion, CONFIG_SCHEMA_VERSION);
    assert.equal(loaded.migratedFrom, undefined);
  } finally {
    repo.cleanup();
  }
});

test('steps in a group run at the same time, after the steps before it', () => {
  const x = s();
  x.configure({
    commands: {
      build: x.step('build'),
      a: x.step('a', '--needs build --meet b,c'),
      b: x.step('b', '--needs build --meet a,c'),
      c: x.step('c', '--needs build --meet a,b'),
      d: x.step('d', '--needs a,b,c'),
    },
    verify: ['build', ['a', 'b', 'c'], 'd'],
  });
  const j = x.job('Concurrent');
  const r = x.verify(j.id);
  assert.equal(r.status, 0, `${r.stderr} ${JSON.stringify(r.out)}`);
  assert.equal(r.out.ok, true);
  assert.deepEqual(r.out.steps.map((st: any) => [st.name, st.ok]), [['secrets', true], ['protected', true], ['build', true], ['a', true], ['b', true], ['c', true], ['d', true]]);
  const cmds = x.commands(j.id);
  assert.equal(cmds[0], 'build', 'build finished first');
  assert.deepEqual(cmds.slice(1, 4).sort(), ['a', 'b', 'c']);
  assert.equal(cmds[4], 'd', 'd finished last');

  // Control: one after another, the same steps never meet, so the rendezvous does prove concurrency.
  x.configure({ commands: { a: x.step('a', '--meet b --within 300'), b: x.step('b', '--meet a --within 300') }, verify: ['a', 'b'] });
  const seq = x.job('Sequential');
  const fail = x.verify(seq.id);
  assert.equal(fail.status, 1);
  assert.equal(fail.out.failure.name, 'a');
  assert.match(fail.out.failure.tail, /a: no b\.start after 300 ms/);
  assert.deepEqual(x.commands(seq.id), ['a'], 'b never ran');
});

test('a failing group finishes its siblings, reports the first failure in config order and stops before the next entry', () => {
  const x = s();
  x.configure({ commands: { a: x.step('a', '--after c --fail'), b: x.step('b'), c: x.step('c', '--fail'), d: x.step('d') }, verify: [['a', 'b', 'c'], 'd'] });
  const j = x.job('Failing group');
  const r = x.verify(j.id);
  assert.equal(r.status, 1);
  assert.equal(r.out.ok, false);
  assert.equal(r.out.failure.name, 'a', 'the first failure in config order, not the first to finish');
  assert.deepEqual(r.out.steps.map((st: any) => [st.name, st.ok]), [['secrets', true], ['protected', true], ['a', false], ['b', true], ['c', false]]);
  const cmds = x.commands(j.id);
  assert.deepEqual([...cmds].sort(), ['a', 'b', 'c'], 'one command event per group step, none for d');
  assert.ok(cmds.indexOf('c') < cmds.indexOf('a'), `c finished before a: ${cmds}`);
  const logs = x.logs(j.dir);
  for (const name of ['a', 'b', 'c']) assert.equal(logs.filter((l) => l.startsWith(`verify-${name}-`)).length, 1, `${name} has a log`);
  assert.equal(logs.filter((l) => l.startsWith('verify-d-')).length, 0, 'd has no log');
  assert.equal(loadJob(x.root, j.id).verifyRuns.at(-1)!.failure, 'a');
  const md = x.roundMd(j.dir);
  assert.match(md, /^## a: FAILED \(exit 1\)$/m);
  assert.match(md, /^## b: ok$/m);
  assert.match(md, /^## c: FAILED \(exit 1\)$/m);
  assert.doesNotMatch(md, /^## d/m, 'no section for d');
});

test('round-N.md and steps keep config order whatever finishes first', () => {
  const x = s();
  x.configure({ commands: { a: x.step('a', '--after b'), b: x.step('b', '--after c'), c: x.step('c') }, verify: [['a', 'b', 'c']] });
  const j = x.job('Reverse');
  const r = x.verify(j.id);
  assert.equal(r.status, 0, `${r.stderr} ${JSON.stringify(r.out)}`);
  assert.deepEqual(x.commands(j.id), ['c', 'b', 'a'], 'they finished in reverse config order');
  assert.deepEqual(r.out.steps.map((st: any) => st.name), ['secrets', 'protected', 'a', 'b', 'c']);
  const md = x.roundMd(j.dir);
  assert.deepEqual([...md.matchAll(/^## (\w+): /gm)].map((m) => m[1]).filter((n) => n !== 'integrity' && n !== 'secrets' && n !== 'protected'), ['a', 'b', 'c']);
  for (const name of ['a', 'b', 'c']) assert.match(md, new RegExp(`^## ${name}: ok\\n\\n\`node rv\\.mjs [^\`]+ ${name}\\b[^\`]*\` · log: \`logs/verify-${name}-`, 'm'));
});

test('an unset command in a group is skipped in place', () => {
  const x = s();
  x.configure({ commands: { x: x.step('x', '--meet y'), skipme: null, y: x.step('y', '--meet x') }, verify: [['x', 'skipme', 'y']] });
  const j = x.job('Skipped');
  const r = x.verify(j.id);
  assert.equal(r.status, 0, `${r.stderr} ${JSON.stringify(r.out)}`);
  assert.deepEqual(r.out.steps.map((st: any) => [st.name, st.ok, st.skipped ?? false]), [['secrets', true, false], ['protected', true, false], ['x', true, false], ['skipme', true, true], ['y', true, false]]);
  assert.deepEqual(r.out.steps[3], { name: 'skipme', ok: true, skipped: true });
  assert.deepEqual(x.commands(j.id).sort(), ['x', 'y']);
  const md = x.roundMd(j.dir);
  assert.deepEqual(
    [...md.matchAll(/^## (\w+): (.*)$/gm)].map((m) => [m[1], m[2]]).filter(([n]) => n !== 'integrity' && n !== 'secrets' && n !== 'protected'),
    [['x', 'ok'], ['skipme', 'skipped (no command configured)'], ['y', 'ok']],
  );
});

test('a group step past the 64 MiB output cap, or one that cannot start, fails without an exit code', () => {
  const x = s();
  // One byte over the cap, as spawnSync's maxBuffer is for the sequential path.
  x.configure({ commands: { big: `node -e "process.stdout.write(Buffer.alloc(64 * 1024 * 1024 + 1))"`, small: x.step('small') }, verify: [['big', 'small']] });
  const j = x.job('Overflow');
  const r = x.verify(j.id);
  assert.equal(r.status, 1);
  assert.equal(r.out.failure.name, 'big');
  assert.equal(r.out.failure.exit, null);
  assert.match(r.out.failure.tail, /ENOBUFS: stdout passed 64 MiB, so the command was stopped/);
  assert.equal(r.out.steps[3].ok, true, 'the sibling still finished');
  assert.match(x.roundMd(j.dir), /^## big: FAILED \(exit null\)$/m);

  x.configure({ commands: { a: 'true', b: 'true' }, verify: [['a', 'b']] });
  const k = x.job('No shell');
  const gone = x.verify(k.id, { SHELL: path.join(x.root, 'no-such-shell') });
  assert.equal(gone.status, 1);
  assert.deepEqual(gone.out.steps.map((st: any) => [st.name, st.ok, st.exit]), [['secrets', true, null], ['protected', true, null], ['a', false, null], ['b', false, null]]);
  assert.match(gone.out.failure.tail, /ENOENT/);
});

test('e2e listed inside a group is not run again', () => {
  const x = s();
  x.configure({ commands: { test: 'true', e2e: 'echo E2E-RAN' }, verify: [['test', 'e2e']], verifyE2e: { when: 'always' } });
  const j = x.job('E2E in a group');
  const r = x.verify(j.id);
  assert.equal(r.status, 0, `${r.stderr} ${JSON.stringify(r.out)}`);
  assert.deepEqual(r.out.steps.map((st: any) => st.name), ['secrets', 'protected', 'test', 'e2e']);
  assert.equal(r.out.steps[2].reason, undefined, 'a group step, not the appended verifyE2e step');
  assert.equal(x.logs(j.dir).filter((l) => l.startsWith('verify-e2e-')).length, 1);
  assert.deepEqual(x.commands(j.id).sort(), ['e2e', 'test']);
});

test('verify refuses a newer config and a malformed verify list without running anything', () => {
  const x = s();
  x.configure({ commands: { test: x.step('test') }, verify: ['test'] });
  const good = fs.readFileSync(x.cfgFile, 'utf8');
  const j = x.job('Refused');
  const withVerify = (lines: string) => good.replace(/^verify:\n(?: {2}- .*\n)+/m, `verify:\n${lines}`);
  assert.notEqual(withVerify('  - [test]\n'), good, 'the fixture has a verify block to replace');
  const cases: [string, string][] = [
    [
      good.replace(new RegExp(`^schemaVersion: ${CONFIG_SCHEMA_VERSION}$`, 'm'), `schemaVersion: ${CONFIG_SCHEMA_VERSION + 1}`),
      `forge: config schemaVersion ${CONFIG_SCHEMA_VERSION + 1} is newer than this Forge (${CONFIG_SCHEMA_VERSION}); update Forge before running verify`,
    ],
    [withVerify('  - []\n'), 'forge: verify: verify entry 1 must be a step name or a non-empty list of step names (got [])'],
    [withVerify('  - test\n  - [test]\n'), 'forge: verify: verify step "test" is listed more than once'],
  ];
  // Clean, then with an untracked file in the worktree: the refusal comes before the clean check,
  // so a dirty worktree gets the same message and no worktree-clean run is recorded either.
  const stray = path.join(j.wt, 'stray.txt');
  for (const dirty of [false, true]) {
    if (dirty) fs.writeFileSync(stray, 'x\n');
    for (const [text, message] of cases) {
      fs.writeFileSync(x.cfgFile, text);
      const r = x.verify(j.id);
      assert.equal(r.status, 1, message);
      assert.equal(r.stdout, '', `${message}: no result, so no worktree-clean step`);
      assert.equal(r.stderr.trim(), message);
      assert.deepEqual(loadJob(x.root, j.id).verifyRuns, [], `${message}: no verify run recorded`);
      assert.equal(fs.existsSync(path.join(j.dir, 'verify', 'round-1.md')), false);
      assert.deepEqual(x.logs(j.dir), []);
      assert.deepEqual(x.commands(j.id), []);
    }
  }
  fs.rmSync(stray);
  fs.writeFileSync(x.cfgFile, withVerify('  - [test]\n'));
  const r = x.verify(j.id);
  assert.equal(r.status, 0, `${r.stderr} ${JSON.stringify(r.out)}`);
  assert.equal(loadJob(x.root, j.id).verifyRuns.length, 1);
  assert.deepEqual(x.commands(j.id), ['test']);
});

test("this repo's config groups lint, typecheck and test after build", () => {
  const { config } = loadConfig(ROOT);
  assert.equal(config.schemaVersion, CONFIG_SCHEMA_VERSION);
  assert.deepEqual(config.verify, ['build', ['lint', 'typecheck', 'test']]);
  assert.deepEqual(validateConfig(config, ROOT).filter((p) => p.startsWith('verify')), []);
  // Named files when `forge run <job> test -- <files>` passes them, the whole suite otherwise; the
  // `#` after `$` is not a YAML comment.
    assert.equal(config.commands.test, `set -- {args}; [ $# -gt 0 ] || set -- 'test/**/*.test.ts'; node --test "$@"`);
});

const write = (dir: string, rel: string, text = 'x\n') => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

const E2E_BASE = { commands: { test: 'true', e2e: 'echo E2E-RAN' }, verify: ['test'], worktrees: { root: '../{repo}.wt' } };
const e2eRepo = repoTemplate((dir) => {
  initWrite(dir, E2E_BASE);
  commitAll(dir, 'forge init');
});

/** A scratch repo with Forge initialised; each case gets its own job so verify attempts don't mix. */
async function e2eScratch() {
  const repo = e2eRepo();
  const raw = (...args: string[]) => forgeAsync(repo.dir, args);
  const f = async (...args: string[]) => {
    const r = await raw(...args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return r.stdout.trim();
    }
  };
  /** Rewrites the config from the base answers plus overrides. */
  const configure = async (extra: Record<string, any> = {}) => {
    const answers: Record<string, any> = structuredClone(E2E_BASE);
    for (const [k, v] of Object.entries(extra)) answers[k] = typeof v === 'object' && v && !Array.isArray(v) ? { ...answers[k], ...v } : v;
    const file = writeAnswers(repo.dir, answers);
    try {
      await f('init', 'write', '--answers', file, '--force');
    } finally {
      fs.rmSync(file, { force: true });
    }
  };
  /** A job whose branch commits the given files; returns its id, worktree and job dir. */
  const job = async (files: string[]) => {
    const j = await f('job', 'new', '--title', `e2e ${files.join(' ')}`);
    const wt = (await f('worktree', 'create', j.id)).path;
    for (const rel of files) write(wt, rel);
    commitAll(wt, 'job work');
    await f('job', 'round', j.id);
    return { id: j.id, wt, dir: path.join(repo.dir, j.dir) };
  };
  const verify = async (id: string) => {
    const r = await raw('verify', id);
    return { status: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
  };
  const roundMd = (dir: string) => fs.readFileSync(path.join(dir, 'verify', 'round-1.md'), 'utf8');
  const e2eLogs = (dir: string) => (fs.existsSync(path.join(dir, 'logs')) ? fs.readdirSync(path.join(dir, 'logs')).filter((x) => /^verify-e2e-.*\.log$/.test(x)) : []);
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
  };
  return { repo, f, raw, configure, job, verify, roundMd, e2eLogs, cleanup };
}

// Each test has its own scratch repo, so they run side by side.
describe('verify runs e2e', { concurrency: 4 }, () => {
  test('e2e runs for UI diffs and is skipped otherwise', async () => {
    const s = await e2eScratch();
    try {
      const ui = await s.job(['web/app.css']);
      let r = await s.verify(ui.id);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.out.ok, true);
      const e2e = r.out.steps.find((x: any) => x.name === 'e2e');
      assert.equal(e2e.ok, true);
      assert.ok(!e2e.skipped);
      assert.ok(e2e.reason.startsWith('UI paths changed: web/app.css'), e2e.reason);
      assert.deepEqual(r.out.steps.map((x: any) => x.name), ['secrets', 'protected', 'test', 'e2e']);
      const md = s.roundMd(ui.dir);
      assert.ok(md.startsWith('VERIFY: PASS'));
      assert.match(md, /## e2e: ok/);
      assert.match(md, /Trigger: UI paths changed: web\/app\.css/);
      const logs = s.e2eLogs(ui.dir);
      assert.equal(logs.length, 1);
      assert.match(fs.readFileSync(path.join(ui.dir, 'logs', logs[0]), 'utf8'), /E2E-RAN/);

      // More than three UI files: the reason lists three and counts the rest.
      const many = await s.job(['a.html', 'b.css', 'c.tsx', 'd.vue', 'e.svelte']);
      r = await s.verify(many.id);
      assert.equal(r.out.steps.find((x: any) => x.name === 'e2e').reason, 'UI paths changed: a.html, b.css, c.tsx (+2 more)');
    } finally {
      s.cleanup();
    }
  });

  // The other decisions (no command, listed in verify, custom paths) are rows of
  // test/verify.test.ts › "e2ePlan: when always/never, no command, listed in verify, custom paths".
  test('e2e skipped without UI paths, run when always, left out when never', async () => {
    const s = await e2eScratch();
    try {
      const lib = await s.job(['lib/x.mjs']);
      let r = await s.verify(lib.id);
      assert.equal(r.status, 0);
      assert.deepEqual(r.out.steps.find((x: any) => x.name === 'e2e'), { name: 'e2e', ok: true, skipped: true, reason: 'no UI paths changed' });
      assert.match(s.roundMd(lib.dir), /## e2e: skipped \(no UI paths changed\)/);
      assert.doesNotMatch(s.roundMd(lib.dir), /Trigger:/);
      assert.equal(s.e2eLogs(lib.dir).length, 0);

      await s.configure({ verifyE2e: { when: 'always' } });
      r = await s.verify(lib.id);
      const e2e = r.out.steps.find((x: any) => x.name === 'e2e');
      assert.equal(e2e.skipped, undefined);
      assert.equal(e2e.reason, 'verifyE2e.when: always');
      assert.match(s.roundMd(lib.dir), /Trigger: verifyE2e\.when: always/);
      assert.equal(s.e2eLogs(lib.dir).length, 1);

      const ui = await s.job(['web/app.css']);
      await s.configure({ verifyE2e: { when: 'never' } });
      r = await s.verify(ui.id);
      assert.equal(r.out.steps.find((x: any) => x.name === 'e2e'), undefined);
      // Word-bounded: commit shas in the report are hex and can contain "e2e" (e.g. 9e2eed0).
      assert.doesNotMatch(s.roundMd(ui.dir), /\be2e\b/);
    } finally {
      s.cleanup();
    }
  });

  test('e2e failure fails verify; unresolvable base runs it', async () => {
    const s = await e2eScratch();
    try {
      await s.configure({ commands: { e2e: 'false' } });
      const ui = await s.job(['web/app.css']);
      const r = await s.verify(ui.id);
      assert.equal(r.status, 1);
      assert.equal(r.out.ok, false);
      assert.equal(r.out.failure.name, 'e2e');
      assert.equal(r.out.failure.exit, 1);
      assert.equal(await s.f('job', 'get', ui.id, 'verify.1'), 'FAIL');
      assert.equal(await s.f('job', 'get', ui.id, 'verifyRetries.1'), 1);
      const md = s.roundMd(ui.dir);
      assert.ok(md.startsWith('VERIFY: FAIL'));
      assert.match(md, /## e2e: FAILED \(exit 1\)/);

      // An unresolvable base also stops the secret scan, which fails verify under the default
      // `block`; under `warn` it passes with an error, so the e2e decision is still reached.
      // The protected-paths check reads it too and fails closed, so the policy is off here.
      await s.configure({ verifySecrets: 'warn', policy: { protectedPaths: [] } });
      const lib = await s.job(['lib/x.mjs']);
      setJob(s.repo.dir, lib.id, { fields: { base: 'no-such-branch' } });
      const b = await s.verify(lib.id);
      assert.equal(b.status, 0);
      const e2e = b.out.steps.find((x: any) => x.name === 'e2e');
      assert.equal(e2e.ok, true);
      assert.equal(e2e.reason, 'base not found; ran to be safe');
    } finally {
      s.cleanup();
    }
  });

  // The validateConfig half is test/verify.test.ts › "verifyE2e config validation".
  test('verifyE2e config defaults and validation', async () => {
    const repo = bareRepo();
    const cfgFile = path.join(repo.dir, '.forge', 'config.yml');
    const forge = (...args: string[]) => forgeAsync(repo.dir, args);
    try {
      fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
      fs.writeFileSync(cfgFile, `schemaVersion: ${CONFIG_SCHEMA_VERSION}\n`);
      assert.equal((await forge('config', 'get', 'verifyE2e.when')).stdout.trim(), 'ui');
      assert.equal((await forge('config', 'validate')).status, 0);

      fs.writeFileSync(cfgFile, `schemaVersion: ${CONFIG_SCHEMA_VERSION}\nverifyE2e:\n  when: sometimes\n`);
      let r = await forge('config', 'validate');
      assert.equal(r.status, 1);
      assert.match(r.stdout, /verifyE2e\.when must be one of ui \| always \| never/);

      fs.writeFileSync(cfgFile, `schemaVersion: ${CONFIG_SCHEMA_VERSION}\nverifyE2e:\n  paths: "*.css"\n`);
      r = await forge('config', 'validate');
      assert.equal(r.status, 1);
      assert.match(r.stdout, /verifyE2e\.paths must be a list of non-empty strings/);
    } finally {
      repo.cleanup();
    }
  });

  // The other `forge job paths` tests (review-files, scope, verdicts) each check their own entry;
  // screenshots is verify's UI proof, so its entry is checked here.
  test('job paths exposes screenshots', async () => {
    const s = await e2eScratch();
    try {
      const j = await s.f('job', 'new', '--title', 'paths');
      assert.equal((await s.f('job', 'paths', j.id)).screenshots, path.join(s.repo.dir, j.dir, 'screenshots'));
      assert.equal(fs.existsSync(path.join(s.repo.dir, j.dir, 'screenshots')), false, 'a path only; agents create it');
    } finally {
      s.cleanup();
    }
  });
});
