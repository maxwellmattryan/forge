// A job's issues: repo-qualified, tracker-neutral refs (lib/issue-ref.ts), the offline repo slug
// (lib/repo-slug.ts), the v10 → v11 migration of `source` into `issues`, and the CLI that records,
// links and removes them (forge job new, link, from-ref).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, tempRepo } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { createJob, jobDir, loadJob, readEvents } from '../lib/jobs.ts';
import { JOB_SCHEMA_VERSION, normalizeJob, serializeJob } from '../lib/schema.ts';
import { checkIssueRef, nativeRef, parseIssueRef } from '../lib/issue-ref.ts';
import { localRepoSlug } from '../lib/repo-slug.ts';
import { issueLinkStatus } from '../lib/issue-link.ts';
import { startFromRef } from '../lib/commands/tracker.ts';
import type { Tracker } from '../lib/types.ts';

/** A scratch repo initialised with `tracker`, and a CLI runner that never throws. */
async function setup(tracker: Record<string, unknown>, opts: { backlog?: string; adapter?: string; env?: NodeJS.ProcessEnv } = {}) {
  const repo = tempRepo();
  const root = repo.dir;
  if (opts.adapter) {
    fs.mkdirSync(path.join(root, '.forge', 'trackers'), { recursive: true });
    fs.writeFileSync(path.join(root, '.forge', 'trackers', `${tracker.kind}.mjs`), opts.adapter);
  }
  const cli = async (...args: string[]) => {
    const r = await forgeAsync(root, args, opts.env ?? {});
    let json: any = null;
    try {
      json = JSON.parse(r.stdout);
    } catch {}
    return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
  const answers = path.join(root, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker, pr: { enabled: false } }));
  const init = await cli('init', 'write', '--answers', answers);
  assert.equal(init.status, 0, init.stderr);
  const backlogFile = path.join(root, '.forge', 'backlog.md');
  if (opts.backlog !== undefined) fs.writeFileSync(backlogFile, opts.backlog);
  const raw = (id: string) => fs.readFileSync(path.join(jobDir(root, id), 'job.json'), 'utf8');
  const newJob = async (title: string, ...extra: string[]) => {
    const r = await cli('job', 'new', '--title', title, ...extra);
    assert.equal(r.status, 0, r.stderr);
    return r.json.id as string;
  };
  const jobDirs = () => (fs.existsSync(path.join(root, '.forge', 'jobs')) ? fs.readdirSync(path.join(root, '.forge', 'jobs')).filter((d) => fs.statSync(path.join(root, '.forge', 'jobs', d)).isDirectory()) : []);
  return { repo, root, cli, raw, newJob, jobDirs, backlog: () => fs.readFileSync(backlogFile, 'utf8') };
}

test('parseIssueRef accepts the documented forms and refuses the rest', () => {
  const gh = { tracker: 'github', slug: 'o/r' };
  assert.equal(parseIssueRef('#12', gh), 'o/r#12');
  assert.equal(parseIssueRef('12', gh), 'o/r#12');
  assert.equal(parseIssueRef('  #12 ', gh), 'o/r#12', 'trimmed');
  assert.equal(parseIssueRef('12', { tracker: 'github', slug: null }), '12', 'no slug: the legacy bare form');
  assert.equal(parseIssueRef('O/R#12', gh), 'O/R#12', 'a qualified ref is kept as typed');
  assert.equal(parseIssueRef('other/repo#9', gh), 'other/repo#9');
  assert.equal(parseIssueRef('KEY-123', { tracker: 'jira', slug: null }), 'KEY-123');
  assert.equal(parseIssueRef('reading-time-badge', { tracker: 'local', slug: null }), 'reading-time-badge');
  assert.equal(parseIssueRef('#reading-time-badge', { tracker: 'local', slug: null }), 'reading-time-badge');
  assert.equal(parseIssueRef('group/sub/project#7', { tracker: 'gitlab', slug: null }), 'group/sub/project#7');
  const refused: [string, { tracker: string; slug: string | null }][] = [
    ['-R x#1', gh],
    ['o/r#0', gh],
    ['o/r#12x', gh],
    ['a/../b#1', gh],
    ['o/r #1', gh],
    ['o'.repeat(201), { tracker: 'jira', slug: null }],
    ['o/r#1\n', gh],
    ['o/\nr#1', gh],
    ['o/r#1', { tracker: 'local', slug: null }],
    ['#0', gh],
    ['-x', { tracker: 'jira', slug: null }],
    ['a#b', { tracker: 'jira', slug: null }],
    ['a..b', { tracker: 'jira', slug: null }],
    ['', gh],
  ];
  for (const [raw, opts] of refused) assert.equal(parseIssueRef(raw, opts), null, JSON.stringify(raw));
  assert.deepEqual(checkIssueRef('o/r#1', { tracker: 'local', slug: null }), { error: 'local tracker refs are backlog slugs' });
  assert.deepEqual(checkIssueRef('o/r #1', gh), { error: 'invalid ref "o/r #1"' });
  assert.equal((checkIssueRef('x'.repeat(300), gh) as { error: string }).error, `invalid ref "${'x'.repeat(100)}"`, 'the error quotes at most 100 characters');
  // Linear time on a hostile 10k-character line.
  const t0 = Date.now();
  assert.equal(parseIssueRef(`${'a/'.repeat(5000)}#1`, gh), null);
  assert.equal(parseIssueRef(`${'a'.repeat(10_000)}!`, gh), null);
  assert.ok(Date.now() - t0 < 200);
});

