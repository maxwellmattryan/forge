// 1 job = 1 PR = 1 issue: the schema v4 override, the link status, `forge job link` in every mode,
// bounded tracker search (local, GitHub via a fake gh, and the custom-adapter fallback) and the
// `unlinked` note `forge pr open` adds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { createJob, jobDir, loadJob, readEvents } from '../lib/jobs.ts';
import { JOB_SCHEMA_VERSION, WAITING_ON } from '../lib/schema.ts';
import { WAITING_ON as DASH_WAITING_ON } from '../dashboard/src/lib/types.ts';
import { issueLinkStatus, prLinkNote, queryTerms } from '../lib/issue-link.ts';
import { searchTracker } from '../lib/tracker-link.ts';
import github, { inRepo } from '../lib/trackers/github.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

/** A scratch repo initialised with the given tracker, and a CLI runner that never throws. */
function setup(kind = 'local', backlog?: string) {
  const repo = tempRepo();
  const root = repo.dir;
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: root } });
    let json: any = null;
    try {
      json = JSON.parse(r.stdout);
    } catch {}
    return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
  const answers = path.join(root, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind }, pr: { enabled: false } }));
  assert.equal(cli('init', 'write', '--answers', answers).status, 0);
  const backlogFile = path.join(root, '.forge', 'backlog.md');
  if (backlog !== undefined) fs.writeFileSync(backlogFile, backlog);
  const raw = (id: string) => fs.readFileSync(path.join(jobDir(root, id), 'job.json'), 'utf8');
  const newJob = (title: string, ...extra: string[]) => {
    const r = cli('job', 'new', '--title', title, ...extra);
    assert.equal(r.status, 0, r.stderr);
    return r.json.id as string;
  };
  return { repo, root, cli, raw, newJob, backlog: () => fs.readFileSync(backlogFile, 'utf8') };
}

test('reads a schema v3 job as v4', () => {
  const repo = tempRepo();
  try {
    const job = createJob(repo.dir, defaults(), { title: 'Old one' });
    const file = path.join(jobDir(repo.dir, job.id), 'job.json');
    const v3 = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete v3.noIssue;
    fs.writeFileSync(file, JSON.stringify({ ...v3, schemaVersion: 3 }));
    const loaded = loadJob(repo.dir, job.id);
    assert.equal(JOB_SCHEMA_VERSION, 4);
    assert.equal(loaded.schemaVersion, 4);
    assert.equal(loaded.noIssue, null);
    assert.ok(WAITING_ON.includes('issue-link'));
    assert.ok(DASH_WAITING_ON.includes('issue-link'));
    assert.equal(WAITING_ON.indexOf('issue-link'), WAITING_ON.indexOf('split-approval') + 1);
  } finally {
    repo.cleanup();
  }
});

test('issueLinkStatus covers every case', () => {
  const local = { tracker: { kind: 'local' } } as any;
  const none = { tracker: { kind: 'none' } } as any;
  const job = (over: Record<string, unknown> = {}) => ({ source: null, noIssue: null, kind: 'feature', parent: null, ...over }) as any;
  assert.equal(issueLinkStatus(job({ source: { tracker: 'local', ref: 'x', url: null } }), none), 'no-tracker', 'no tracker wins over everything');
  assert.equal(issueLinkStatus(job({ source: { tracker: 'local', ref: 'x', url: null }, noIssue: { reason: null, at: 'now' } }), local), 'linked');
  assert.equal(issueLinkStatus(job({ source: { tracker: 'local', ref: null, url: 'u' } }), local), 'missing', 'a source without a ref is not a link');
  assert.equal(issueLinkStatus(job({ noIssue: { reason: 'tiny', at: 'now' }, kind: 'eval' }), local), 'none');
  assert.equal(issueLinkStatus(job({ kind: 'eval' }), local), 'exempt');
  assert.equal(issueLinkStatus(job({ kind: 'retro' }), local), 'exempt');
  assert.equal(issueLinkStatus(job({ parent: 'big-one' }), local), 'exempt');
  assert.equal(issueLinkStatus(job(), local), 'missing');
});

