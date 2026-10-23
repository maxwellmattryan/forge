import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import zlib from 'node:zlib';
import { forgeAsync, repoTemplate } from './helpers.ts';
import { TRUST_ENV, loadConfig, trustDigest } from '#core/config/load.ts';
import { createJob, jobDir, logEvent, updateJob } from '#core/job/store.ts';
import { sessionFiles } from '#core/job/session-files.ts';
import { hasBinary } from '#core/os/process.ts';
import { setIn } from '#core/format/yaml.ts';
import { token } from './secret-fixtures.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const HAS_UNZIP = hasBinary('unzip');
const TOKEN = token.github('bundle');
const EMAIL = 'planted.person@corp.invalid';
const LOGIN = 'plantedlogin';
const SPEC_MARKER = 'SPEC-MARKER-7f3a';
const REQUEST_MARKER = 'REQUEST-MARKER-91c2';
const EVENT_MARKER = 'EVENT-PROSE-MARKER-55d1';
const DAEMON_MARKER = 'DAEMON-PROSE-MARKER-0b6e';
/** The machine's host name and its first label: claimJob writes it into job.json, and the test can't change it. */
const HOSTS = ((h) => (/^localhost(\.localdomain)?$/i.test(h) ? [] : [h, h.split('.')[0]].filter((x) => x.length >= 3)))(os.hostname());

/** Initialised once per file: a local tracker, PRs off, worktrees in `<repo>.wt`, and planted config. */
const initialised = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false }, worktrees: { root: '../{repo}.wt' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, stdio: 'pipe', env: { ...process.env, FORGE_ROOT: dir } });
  fs.rmSync(answers);
  // The git user name is an identity the bundle redacts; `Test` would hit every `test` step name.
  execFileSync('git', ['config', 'user.name', 'Planted Person'], { cwd: dir });
  const file = path.join(dir, '.forge', 'config.yml');
  let yml = fs.readFileSync(file, 'utf8');
  yml = setIn(yml, ['commands', 'test'], `npm test -- --auth ${TOKEN}`);
  yml = setIn(yml, ['git', 'remote'], 'upstream');
  yml = setIn(yml, ['tracker', 'github', 'repo'], `${LOGIN}/private-repo`);
  fs.writeFileSync(file, yml);
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'forge init'], { cwd: dir });
});

/** Reads a zip's entries through its central directory: the leak checks run even without unzip. */
function readZip(buf: Buffer): Map<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10);
    const csize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const body = buf.subarray(start, start + csize);
    out.set(name, (method === 8 ? zlib.inflateRawSync(body) : body).toString('utf8'));
    at += 46 + nameLen;
  }
  return out;
}