test('nativeRef separates this repo\'s issues from foreign ones', () => {
  const issue = (ref: string | null, tracker = 'github') => ({ tracker, ref });
  assert.equal(nativeRef(issue('o/r#12'), 'github', 'o/r'), '12');
  assert.equal(nativeRef(issue('O/R#12'), 'github', 'o/r'), '12', 'case-insensitive');
  assert.equal(nativeRef(issue('12'), 'github', 'o/r'), '12', 'the legacy bare form is this repo');
  assert.equal(nativeRef(issue('x/y#12'), 'github', 'o/r'), null);
  assert.equal(nativeRef(issue('o/r#12'), 'github', null), null, 'no slug: a qualified ref cannot be proven native');
  assert.equal(nativeRef(issue('o/r#12'), 'local', 'o/r'), null, "the issue's tracker is not this repo's");
  assert.equal(nativeRef(issue('x', 'local'), 'github', 'o/r'), null);
  assert.equal(nativeRef(issue('KEY-1', 'jira'), 'jira', 'o/r'), 'KEY-1', 'a custom kind gets the ref itself');
  assert.equal(nativeRef(issue('group/p#3', 'gitlab'), 'gitlab', null), 'group/p#3');
  assert.equal(nativeRef(issue(null), 'github', 'o/r'), null);
});

test('localRepoSlug is offline', () => {
  const repos = [tempRepo(), tempRepo(), tempRepo(), tempRepo()];
  const bin = fs.mkdtempSync(path.join(repos[0].dir, '.bin-'));
  const log = path.join(bin, 'gh.log');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho called >> "${log}"\necho stub/repo\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  try {
    const config = defaults();
    const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    const [configured, https, ssh, bare] = repos;
    git(https.dir, 'remote', 'add', 'origin', 'https://github.com/acme/web.git');
    git(ssh.dir, 'remote', 'add', 'origin', 'git@github.com:acme/api.git');
    assert.equal(localRepoSlug(configured.dir, { tracker: { ...config.tracker, github: { ...config.tracker.github, repo: 'own/repo' } } }), 'own/repo');
    assert.equal(localRepoSlug(https.dir, config), 'acme/web');
    assert.equal(localRepoSlug(ssh.dir, config), 'acme/api');
    assert.equal(localRepoSlug(bare.dir, config), null, 'no origin');
    assert.ok(!fs.existsSync(log), 'gh was never run');
  } finally {
    process.env.PATH = saved;
    for (const r of repos) r.cleanup();
  }
});

