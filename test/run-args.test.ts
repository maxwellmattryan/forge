// `forge run <job> <command> -- <args…>`: each argument reaches the command as one literal word,
// unsafe ones are refused before anything runs, and no other path ever takes arguments.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempRepo, waitFor } from './helpers.ts';
import { loadConfig } from '../lib/core/config/load.ts';
import { createJob, jobDir, readEvents, updateJob } from '../lib/core/job/store.ts';
import { shellArgs } from '../lib/core/text.ts';
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
      commands: {
        echo: "printf '%s\\n'",
        lines: "printf '%s\\n' {args}",
        at: "printf '[%s]' {args} end",
        test: 'true',
        dev: 'echo dev {args} end; sleep 30',
        check: 'test -z "{args}" && echo "check[{args}]"',
        block: 'echo one\necho two\n',
        words: "true\n(printf '<%s>' {args}) | cat; printf '%s.' {args};printf '\\t%s' x\t{args}\t&& echo",
        dquoted: 'echo "x{args}"',
        squoted: "echo '{args}'",
        spacedq: 'echo " {args} "',
        escaped: 'echo \\{args}',
        dqescaped: 'echo "\\{args}"',
        heredoc: 'cat <<EOF\n{args}\nEOF\n',
        ansic: "echo $'a\\' {args} '",
        fishq: "echo 'a\\' {args} '",
      },
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

test('args reach the command literally at {args}, and a template without {args} refuses them', () => {
  const x = s();
  const run = (...args: string[]) => {
    const r = x.raw('run', x.id, ...args);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const lines = run('lines', '--', ...ARGS);
  assert.equal(lines.cmd, `printf '%s\\n' 'a' 'b c' '$HOME' ';touch pwned' '*' '{job}' '\`id\`'`);
  assert.equal(lines.tail, ARGS.join('\n'), 'one line per argument, nothing expanded');
  const placed = run('at', '--', ...ARGS);
  assert.equal(placed.cmd, `printf '[%s]' 'a' 'b c' '$HOME' ';touch pwned' '*' '{job}' '\`id\`' end`);
  assert.equal(placed.tail, `${ARGS.map((a) => `[${a}]`).join('')}[end]`);
  const none = run('at');
  assert.equal(none.cmd, "printf '[%s]'  end", '{args} becomes nothing');
  assert.equal(none.tail, '[end]');
  // Arguments are opt-in: a template without {args} refuses them, before anything runs.
  const before = x.trace();
  const refused = x.raw('run', x.id, 'echo', '--', ...ARGS);
  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(refused.stdout, '');
  assert.equal(refused.stderr, 'forge: forge run: commands.echo takes no arguments; put {args} in the template where they go\n');
  assert.deepEqual(x.trace(), before, 'no log, no command event, job.json untouched');
  // Without arguments it runs exactly as before.
  const plain = run('echo');
  assert.equal(plain.cmd, "printf '%s\\n'");
  // Flags after -- belong to the command, not to forge run.
  assert.equal(run('lines', '--', '--tail', '1', '--background').tail, '--tail\n1\n--background');
  assert.equal(run('lines', '--tail', '1', '--', 'x', 'y').tail, 'y', '--tail before -- is forge run\'s own');
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
    refused(['lines', '--', 'ok', bad], `forge run: argument 2 contains a quote, backslash or control character (got ${JSON.stringify(bad)})`);
  }
  refused(['test', 'extra'], 'forge run takes extra arguments only after --: forge run <job> <command> -- <args…>');
  refused(['dev', '--background', 'x'], 'forge run takes extra arguments only after --: forge run <job> <command> -- <args…>');
  refused(['dev', '--background', '--', 'x'], 'forge run --background takes no extra arguments');
  refused(['dev', '--background=1'], 'forge run: --background takes no value');
  assert.equal(fs.existsSync(path.join(x.dir, 'runtime.json')), false, 'no server was started');
  // NUL and DEL can't travel through argv, so the quoting itself is checked for them.
  for (const bad of ['nul\0', 'del\x7f', '\x01']) assert.throws(() => shellArgs(['ok', bad]), /argument 2 contains a quote, backslash or control character/);
  assert.equal(shellArgs(['a b', '', '$x']), "'a b' '' '$x'");
});

test('{args} that is not a plain unquoted word, a heredoc and $\'…\' or \\\' quoting are refused before anything runs', () => {
  const x = s();
  const marker = path.join(x.root, 'pwned-word');
  const refused = (name: string, message: string) => {
    for (const arg of [`$(touch ${marker})`, `;touch ${marker} #`]) {
      const before = x.trace();
      const r = x.raw('run', x.id, name, '--', arg);
      assert.equal(r.status, 1, `${name} ${arg}: ${r.stdout}${r.stderr}`);
      assert.equal(r.stderr, `forge: forge run: commands.${name} ${message}\n`);
      assert.deepEqual(x.trace(), before, `${name} ${arg}: no log, no command event, job.json untouched`);
      assert.equal(fs.existsSync(marker), false, `${name} ${arg}: nothing ran`);
    }
  };
  const notAWord = 'puts {args} inside quotes or another word, where the arguments would not stay literal; write {args} unquoted, as its own word';
  // Not a word of its own (a backslash before it included, in and out of "…"), or a word inside quotes.
  for (const name of ['dquoted', 'squoted', 'escaped', 'dqescaped', 'spacedq']) refused(name, notAWord);
  assert.equal(loadConfig(x.root).config.commands.escaped, 'echo \\{args}');
  // An unquoted heredoc body expands $(…); in $'…' (bash, zsh) and fish's '…', \' does not close the quote.
  for (const name of ['heredoc', 'ansic', 'fishq'])
    refused(name, "has a heredoc (<<) or a $'…' or \\' quote, where the arguments would not stay literal; take it out of the template to pass arguments");
  // Whole words: after the start, a blank, a newline or (, before a blank, ; & | ) or the end.
  const r = x.raw('run', x.id, 'words', '--', 'a', 'b c');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).tail, '<a><b c>a.b c.\tx\ta\tb c');
  // Without arguments every template runs as written.
  for (const [name, out] of [['block', 'one\ntwo'], ['heredoc', ''], ['spacedq', '']]) {
    const plain = x.raw('run', x.id, name);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(JSON.parse(plain.stdout).tail.trim(), out, name);
  }
});

test('verify and worktree setup fill {args} with nothing', async () => {
  const x = s();
  const created = x.created;
  assert.ok(created.created && created.ok, JSON.stringify(created));
  assert.deepEqual(created.setup.map((st) => [st.cmd, st.ok, st.tail]), [['echo "setup[{args}]"', true, 'setup[]']]);
  const r = x.raw('verify', x.id);
  assert.equal(r.status, 0, `${r.stderr}${r.stdout}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.steps.find((st) => st.name === 'check').cmd, 'test -z "" && echo "check[]"');
  const md = fs.readFileSync(path.join(x.dir, 'verify', 'round-1.md'), 'utf8');
  assert.match(md, /^## check: ok$/m);
  assert.doesNotMatch(md, /\{args\}/);
  // A background server's template gets nothing too.
  const bg = x.raw('run', x.id, 'dev', '--background');
  assert.equal(bg.status, 0, bg.stderr);
  const log = path.join(x.dir, 'logs', 'dev.log');
  await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('dev end'), { what: 'the dev server to log its line' });
  assert.equal(fs.readFileSync(log, 'utf8').trim(), 'dev end');
  assert.equal(x.raw('stop', x.id).status, 0);
});