test('job link: links, refuses and stays idempotent', () => {
  const s = setup('local', '# Backlog\n\n- [ ] Reading time badge\n- [ ] Dark mode toggle\n');
  try {
    const id = s.newJob('Show reading time');
    const linked = s.cli('job', 'link', id, '#reading-time-badge');
    assert.equal(linked.status, 0, linked.stderr);
    assert.deepEqual(linked.json, { id, source: { tracker: 'local', ref: 'reading-time-badge', url: null } });
    assert.deepEqual(loadJob(s.root, id).source, { tracker: 'local', ref: 'reading-time-badge', url: null });
    assert.match(s.backlog(), new RegExp(`- \\[~\\] Reading time badge → ${id}`));
    assert.deepEqual(readEvents(s.root, id).filter((e) => e.type === 'linked').map((e: any) => e.ref), ['reading-time-badge']);

    const before = s.raw(id);
    const again = s.cli('job', 'link', id, 'reading-time-badge');
    assert.equal(again.status, 0);
    assert.deepEqual(again.json, linked.json, 'the same ref again is a no-op');
    assert.equal(s.raw(id), before);
    assert.equal(readEvents(s.root, id).filter((e) => e.type === 'linked').length, 1);

    const other = s.cli('job', 'link', id, 'dark-mode-toggle');
    assert.notEqual(other.status, 0);
    assert.match(other.stderr, /already linked to reading-time-badge/);
    assert.equal(s.raw(id), before, 'a different ref leaves job.json unchanged');

    const second = s.newJob('Another thing');
    const before2 = s.raw(second);
    const unknown = s.cli('job', 'link', second, 'no-such-item');
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /no local item "no-such-item"/);
    const taken = s.cli('job', 'link', second, 'reading-time-badge');
    assert.equal(taken.status, 1);
    assert.match(taken.stderr, new RegExp(`active job ${id}`));
    const bad = s.cli('job', 'link', second, '../etc');
    assert.notEqual(bad.status, 0);
    assert.equal(s.raw(second), before2, 'every refusal leaves job.json unchanged');

    const usage = s.cli('job', 'link', second, 'dark-mode-toggle', '--none');
    assert.notEqual(usage.status, 0, 'exactly one mode');
    assert.match(usage.stderr, /usage: forge job link/);
  } finally {
    s.repo.cleanup();
  }
  const n = setup('none');
  try {
    const id = n.newJob('Untracked work');
    const before = n.raw(id);
    const r = n.cli('job', 'link', id, 'anything');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /tracker.kind is "none"/);
    assert.equal(n.raw(id), before);
  } finally {
    n.repo.cleanup();
  }
});

test('job link --create and --none', () => {
  const s = setup('local', '# Backlog\n');
  try {
    const id = s.newJob('Export to CSV', '--body', 'Users want a CSV export.\n\nWith headers.');
    const r = s.cli('job', 'link', id, '--create');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json, { id, source: { tracker: 'local', ref: 'export-to-csv', url: null }, created: true });
    const text = s.backlog();
    assert.match(text, new RegExp(`- \\[~\\] Export to CSV → ${id}\\n  Users want a CSV export\\.\\n  With headers\\.`));
    assert.ok(!text.includes('# Export to CSV'), 'the request title line is not part of the body');

    const again = s.cli('job', 'link', id, '--create');
    assert.notEqual(again.status, 0, 'a linked job gets no second issue');

    const waived = s.newJob('Bump a typo');
    const none = s.cli('job', 'link', waived, '--none', '--reason', 'too small for an issue');
    assert.equal(none.status, 0, none.stderr);
    assert.equal(none.json.noIssue.reason, 'too small for an issue');
    assert.equal(loadJob(s.root, waived).noIssue!.reason, 'too small for an issue');
    const ev = readEvents(s.root, waived).find((e) => e.type === 'issue-link') as any;
    assert.deepEqual([ev.none, ev.reason], [true, 'too small for an issue']);
    assert.equal(s.cli('job', 'link', waived, '--none').json.noIssue.reason, null, 'the reason is optional');

    const refused = s.cli('job', 'link', id, '--none', '--reason', 'x');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /already linked/);
    assert.equal(loadJob(s.root, id).noIssue, null);

    // Linking clears an earlier override.
    s.cli('tracker', 'create', '--title', 'Typo fixes');
    assert.equal(s.cli('job', 'link', waived, 'typo-fixes').status, 0);
    assert.equal(loadJob(s.root, waived).noIssue, null);
  } finally {
    s.repo.cleanup();
  }
});