test('v10 jobs migrate source to issues unchanged otherwise', () => {
  const repo = tempRepo();
  try {
    const base = serializeJob(createJob(repo.dir, defaults(), { title: 'Old v10' })) as any;
    delete base.issues;
    const v10 = (source: unknown, extra: Record<string, unknown> = {}) => ({ ...base, ...extra, schemaVersion: 10, source });
    const cases: [unknown, Record<string, unknown>, unknown[]][] = [
      [{ tracker: 'github', ref: '12', url: 'https://github.com/acme/web/issues/12' }, {}, [{ tracker: 'github', ref: 'acme/web#12', url: 'https://github.com/acme/web/issues/12' }]],
      [{ tracker: 'local', ref: 'reading-time', url: null }, {}, [{ tracker: 'local', ref: 'reading-time', url: null }]],
      [{ tracker: 'local', ref: null, url: 'https://example.test/x' }, {}, [{ tracker: 'local', ref: null, url: 'https://example.test/x' }]],
      [null, { noIssue: { reason: 'tiny', at: '2026-10-01T00:00:00Z' } }, []],
      [{ tracker: 'github', ref: '7', url: null }, {}, [{ tracker: 'github', ref: '7', url: null }]],
      [{ tracker: 'github', ref: '7', url: 'https://github.com/acme/web/issues/8' }, {}, [{ tracker: 'github', ref: '7', url: 'https://github.com/acme/web/issues/8' }]],
      // `forge job new --ref` stored these unchecked before v11; they stay linked in the nearest valid form.
      [{ tracker: 'local', ref: 'ends done', url: null }, {}, [{ tracker: 'local', ref: 'ends-done', url: null }]],
      [{ tracker: 'acme', ref: 'a:b', url: 'https://example.test/a' }, {}, [{ tracker: 'acme', ref: 'a-b', url: 'https://example.test/a' }]],
      [{ tracker: 'local', ref: '  ', url: 'https://example.test/u' }, {}, [{ tracker: 'local', ref: null, url: 'https://example.test/u' }]],
    ];
    for (const [source, extra, issues] of cases) {
      const raw = v10(source, extra);
      const job = normalizeJob(raw);
      assert.equal(job.schemaVersion, JOB_SCHEMA_VERSION);
      assert.equal(JOB_SCHEMA_VERSION, 14);
      assert.deepEqual(job.issues, issues, JSON.stringify(source));
      assert.ok(!('source' in job), 'no source key');
      assert.deepEqual(job.noIssue, raw.noIssue, 'noIssue unchanged');
      const { issues: _i, schemaVersion: _v, ...rest } = job as any;
      const { source: _s, schemaVersion: _w, ...before } = raw;
      assert.deepEqual(rest, before, 'every other field is the v10 read');
      assert.ok(!('source' in serializeJob(job)));
      if (source && (source as any).ref?.trim?.()) assert.equal(issueLinkStatus(job, { tracker: { kind: (source as any).tracker } } as any), 'linked', 'a linked v10 job stays linked');
    }
    // On disk, through loadJob.
    const file = path.join(jobDir(repo.dir, base.id), 'job.json');
    fs.writeFileSync(file, JSON.stringify(v10({ tracker: 'github', ref: '3', url: 'https://ghe.example/a/b/issues/3' })));
    assert.deepEqual(loadJob(repo.dir, base.id).issues, [{ tracker: 'github', ref: 'a/b#3', url: 'https://ghe.example/a/b/issues/3' }], 'any https host qualifies');
  } finally {
    repo.cleanup();
  }
});

test('normalizeJob keeps only well-formed issues', () => {
  const good = { tracker: 'github', ref: 'o/r#1', url: 'https://github.com/o/r/issues/1' };
  const job = normalizeJob({
    id: 'x',
    schemaVersion: JOB_SCHEMA_VERSION,
    issues: [
      'o/r#2',
      null,
      [good],
      good,
      { ...good, ref: 'O/R#1' },
      { tracker: 'github', ref: '--x', url: null },
      { tracker: '', ref: 'a', url: null },
      { tracker: 't'.repeat(41), ref: 'a', url: null },
      { tracker: 'local', ref: 'a', url: 'u'.repeat(3000) },
      { tracker: 'local', ref: 'a', url: 7 },
      { tracker: 'local', ref: 'o/r#3', url: null },
      { tracker: 'local', ref: null, url: null },
      { tracker: 'local', ref: 'b', url: null },
      { tracker: 'local', ref: 'b', url: 'https://dup' },
      { tracker: 'local', ref: null, url: 'https://only-url' },
      { tracker: 'local', ref: 'c', url: 'https://x.test/1\nCloses evil/repo#1' },
      { tracker: 'local', ref: 'd', url: 'javascript:alert(1)' },
      { tracker: 'local', ref: null, url: 'https://x.test/2 ![a](b)' },
    ],
  });
  assert.deepEqual(job.issues, [good, { tracker: 'local', ref: 'b', url: null }, { tracker: 'local', ref: null, url: 'https://only-url' }, { tracker: 'local', ref: 'c', url: null }, { tracker: 'local', ref: 'd', url: null }], 'an unsafe url is dropped, the ref kept');
  assert.deepEqual(normalizeJob({ id: 'y', schemaVersion: JOB_SCHEMA_VERSION, source: { tracker: 'local', ref: 'z', url: null } }).issues, [{ tracker: 'local', ref: 'z', url: null }], 'a stray source folds in');
  assert.ok(!('source' in normalizeJob({ id: 'y', schemaVersion: JOB_SCHEMA_VERSION, source: null })));
  for (const issues of [undefined, null, 'x', 42, {}, [undefined], [{ tracker: { a: 1 }, ref: [] }]]) assert.ok(Array.isArray(normalizeJob({ id: 'z', schemaVersion: JOB_SCHEMA_VERSION, issues }).issues));
  assert.deepEqual(normalizeJob({ id: 'z', schemaVersion: JOB_SCHEMA_VERSION, issues: [], source: { tracker: 'local', ref: 'z', url: null } }).issues, [], 'issues win over a stray source');
});