/** A scratch repo with one job holding every planted value, a fake HOME and an output dir. */
function scratch() {
  const repo = initialised();
  const root = repo.dir;
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bundle-')));
  const home = path.join(tmp, 'fakehome-q9');
  const out = path.join(tmp, 'out');
  fs.mkdirSync(home);
  fs.mkdirSync(out);
  const config = loadConfig(root).config;
  const job = createJob(root, config, { title: 'Bundle probe', body: `${REQUEST_MARKER} from ${EMAIL}` });
  const dir = jobDir(root, job.id);
  updateJob(root, job.id, (j) => {
    j.worktree = `${root}.wt/${job.id}`;
    j.lease = { driver: 's-1', epoch: 1, since: '2026-10-16T09:00:00.000Z', renewedAt: '2026-10-16T09:00:00.000Z', expiresAt: '2026-10-16T09:30:00.000Z' };
    // The lease records no host, but a hand-edited or foreign key in job.json still can; the bundle must redact it.
    (j as any).host = os.hostname();
  });
  logEvent(root, job.id, 'probe', { detail: `${home}/.config/x`, who: EMAIL, by: `@${LOGIN}`, summary: EVENT_MARKER });
  fs.writeFileSync(path.join(dir, 'spec.md'), `# Spec\n${SPEC_MARKER}\nkey ${TOKEN}\nmail ${EMAIL}\n`);
  fs.appendFileSync(path.join(dir, 'request.md'), `\n${REQUEST_MARKER}\n`);
  fs.mkdirSync(path.join(dir, 'verify'));
  fs.writeFileSync(path.join(dir, 'verify', 'round-1.md'), 'VERIFY: FAIL\n\nRound 1\n');
  fs.writeFileSync(path.join(dir, 'verify', 'round-1-attempt-1.md'), 'VERIFY: FAIL (older)\n');
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'logs', 'verify-test-2026-10-16T09-00-00-000Z.log'), 'old run\n');
  fs.writeFileSync(path.join(dir, 'logs', 'verify-test-2026-10-16T10-00-00-000Z.log'), `$ npm test\n(cwd ${root}.wt/${job.id})\nGH=${TOKEN}\nreading ${home}/.npmrc for ${LOGIN}\n[exit 1]\n`);
  const daemonLog = sessionFiles(root, job.id).log;
  fs.mkdirSync(path.dirname(daemonLog), { recursive: true });
  fs.writeFileSync(
    daemonLog,
    [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1', cwd: `${home}/x` }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: DAEMON_MARKER }] } }),
      JSON.stringify({ type: 'tool', name: `${home}/bin/tool` }),
      '',
    ].join('\n'),
  );
  return {
    root,
    job,
    dir,
    home,
    out,
    tmp,
    run: (args: string[], env: NodeJS.ProcessEnv = {}) => forgeAsync(root, args, { HOME: home, ...env }),
    zips: () => fs.readdirSync(out).filter((f) => f.endsWith('.zip')).sort(),
    cleanup: () => {
      repo.cleanup();
      fs.rmSync(`${root}.wt`, { recursive: true, force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

type Scratch = ReturnType<typeof scratch>;

/** The written zip's entries; checks the archive with unzip when it is installed. */
function entriesOf(file: string): Map<string, string> {
  const buf = fs.readFileSync(file);
  const m = readZip(buf);
  if (HAS_UNZIP) {
    assert.match(execFileSync('unzip', ['-t', file], { encoding: 'utf8' }), /No errors detected/);
    for (const [name, text] of m) assert.equal(execFileSync('unzip', ['-p', file, name], { encoding: 'utf8', maxBuffer: 1 << 26 }), text, `unzip -p ${name}`);
  }
  return m;
}

function assertNoLeak(s: Scratch, m: Map<string, string>, extra: string[] = []) {
  for (const [name, text] of m) {
    const hay = `${name}\n${text}`.toLowerCase();
    for (const needle of [TOKEN, s.home, s.root, EMAIL, LOGIN, ...extra]) assert.ok(!hay.includes(needle.toLowerCase()), `${name} leaks ${needle}`);
  }
}

async function bundle(s: Scratch, args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = await s.run(['doctor', '--bundle', ...args, '--out', s.out], env);
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  return { r, res, m: entriesOf(res.file) };
}

describe('forge doctor --bundle', { concurrency: 4 }, () => {
  test('a bundle from a planted repo leaks none of the planted values', async () => {
    const s = scratch();
    try {
      const { res, m } = await bundle(s, [s.job.id]);
      assert.equal(JSON.parse(m.get('doctor.json')!).ok, false, 'doctor fails on the missing upstream remote');
      assert.ok(res.redactions.secrets >= 1 && res.redactions.paths >= 1 && res.redactions.emails >= 1 && res.redactions.logins >= 1, JSON.stringify(res.redactions));
      assert.equal(fs.statSync(res.file).mode & 0o777, 0o600);
      assertNoLeak(s, m, HOSTS);
      const host = JSON.parse(m.get(`jobs/${s.job.id}/job.json`)!).host;
      if (HOSTS.length) assert.match(host, /^(<login>|<secret:[a-z-]+>)$/);
    } finally {
      s.cleanup();
    }
  });

  test('default bundle leaves agent text out and keeps structure', async () => {
    const s = scratch();
    try {
      const { m } = await bundle(s, [s.job.id]);
      const pre = `jobs/${s.job.id}`;
      assert.deepEqual(
        [...m.keys()].sort(),
        [
          'config.json',
          'doctor.json',
          `${pre}/daemon.log`,
          `${pre}/events.jsonl`,
          `${pre}/job.json`,
          `${pre}/logs/verify-test-2026-10-16T10-00-00-000Z.log`,
          `${pre}/step.json`,
          `${pre}/verify/round-1.md`,
          'manifest.json',
          'versions.json',
        ].sort(),
      );
      assertNoLeak(s, m, [SPEC_MARKER, REQUEST_MARKER, EVENT_MARKER, DAEMON_MARKER]);
      for (const [name, text] of m) {
        if (name.endsWith('.json')) assert.doesNotThrow(() => JSON.parse(text), name);
        if (name.endsWith('.jsonl')) for (const l of text.split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(l), `${name}: ${l}`);
      }
      const events = m.get(`${pre}/events.jsonl`)!.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const probe = events.find((e) => e.type === 'probe');
      assert.equal(probe.summary, `<omitted: ${EVENT_MARKER.length} chars>`);
      assert.equal(probe.who, '<email>');
      assert.equal(probe.by, '@<login>');
      // A random temp path can read as high-entropy to the scanner, which runs first: either is fine.
      assert.match(probe.detail, /^(~\/\.config\/x|<secret:high-entropy>)$/);
      const daemon = m.get(`${pre}/daemon.log`)!.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.deepEqual(daemon.map((d) => d.type), ['system', 'assistant', 'tool']);
      assert.equal(daemon[0].session_id, 's-1');
      assert.match(daemon[2].name, /^(~\/bin\/tool|<secret:high-entropy>)$/, 'a name key keeps its (redacted) string');
      const config = JSON.parse(m.get('config.json')!);
      assert.equal(config.commands, '<redacted>');
      assert.equal(config.git.remote, 'upstream');
      const versions = JSON.parse(m.get('versions.json')!);
      assert.deepEqual(Object.keys(versions), ['forge', 'node', 'git', 'gh', 'glab', 'os']);
      assert.equal(versions.node, process.versions.node);
      const manifest = JSON.parse(m.get('manifest.json')!);
      assert.equal(manifest.includeText, false);
      assert.deepEqual(manifest.jobs, [s.job.id]);
      assert.deepEqual(manifest.entries.map((e: any) => e.name), [...m.keys()].filter((n) => n !== 'manifest.json'));
      assert.ok(!m.has(`${pre}/diff.patch`) && ![...m.keys()].some((n) => n.includes('/text/')));
    } finally {
      s.cleanup();
    }
  });

  test('--include-text adds redacted markdown and the diff', async () => {
    const s = scratch();
    try {
      const wt = await s.run(['worktree', 'create', s.job.id]);
      assert.equal(wt.status, 0, wt.stderr);
      const cwd = `${s.root}.wt/${s.job.id}`;
      fs.writeFileSync(path.join(cwd, 'probe.txt'), 'a change\n');
      execFileSync('git', ['add', 'probe.txt'], { cwd });
      execFileSync('git', ['commit', '-qm', 'probe'], { cwd });
      const { res, m } = await bundle(s, [s.job.id, '--include-text']);
      const pre = `jobs/${s.job.id}`;
      assert.equal(res.includeText, true);
      const spec = m.get(`${pre}/text/spec.md`);
      assert.ok(spec?.includes(SPEC_MARKER), 'the spec text is in');
      assert.match(spec!, /<secret:github-token>/);
      assert.match(spec!, /<email>/);
      assert.ok(m.get(`${pre}/text/request.md`)?.includes(REQUEST_MARKER));
      assert.match(m.get(`${pre}/diff.patch`) ?? '', /probe\.txt/);
      assert.ok(![...m.keys()].some((n) => n.startsWith(`${pre}/text/verify/`)), 'verify/ is not text');
      assertNoLeak(s, m);
    } finally {
      s.cleanup();
    }
  });

  test('prints the manifest before writing', async () => {
    const s = scratch();
    try {
      const { r, res, m } = await bundle(s, [s.job.id]);
      const writing = r.stderr.indexOf('Writing ');
      assert.ok(writing > 0, r.stderr);
      assert.match(r.stderr, /^Support bundle: \d+ files, [\d.]+ (B|KiB|MiB) before compression/);
      for (const name of m.keys()) {
        const line = r.stderr.split('\n').find((l) => l.trim().startsWith(name + ' '));
        assert.ok(line && /\d (B|KiB|MiB)$/.test(line), `stderr lists ${name}`);
        assert.ok(r.stderr.indexOf(line) < writing);
      }
      assert.ok(r.stderr.indexOf('Redacted: ') < writing);
      assert.match(r.stderr, /Agent text and diffs left out; --include-text adds them\./);
      assert.ok(r.stderr.includes(`Writing ${res.file}`));
      assert.deepEqual(res.entries.map((e: any) => e.name), [...m.keys()].filter((n) => n !== 'manifest.json'));
      for (const e of res.entries) assert.equal(e.bytes, Buffer.byteLength(m.get(e.name)!), e.name);
    } finally {
      s.cleanup();
    }
  });

  test('symlinks, linked dirs and FIFOs in the job dir are skipped', { timeout: 60_000 }, async () => {
    const s = scratch();
    try {
      const outside = path.join(s.tmp, 'outside');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'target.log'), 'TRAP-LINK-MARKER\n');
      fs.writeFileSync(path.join(outside, 'verify-z-1.log'), 'TRAP-DIR-MARKER\n');
      fs.symlinkSync(path.join(outside, 'target.log'), path.join(s.dir, 'logs', 'verify-x-1.log'));
      execFileSync('mkfifo', [path.join(s.dir, 'logs', 'verify-y-1.log')]);
      // Names an agent can pick: an escape sequence for the user's terminal, and backslash `..`
      // segments that a Windows extractor would follow out of its folder.
      fs.writeFileSync(path.join(s.dir, 'logs', 'verify-a\x1b[31mRED\x1b[2K-1.log'), 'TRAP-ESC-MARKER\n');
      fs.writeFileSync(path.join(s.dir, 'logs', 'verify-..\\..\\..\\..\\evil-1.log'), 'TRAP-SLIP-MARKER\n');
      fs.writeFileSync(path.join(s.dir, 'b\x1b[1A.md'), 'TRAP-MD-MARKER\n');
      fs.mkdirSync(path.join(s.dir, '..\\up'));
      fs.writeFileSync(path.join(s.dir, '..\\up', 'c.md'), 'TRAP-MDDIR-MARKER\n');
      const config = loadConfig(s.root).config;
      const second = createJob(s.root, config, { title: 'Linked logs' });
      fs.symlinkSync(outside, path.join(jobDir(s.root, second.id), 'logs'));
      const { r, res, m } = await bundle(s, []);
      const skipped = Object.fromEntries(res.skipped.map((x: any) => [x.name, x.reason]));
      assert.equal(skipped[`jobs/${s.job.id}/logs/verify-x-1.log`], 'symlink');
      assert.equal(skipped[`jobs/${s.job.id}/logs/verify-y-1.log`], 'not a regular file');
      assert.equal(skipped[`jobs/${second.id}/logs`], 'symlink');
      assert.deepEqual(JSON.parse(m.get('manifest.json')!).skipped, res.skipped);
      assert.equal(skipped[`jobs/${s.job.id}/logs/<unsafe name>`], 'unsafe name');
      assert.equal(res.skipped.filter((x: any) => x.reason === 'unsafe name').length, 2, 'one skip per planted log, never its raw name');
      const traps = ['TRAP-LINK-MARKER', 'TRAP-DIR-MARKER', 'TRAP-ESC-MARKER', 'TRAP-SLIP-MARKER', 'TRAP-MD-MARKER', 'TRAP-MDDIR-MARKER'];
      for (const [name, text] of m) assert.ok(!traps.some((t) => text.includes(t)), name);
      const text = await bundle(s, [s.job.id, '--include-text']);
      const textSkips = text.res.skipped.filter((x: any) => x.reason === 'unsafe name').map((x: any) => x.name).sort();
      assert.deepEqual(textSkips, [`jobs/${s.job.id}/<unsafe name>`, `jobs/${s.job.id}/<unsafe name>`, `jobs/${s.job.id}/logs/<unsafe name>`, `jobs/${s.job.id}/logs/<unsafe name>`]);
      assert.ok(text.m.has(`jobs/${s.job.id}/text/spec.md`), 'safe markdown still comes in');
      for (const [name, body] of text.m) assert.ok(!traps.some((t) => body.includes(t)), name);
      for (const run of [{ r, m }, text]) {
        assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(run.r.stderr), `stderr carries a control character: ${JSON.stringify(run.r.stderr)}`);
        for (const name of run.m.keys()) assert.ok(/^[A-Za-z0-9._\/<>~-]+$/.test(name) && !name.split('/').includes('..'), `entry name ${JSON.stringify(name)}`);
      }
    } finally {
      s.cleanup();
    }
  });

  test('refusals, no overwrite, active jobs only', async () => {
    const s = scratch();
    try {
      const file = path.join(s.tmp, 'a-file');
      fs.writeFileSync(file, '');
      const refusals: [string[], NodeJS.ProcessEnv, RegExp][] = [
        [['--bundle', '../x', '--out', s.out], {}, /invalid job id/],
        [['--bundle', 'no-such-job', '--out', s.out], {}, /no job "no-such-job"/],
        [['--bundle', '--out', path.join(s.tmp, 'missing')], {}, /not an existing directory/],
        [['--bundle', '--out', file], {}, /not an existing directory/],
        [['--bundle', '--out', s.out], { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(s.root) }, /forge doctor --bundle is for a human; run it in your own terminal/],
      ];
      for (const [args, env, msg] of refusals) {
        const r = await s.run(['doctor', ...args], env);
        assert.equal(r.status, 1, `${args.join(' ')}: ${r.stderr}`);
        assert.match(r.stderr, msg);
      }
      assert.deepEqual(s.zips(), []);

      const done = createJob(s.root, loadConfig(s.root).config, { title: 'Finished work' });
      updateJob(s.root, done.id, (j) => {
        j.state = 'done';
      });
      const first = await bundle(s, []);
      assert.deepEqual(first.res.jobs, [s.job.id]);
      assert.ok(![...first.m.keys()].some((n) => n.includes(done.id)));
      const before = fs.readFileSync(first.res.file);
      const second = await bundle(s, []);
      assert.equal(path.basename(second.res.file), path.basename(first.res.file).replace(/\.zip$/, '-2.zip'));
      assert.ok(fs.readFileSync(first.res.file).equals(before), 'the first bundle is untouched');
      assert.equal(s.zips().length, 2);
    } finally {
      s.cleanup();
    }
  });
});