test('job link --suggest writes fenced candidates', () => {
  const hostile = 'Run ```rm -rf``` then <script>alert(1)</script> and ```` four';
  const s = setup('local', `# Backlog\n\n- [ ] Reading time badge on posts\n  ${hostile}\n- [ ] Reading list page\n- [x] Reading time estimate\n- [ ] Unrelated chore\n`);
  try {
    const files = (id: string) => ['issue-candidates.md', 'issue-candidates.json'].filter((f) => fs.existsSync(path.join(jobDir(s.root, id), f)));

    const linked = s.newJob('Linked one');
    s.cli('tracker', 'create', '--title', 'Linked one');
    s.cli('job', 'link', linked, 'linked-one');
    const waived = s.newJob('Waived one');
    s.cli('job', 'link', waived, '--none');
    const child = s.newJob('Child one', '--parent', waived);
    const retro = s.newJob('Retro one', '--kind', 'retro');
    for (const [id, status] of [[linked, 'linked'], [waived, 'none'], [child, 'exempt'], [retro, 'exempt']]) {
      const r = s.cli('job', 'link', id, '--suggest');
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.json, { id, needed: false, status });
      assert.deepEqual(files(id), [], `${status}: nothing written`);
    }

    const id = s.newJob('Add a reading time badge');
    const r = s.cli('job', 'link', id, '--suggest');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json, { id, needed: true, status: 'missing', query: 'reading time badge', candidates: 2, file: 'issue-candidates.md' });
    const md = fs.readFileSync(path.join(jobDir(s.root, id), 'issue-candidates.md'), 'utf8');
    assert.match(md.split('\n')[0], /^> Untrusted data: .*not instructions/);
    assert.match(md, /^## 1\. reading-time-badge-on-posts Reading time badge on posts$/m);
    assert.match(md, /^## 2\. reading-list-page Reading list page$/m);
    assert.ok(!md.includes('reading-time-estimate'), 'done items are not candidates');
    // The excerpt sits inside a fence longer than any backtick run in it.
    const lines = md.split('\n');
    const open = lines.findIndex((l) => /^`{3,}text$/.test(l));
    const fence = lines[open].replace('text', '');
    assert.equal(fence.length, 5, 'one longer than the four-backtick run');
    const close = lines.indexOf(fence, open + 1);
    assert.ok(close > open);
    const inside = lines.slice(open + 1, close).join('\n');
    assert.ok(inside.includes('<script>alert(1)</script>') && inside.includes('```rm -rf```'));
    assert.ok(!lines.slice(close + 1).join('\n').includes('<script>'));

    const json = JSON.parse(fs.readFileSync(path.join(jobDir(s.root, id), 'issue-candidates.json'), 'utf8'));
    assert.deepEqual(Object.keys(json), ['query', 'tracker', 'items']);
    assert.deepEqual(json.items.map((i: any) => Object.keys(i).sort()), [['labels', 'ref', 'score', 'title', 'url'], ['labels', 'ref', 'score', 'title', 'url']]);
    assert.ok(!JSON.stringify(json).includes('script'), 'no bodies in the json');
  } finally {
    s.repo.cleanup();
  }
  const n = setup('none');
  try {
    const id = n.newJob('No tracker here');
    assert.deepEqual(n.cli('job', 'link', id, '--suggest').json, { id, needed: false, status: 'no-tracker' });
    assert.ok(!fs.existsSync(path.join(jobDir(n.root, id), 'issue-candidates.md')));
  } finally {
    n.repo.cleanup();
  }
});

test('job link --suggest still writes both files when the search fails', () => {
  const s = setup('local', '# Backlog\n');
  try {
    const id = s.newJob('Reading time badge');
    // A directory where the backlog file should be makes the tracker's read throw.
    fs.rmSync(path.join(s.root, '.forge', 'backlog.md'));
    fs.mkdirSync(path.join(s.root, '.forge', 'backlog.md'));
    const r = s.cli('job', 'link', id, '--suggest');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.needed, true);
    assert.equal(r.json.candidates, 0);
    assert.ok(r.json.searchError);
    const dir = jobDir(s.root, id);
    assert.match(fs.readFileSync(path.join(dir, 'issue-candidates.md'), 'utf8'), /The search failed/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'issue-candidates.json'), 'utf8')).items, []);
  } finally {
    s.repo.cleanup();
  }
});

// A stand-in `gh`: each call's argv goes to the log one element per line, then a separator.
const FAKE_GH = `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> "$FAKE_GH_LOG"; done
echo '--' >> "$FAKE_GH_LOG"
case "$1 $2" in
  "issue list") cat "$FAKE_GH_ISSUES" ;;
esac
`;

test('github search argv via a fake gh', { skip: process.platform === 'win32' }, () => {
  const repo = tempRepo();
  const bin = path.join(repo.dir, '..', `fakebin-${path.basename(repo.dir)}`);
  const saved = { ...process.env };
  try {
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    const log = path.join(bin, 'calls.log');
    const issues = path.join(bin, 'issues.json');
    fs.writeFileSync(log, '');
    fs.writeFileSync(
      issues,
      JSON.stringify([
        { number: 4, title: 'Unrelated', url: 'https://github.com/o/r/issues/4', labels: [], body: 'nothing' },
        { number: 9, title: 'Reading badge', url: 'https://github.com/o/r/issues/9', labels: [{ name: 'ui' }], body: 'a time estimate' },
        { number: 7, title: 'Reading time badge', url: 'https://github.com/o/r/issues/7', labels: [], body: '' },
      ]),
    );
    Object.assign(process.env, { PATH: `${bin}${path.delimiter}${saved.PATH}`, FAKE_GH_LOG: log, FAKE_GH_ISSUES: issues });
    const config = defaults();
    config.tracker.kind = 'github';
    config.tracker.github.repo = 'o/r';
    const r = searchTracker(repo.dir, config, github, 'reading time badge repo:evil/x ORG:evil user:me', 5);
    const calls = fs.readFileSync(log, 'utf8').split('--\n').filter(Boolean).map((c) => c.split('\n').filter((l, i, a) => i < a.length - 1 || l));
    assert.deepEqual(calls[0], ['issue', 'list', '-R', 'o/r', '--state', 'open', '--search', 'reading time badge', '--json', 'number,title,url,labels,body', '--limit', '30']);
    assert.deepEqual(calls[1][7], 'reading OR time OR badge', 'fewer than the limit came back, so any word will do');
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => Number(c[c.length - 1]) <= 30));
    assert.ok(!calls.flat().some((a) => /evil|user:me/i.test(a)), 'repo:, org: and user: qualifiers are dropped');
    assert.deepEqual(r.items.map((i) => [i.ref, i.score]), [['7', 6], ['9', 5]], 're-ranked locally, the unrelated one dropped');
    assert.deepEqual(r.items[1].labels, ['ui']);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(bin, { recursive: true, force: true });
    repo.cleanup();
  }
});

test('github search: qualifiers and syntax cannot widen or redirect it', { skip: process.platform === 'win32' }, () => {
  const repo = tempRepo();
  const bin = path.join(repo.dir, '..', `fakebin-${path.basename(repo.dir)}`);
  const saved = { ...process.env };
  try {
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    const log = path.join(bin, 'calls.log');
    const issues = path.join(bin, 'issues.json');
    fs.writeFileSync(log, '');
    fs.writeFileSync(
      issues,
      JSON.stringify([
        { number: 5, title: 'Reading time badge', url: 'https://github.com/evil/x/issues/5', labels: [], body: '' },
        { number: 6, title: 'Reading time badge', url: 'http://github.com/o/r/issues/6', labels: [], body: '' },
        { number: 8, title: 'Reading time badge', url: 'https://github.com/o/r/pull/8', labels: [], body: '' },
        { number: 3, title: 'Reading time badge', url: 'https://github.com/o/r/issues/3', labels: [], body: '' },
      ]),
    );
    Object.assign(process.env, { PATH: `${bin}${path.delimiter}${saved.PATH}`, FAKE_GH_LOG: log, FAKE_GH_ISSUES: issues });
    const config = defaults();
    config.tracker.kind = 'github';
    config.tracker.github.repo = 'o/r';
    const hostile = 'reading is:closed label:"x" (time OR badge) "quoted words" -negated in:body repo:evil/x org:evil user:me NOT secret';
    assert.deepEqual(queryTerms(hostile), ['reading', 'secret']);
    const r = searchTracker(repo.dir, config, github, hostile, 5);
    const searches = fs.readFileSync(log, 'utf8').split('\n').filter((l, i, a) => a[i - 1] === '--search');
    assert.deepEqual(searches, ['reading secret', 'reading OR secret']);
    for (const q of searches) assert.match(q, /^[a-z0-9]+(?: (?:OR )?[a-z0-9]+)*$/, 'plain words only');
    assert.deepEqual(r.items.map((i) => i.ref), ['3'], 'items outside https://github.com/o/r/issues/ are dropped');
    assert.equal(inRepo('https://github.com/O/R/issues/3', 'o/r'), true);
    assert.equal(inRepo('https://github.com/o/r/issues/3/../../../evil/x/issues/1', 'o/r'), false);
    assert.equal(inRepo('https://github.com.evil.io/o/r/issues/3', 'o/r'), false);
    assert.equal(inRepo(null, 'o/r'), false);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(bin, { recursive: true, force: true });
    repo.cleanup();
  }
});

test('custom adapter fallback is capped', () => {
  const asked: unknown[] = [];
  const items = Array.from({ length: 300 }, (_, n) => ({ ref: `A-${n}`, title: n % 2 ? `Widget ${n}` : `Gadget ${n}`, body: n === 4 ? 'widget in the body' : '' }));
  const tracker: any = {
    name: 'acme',
    list: (_ctx: unknown, opts: { limit?: number }) => {
      asked.push(opts);
      return items.slice(0, opts.limit ?? items.length);
    },
  };
  const config = defaults();
  config.tracker.kind = 'acme';
  const r = searchTracker('/nonexistent', config, tracker, 'widget', 3);
  assert.deepEqual(asked, [{ limit: 200 }]);
  assert.deepEqual(r.items.map((i) => i.ref), ['A-1', 'A-3', 'A-5']);
  const all = searchTracker('/nonexistent', config, { ...tracker, list: () => items }, 'widget', 20);
  assert.equal(all.items.length, 20, 'an adapter ignoring the limit is still capped');
  assert.ok(!all.items.some((i) => Number(i.ref.slice(2)) >= 200), 'only the first 200 are scored');
  assert.deepEqual(searchTracker('/nonexistent', config, tracker, 'the and of', 3).items, [], 'no terms, no search');
});

test('pr open reports unlinked only when missing', () => {
  const local = { tracker: { kind: 'local' } } as any;
  const base = { source: null, noIssue: null, kind: 'feature', parent: null } as any;
  assert.deepEqual(prLinkNote(base, local), { unlinked: true });
  assert.deepEqual(prLinkNote({ ...base, noIssue: { reason: null, at: 'now' } }, local), {});
  assert.deepEqual(prLinkNote({ ...base, kind: 'eval' }, local), {});
  assert.deepEqual(prLinkNote({ ...base, source: { tracker: 'local', ref: '3', url: null } }, local), {});
  assert.deepEqual(prLinkNote(base, { tracker: { kind: 'none' } } as any), {});
  // openPr spreads the note into its result.
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'pr.ts'), 'utf8');
  assert.equal(src.match(/created: (true|false), \.\.\.prLinkNote\(job, config\)/g)?.length, 2);
});

test('SKILL.md gates Intake on issue-link and routes the answers', () => {
  const skill = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'skills', 'forge', 'SKILL.md'), 'utf8');
  const intake = skill.slice(skill.indexOf('### 0. Intake'), skill.indexOf('### 1. Plan'));
  assert.ok(intake.indexOf('forge job link <id> --suggest') < intake.indexOf('forge worktree create'), 'the gate runs before the worktree');
  assert.ok(intake.includes('--waiting-on issue-link --reason "link an issue"'));
  for (const answer of ['/forge approve <id> <ref>', '/forge approve <id> new', '/forge approve <id> none [reason]']) assert.ok(intake.includes(answer), answer);
  const approve = skill.split('\n').find((l) => l.startsWith('| `approve <job>'))!;
  for (const s of ['issue-link', 'args.link', 'forge job link <job> <ref>', '--create', '--none --reason']) assert.ok(approve.includes(s), s);
  const requests = skill.slice(skill.indexOf('## Requests'), skill.indexOf('## Self-improvement'));
  for (const s of ['`next` (args.n, default 1) → `next <n>`', '`args.intake: new`', 'Split mode: pipeline.split', 'using `args.link`']) assert.ok(requests.includes(s), s);
  assert.ok(skill.includes('If its result has `unlinked: true`, report'));
});