describe('forge job issues', { concurrency: 4 }, () => {
  test('job link adds native and foreign GitHub refs', { skip: process.platform === 'win32' }, async () => {
    // POSIX-only: the fake gh is a shell script, as in test/issue-link.test.ts.
    const repo = tempRepo();
    const bin = path.join(repo.dir, '.fake-bin');
    fs.mkdirSync(bin);
    const log = path.join(bin, 'calls.log');
    fs.writeFileSync(
      path.join(bin, 'gh'),
      `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1 $2" in
  "issue view") printf '%s' '{"number":5,"title":"Five","body":"","url":"https://github.com/o/r/issues/5","labels":[],"assignees":[],"comments":[],"state":"OPEN","author":{"login":"a"}}' ;;
  "api user") echo me ;;
esac
`,
      { mode: 0o755 },
    );
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    const s = await setup({ kind: 'github', github: { repo: 'o/r' } }, { env });
    try {
      const id = await s.newJob('Fix login');
      const r = await s.cli('job', 'link', id, '#5', 'other/repo#9');
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(loadJob(s.root, id).issues, [
        { tracker: 'github', ref: 'o/r#5', url: 'https://github.com/o/r/issues/5' },
        { tracker: 'github', ref: 'other/repo#9', url: 'https://github.com/other/repo/issues/9' },
      ]);
      assert.deepEqual(r.json.added, ['o/r#5', 'other/repo#9']);
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
      const issueCalls = calls.filter((c) => /^issue (view|edit)/.test(c));
      assert.ok(issueCalls.length > 0);
      for (const c of issueCalls) assert.match(c, /^issue (view|edit) 5 -R o\/r /, c);
      assert.ok(!calls.some((c) => c.includes('other/repo') || / 9 /.test(c)), 'the foreign issue never reaches gh');
      const before = s.raw(id);
      const events = readEvents(s.root, id).length;
      const again = await s.cli('job', 'link', id, 'o/r#5', 'other/repo#9');
      assert.equal(again.status, 0, again.stderr);
      assert.deepEqual(again.json.added, []);
      assert.equal(s.raw(id), before, 'a second identical call writes nothing');
      assert.equal(readEvents(s.root, id).length, events, 'and logs no event');
      assert.deepEqual(readEvents(s.root, id).filter((e) => e.type === 'linked').map((e: any) => e.ref), ['o/r#5', 'other/repo#9']);
    } finally {
      s.repo.cleanup();
      repo.cleanup();
    }
  });

  test('one issue on two jobs', async () => {
    const s = await setup({ kind: 'local' }, { backlog: '# Backlog\n\n- [ ] Reading time badge\n' });
    try {
      const first = await s.newJob('First');
      const second = await s.newJob('Second');
      assert.equal((await s.cli('job', 'link', first, 'reading-time-badge')).status, 0);
      const backlog = s.backlog();
      assert.match(backlog, new RegExp(`- \\[~\\] Reading time badge → ${first}`));
      const r = await s.cli('job', 'link', second, 'reading-time-badge');
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.json.sharedWith, [first]);
      assert.deepEqual(r.json.added, ['reading-time-badge']);
      assert.equal(s.backlog(), backlog, 'no second claim: the backlog still points at the first job');
      assert.equal(loadJob(s.root, second).issues[0].ref, 'reading-time-badge');
    } finally {
      s.repo.cleanup();
    }
  });

  test('job link --remove and mode exclusivity', async () => {
    const s = await setup({ kind: 'local' }, { backlog: '# Backlog\n\n- [ ] Alpha\n- [ ] Beta\n' });
    try {
      const id = await s.newJob('Two issues');
      assert.equal((await s.cli('job', 'link', id, 'alpha', 'beta')).status, 0);
      const r = await s.cli('job', 'link', id, '--remove', 'alpha');
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.json, { id, issues: [{ tracker: 'local', ref: 'beta', url: null }], added: [], removed: ['alpha'] });
      assert.deepEqual(readEvents(s.root, id).filter((e) => e.type === 'unlinked').map((e: any) => e.ref), ['alpha']);
      const before = s.raw(id);
      const missing = await s.cli('job', 'link', id, '--remove', 'beta,alpha');
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, new RegExp(`alpha is not linked to job ${id}`));
      assert.equal(s.raw(id), before, 'byte-identical');
      for (const args of [['beta', '--remove', 'beta'], ['--remove', 'beta', '--create'], ['--none', '--suggest'], ['beta', '--create'], []]) {
        const u = await s.cli('job', 'link', id, ...args);
        assert.equal(u.status, 2, args.join(' '));
        assert.match(u.stderr, /usage: forge job link/);
      }
      assert.equal(s.raw(id), before);
      // The last issue removed: the job is unlinked again.
      assert.equal((await s.cli('job', 'link', id, '--remove', 'beta')).status, 0);
      assert.deepEqual(loadJob(s.root, id).issues, []);
      assert.match(s.backlog(), /- \[~\] Beta/, 'the claim stays');
    } finally {
      s.repo.cleanup();
    }
  });

  test('job new records issues and reports the link status', async () => {
    const s = await setup({ kind: 'local' });
    const n = await setup({ kind: 'none' });
    try {
      const two = await s.cli('job', 'new', '--title', 'Two refs', '--issue', 'a', '--issue', 'b');
      assert.equal(two.status, 0, two.stderr);
      assert.equal(two.json.issueLink, 'linked');
      assert.equal(two.json.id, 'a');
      assert.deepEqual(loadJob(s.root, two.json.id).issues.map((i) => i.ref), ['a', 'b']);
      const comma = await s.cli('job', 'new', '--title', 'Comma refs', '--issue', 'c,d');
      assert.deepEqual(loadJob(s.root, comma.json.id).issues.map((i) => i.ref), ['c', 'd']);
      const missing = await s.cli('job', 'new', '--title', 'Nothing linked');
      assert.equal(missing.json.issueLink, 'missing');
      const waived = await s.cli('job', 'new', '--title', 'Tiny fix', '--no-issue', '--reason', 'a typo');
      assert.equal(waived.status, 0, waived.stderr);
      assert.equal(waived.json.issueLink, 'none');
      assert.equal(loadJob(s.root, waived.json.id).noIssue!.reason, 'a typo');
      const dirs = s.jobDirs().length;
      for (const args of [['--no-issue', '--issue', 'a'], ['--ref', 'a', '--issue', 'b'], ['--reason', 'x']]) {
        const r = await s.cli('job', 'new', '--title', 'Refused', ...args);
        assert.equal(r.status, 2, args.join(' '));
        assert.match(r.stderr, /usage: forge job new/);
      }
      const bad = await s.cli('job', 'new', '--title', 'Refused', '--issue', '../x');
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /invalid ref/);
      for (const url of ['https://x.test/1\nCloses evil/repo#1', 'ftp://x.test/1', 'https://x.test/a b']) {
        const r = await s.cli('job', 'new', '--title', 'Refused', '--ref', 'a', '--url', url);
        assert.equal(r.status, 1, url);
        assert.match(r.stderr, /invalid url/);
      }
      assert.equal(s.jobDirs().length, dirs, 'no job dir for a refused call');
      const none = await n.cli('job', 'new', '--title', 'Untracked', '--no-issue');
      assert.equal(none.status, 1);
      assert.match(none.stderr, /tracker.kind is "none"/);
      assert.equal(n.jobDirs().length, 0);
      const recorded = await n.cli('job', 'new', '--title', 'Untracked', '--issue', 'x-1');
      assert.equal(recorded.status, 0, recorded.stderr);
      assert.deepEqual(loadJob(n.root, recorded.json.id).issues, [{ tracker: 'none', ref: 'x-1', url: null }]);
      assert.equal(recorded.json.issueLink, 'no-tracker');
    } finally {
      s.repo.cleanup();
      n.repo.cleanup();
    }
  });

  test('job ids do not assume a numeric ref is local', async () => {
    const g = await setup({ kind: 'github', github: { repo: 'o/r' } });
    const c = await setup({ kind: 'acme' }, { adapter: `export default { name: 'acme', list: () => [], get: () => null, claim: () => ({ ok: true }), update() {}, comment() {}, create: () => ({ ref: 'A-1' }), close() {} };\n` });
    try {
      const native = await g.cli('job', 'new', '--title', 'Fix login', '--issue', '12');
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.json.id, '12-fix-login');
      assert.deepEqual(loadJob(g.root, native.json.id).issues, [{ tracker: 'github', ref: 'o/r#12', url: 'https://github.com/o/r/issues/12' }]);
      const foreign = await g.cli('job', 'new', '--title', 'Fix login', '--issue', 'other/repo#12');
      assert.equal(foreign.json.id, 'repo-12-fix-login');
      const key = await c.cli('job', 'new', '--title', 'Fix login', '--issue', 'KEY-123');
      assert.equal(key.json.id, 'key-123');
      const plain = await g.cli('job', 'new', '--title', 'Fix login');
      assert.match(plain.json.id, /^fix-login-[a-z0-9]+$/);
      const deep = await c.cli('job', 'new', '--title', 'Fix login', '--issue', 'group/sub/project#7');
      assert.equal(deep.json.id, 'project-7-fix-login');
    } finally {
      g.repo.cleanup();
      c.repo.cleanup();
    }
  });

  test('issues, source and noIssue are locked fields', async () => {
    const s = await setup({ kind: 'local' });
    try {
      const id = await s.newJob('Locked');
      const before = s.raw(id);
      for (const [kv, hint] of [
        ['issues=[{"tracker":"local","ref":"x","url":null}]', 'forge job link'],
        ['source={"tracker":"local","ref":"x","url":null}', 'forge job link'],
        ['noIssue={"reason":null,"at":"x"}', 'forge job link --none'],
      ]) {
        const r = await s.cli('job', 'set', id, '--field', kv);
        assert.equal(r.status, 1, kv);
        assert.ok(r.stderr.includes(`is not settable; use ${hint}\n`), r.stderr);
      }
      assert.equal(s.raw(id), before);
    } finally {
      s.repo.cleanup();
    }
  });
});

