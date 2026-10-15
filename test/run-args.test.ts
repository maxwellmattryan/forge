// `forge run <job> <command> -- <args…>`: each argument reaches the command as one literal word,
// unsafe ones are refused before anything runs, and no other path ever takes arguments.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { loadConfig } from '../lib/config.ts';
import { createJob, jobDir, readEvents, updateJob } from '../lib/jobs.ts';
import { shellArgs } from '../lib/util.ts';
import { createWorktree } from '../lib/worktree.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const ARGS = ['a', 'b c', '$HOME', ';touch pwned', '*', '{job}', '`id`'];

/** One scratch repo for the file: Forge initialised with `answers`, and a job whose worktree exists. */
function scratch() {
  const repo = tempRepo();
  const root = repo.dir;
  const env = { ...process.env, FORGE_ROOT: root };
  const answers = path.join(root, '..', `answers-${path.basename(root)}.json`);
  fs.writeFileSync(
    answers,
    JSON.stringify({
      tracker: { kind: 'none' },
      worktrees: { root: `../${path.basename(root)}.wt`, setup: ['echo "setup[{args}]"'] },
      commands: { echo: "printf '%s\\n'", at: "printf '[%s]' {args} end", test: 'true', dev: 'sleep 30', check: 'test -z "{args}" && echo "check[{args}]"' },
      verify: ['check'],
    }),
  );
  const raw = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', env });
  const init = raw('init', 'write', '--answers', answers);
  assert.equal(init.status, 0, init.stderr);
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: root });
  const { config } = loadConfig(root);
  const id = createJob(root, config, { title: 'Args' }).id;
  const created = createWorktree(root, config, id);
  updateJob(root, id, (j) => (j.round = 1));
  const dir = jobDir(root, id);
  return {
    root,
    id,
    dir,
    created,
    wt: created.path,
    raw,
    /** What a refused call must leave alone: job.json, the logs dir and the command events. */
    trace: () => ({
      job: fs.readFileSync(path.join(dir, 'job.json'), 'utf8'),
      logs: fs.existsSync(path.join(dir, 'logs')) ? fs.readdirSync(path.join(dir, 'logs')).sort() : [],
      commands: readEvents(root, id).filter((e) => e.type === 'command').length,
    }),
    cleanup() {
      raw('stop', id);
      repo.cleanup();
      fs.rmSync(`${root}.wt`, { recursive: true, force: true });
      fs.rmSync(answers, { force: true });
    },
  };
}

let shared: ReturnType<typeof scratch> | null = null;
const s = () => (shared ??= scratch());
after(() => shared?.cleanup());

test('args reach the command literally, appended or at {args}', () => {
  const x = s();
  const run = (...args: string[]) => {
    const r = x.raw('run', x.id, ...args);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const appended = run('echo', '--', ...ARGS);
  assert.equal(appended.cmd, `printf '%s\\n' 'a' 'b c' '$HOME' ';touch pwned' '*' '{job}' '\`id\`'`);
  assert.equal(appended.tail, ARGS.join('\n'), 'one line per argument, nothing expanded');
  const placed = run('at', '--', ...ARGS);
  assert.equal(placed.cmd, `printf '[%s]' 'a' 'b c' '$HOME' ';touch pwned' '*' '{job}' '\`id\`' end`);
  assert.equal(placed.tail, `${ARGS.map((a) => `[${a}]`).join('')}[end]`);
  const none = run('at');
  assert.equal(none.cmd, "printf '[%s]'  end", '{args} becomes nothing');
  assert.equal(none.tail, '[end]');
  // Flags after -- belong to the command, not to forge run.
  assert.equal(run('echo', '--', '--tail', '1', '--background').tail, '--tail\n1\n--background');
  assert.equal(run('echo', '--tail', '1', '--', 'x', 'y').tail, 'y', '--tail before -- is forge run\'s own');
  for (const dir of [x.wt, x.root]) assert.equal(fs.existsSync(path.join(dir, 'pwned')), false, `no pwned file in ${dir}`);
});

test('unsafe args, args without -- and args with --background are refused before anything runs', () => {
  const x = s();
  const refused = (args: string[], message: string) => {
    const before = x.trace();
    const r = x.raw('run', x.id, ...args);
    assert.equal(r.status, 1, `${JSON.stringify(args)}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `forge: ${message}\n`);
    assert.deepEqual(x.trace(), before, `${JSON.stringify(args)}: no log, no command event, job.json untouched`);
  };
  for (const bad of ["it's", 'back\\slash', 'two\nlines', 'tab\there', 'esc\x1b[31m']) {
    refused(['echo', '--', 'ok', bad], `forge run: argument 2 contains a quote, backslash or control character (got ${JSON.stringify(bad)})`);
  }
  refused(['test', 'extra'], 'forge run takes extra arguments only after --: forge run <job> <command> -- <args…>');
  refused(['dev', '--background', 'x'], 'forge run takes extra arguments only after --: forge run <job> <command> -- <args…>');
  refused(['dev', '--background', '--', 'x'], 'forge run --background takes no extra arguments');
  assert.equal(fs.existsSync(path.join(x.dir, 'runtime.json')), false, 'no server was started');
  // NUL and DEL can't travel through argv, so the quoting itself is checked for them.
  for (const bad of ['nul\0', 'del\x7f', '\x01']) assert.throws(() => shellArgs(['ok', bad]), /argument 2 contains a quote, backslash or control character/);
  assert.equal(shellArgs(['a b', '', '$x']), "'a b' '' '$x'");
});

test('verify and worktree setup fill {args} with nothing', () => {
  const x = s();
  const created = x.created;
  assert.ok(created.created && created.ok, JSON.stringify(created));
  assert.deepEqual(created.setup.map((st) => [st.cmd, st.ok, st.tail]), [['echo "setup[{args}]"', true, 'setup[]']]);
  const r = x.raw('verify', x.id);
  assert.equal(r.status, 0, `${r.stderr}${r.stdout}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.steps[0].cmd, 'test -z "" && echo "check[]"');
  const md = fs.readFileSync(path.join(x.dir, 'verify', 'round-1.md'), 'utf8');
  assert.match(md, /^## check: ok$/m);
  assert.doesNotMatch(md, /\{args\}/);
});