test("from-ref takes this repo's issues only", async () => {
  const repo = tempRepo();
  try {
    const config = defaults();
    config.tracker.kind = 'github';
    config.tracker.github.repo = 'o/r';
    const gets: string[] = [];
    const claims: string[] = [];
    const tracker = {
      name: 'github',
      list: () => [],
      get: (_ctx: unknown, ref: string) => (gets.push(ref), ref === '3' ? { ref: '3', title: 'Three', url: 'https://github.com/o/r/issues/3' } : null),
      claim: (_ctx: unknown, ref: string) => (claims.push(ref), { ok: true }),
      update() {},
      comment() {},
      create: () => ({ ref: '4' }),
      close() {},
    } as unknown as Tracker;
    const r = await startFromRef(repo.dir, config, tracker, 'o/r#3', {});
    assert.ok(!('existing' in r));
    assert.deepEqual([gets, claims], [['3'], ['3']], 'the item is resolved and claimed by its number');
    assert.deepEqual(loadJob(repo.dir, r.id).issues, [{ tracker: 'github', ref: 'o/r#3', url: 'https://github.com/o/r/issues/3' }]);
    assert.equal(r.id, '3-three');
    await assert.rejects(startFromRef(repo.dir, config, tracker, 'x/y#3', {}), /from-ref takes an issue in o\/r/);
    assert.deepEqual(gets, ['3'], 'a foreign ref is never read');
    for (const ref of ['#3', '3', 'O/R#3']) {
      const again = await startFromRef(repo.dir, config, tracker, ref, {});
      assert.deepEqual(again, { id: r.id, existing: true, stage: 'backlog', state: 'queued' }, ref);
    }
    assert.deepEqual(claims, ['3'], 'an existing job is returned, not claimed again');
  } finally {
    repo.cleanup();
  }
});
