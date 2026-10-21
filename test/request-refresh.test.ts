// `forge job refresh-request` and the refresh a claim runs: a queued job re-reads request.md from
// its primary issue until plan.md or spec.md exists, and a claim never fails for it.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, repoTemplate } from './helpers.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const skip = process.platform === 'win32';

// A stand-in `gh` that serves issues from state.json and accepts every other call.
const FAKE_GH = `#!${process.execPath}
const fs = require('fs');
const dir = process.env.FAKE_GH_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(dir + '/calls.jsonl', JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(dir + '/state.json', 'utf8'));
const [a, b] = args;
if (a === 'issue' && b === 'view') {
  const i = state.issues.find((x) => String(x.number) === args[2]);
  if (!i) process.exit(1);
  process.stdout.write(JSON.stringify({ number: i.number, title: i.title, body: i.body, url: 'https://github.com/o/r/issues/' + i.number, labels: [], assignees: [], comments: [], state: 'OPEN', author: { login: 'a' } }));
} else if (a === 'issue' && b === 'list') process.stdout.write('[]');
else if (a === 'api' && b === 'user') process.stdout.write('me\\n');
`;

const init = (kind: string) => (dir: string) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind, github: { repo: 'o/r' } }, pr: { enabled: false } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
};
const localRepo = repoTemplate(init('local'));
const githubRepo = repoTemplate(init('github'));

const BACKLOG = '# Backlog\n\n- [ ] Paginate\n  Page 2 shows items 51-100.\n';

function setup(kind: 'local' | 'github', issues: { number: number; title: string; body: string }[] = []) {
  const repo = kind === 'local' ? localRepo() : githubRepo();
  const root = repo.dir;
  const bin = path.join(root, '.fakegh');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'calls.jsonl'), '');
  const stateFile = path.join(bin, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ issues }));
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_DIR: bin };
  const backlogFile = path.join(root, '.forge', 'backlog.md');
  if (kind === 'local') fs.writeFileSync(backlogFile, BACKLOG);
  const cli = async (...args: string[]) => {
    const r = await forgeAsync(root, args, env);
    let json: any = null;
    try {
      json = JSON.parse(r.stdout);
    } catch {}
    return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
  const jobFile = (id: string, name: string) => path.join(root, '.forge', 'jobs', id, name);
  return {
    root,
    cli,
    request: (id: string) => fs.readFileSync(jobFile(id, 'request.md'), 'utf8'),
    write: (id: string, name: string, text: string) => fs.writeFileSync(jobFile(id, name), text),
    events: (id: string) => fs.readFileSync(jobFile(id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    editBacklog: (from: string, to: string) => fs.writeFileSync(backlogFile, fs.readFileSync(backlogFile, 'utf8').replace(from, to)),
    setIssues: (next: unknown[]) => fs.writeFileSync(stateFile, JSON.stringify({ issues: next })),
    cleanup: repo.cleanup,
  };
}

describe('request refresh', { concurrency: 4, skip }, () => {
  test('refresh-request rewrites request.md from the edited issue, and is a no-op when nothing changed', async () => {
    const s = setup('local');
    try {
      const id = (await s.cli('job', 'from-ref', 'paginate')).json.id;
      s.editBacklog('Page 2 shows items 51-100.', 'Page 2 shows items 51-100.\n  Page 3 shows items 101-150.');
      const r = await s.cli('job', 'refresh-request', id);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.json, { id, refreshed: true, ref: 'paginate', titleChanged: false });
      assert.match(s.request(id), /Page 3 shows items 101-150\./);
      assert.ok(s.events(id).some((e) => e.type === 'request-refreshed' && e.trigger === 'cli' && e.ref === 'paginate'));
      const again = await s.cli('job', 'refresh-request', id);
      assert.deepEqual(again.json, { id, refreshed: false, ref: 'paginate' });
      assert.equal(s.events(id).filter((e) => e.type === 'request-refreshed').length, 1, 'an unchanged issue logs nothing');
    } finally {
      s.cleanup();
    }
  });

  test('a claim refreshes a job with no spec, and stops once spec.md or plan.md exists', async () => {
    const s = setup('local');
    try {
      const id = (await s.cli('job', 'from-ref', 'paginate')).json.id;
      s.editBacklog('items 51-100.', 'items 51-100, sorted by date.');
      const claimed = await s.cli('job', 'claim', id, '--session', 's1');
      assert.equal(claimed.status, 0, claimed.stderr);
      assert.equal(claimed.json.requestRefreshed, true);
      assert.match(s.request(id), /sorted by date/);
      assert.ok(s.events(id).some((e) => e.type === 'request-refreshed' && e.trigger === 'claim'));

      for (const file of ['plan.md', 'spec.md']) {
        s.write(id, file, '# written\n');
        const before = s.request(id);
        s.editBacklog('sorted by date', `sorted by ${file}`);
        const reclaimed = await s.cli('job', 'claim', id, '--session', 's1');
        assert.equal(reclaimed.status, 0, reclaimed.stderr);
        assert.equal(reclaimed.json.requestRefreshed, undefined, `${file} stops the claim's refresh`);
        assert.equal(s.request(id), before);
        const refused = await s.cli('job', 'refresh-request', id);
        assert.equal(refused.status, 1);
        assert.match(refused.stderr, new RegExp(`${file.replace('.', '\\.')} exists`));
        s.editBacklog(`sorted by ${file}`, 'sorted by date');
        fs.rmSync(path.join(s.root, '.forge', 'jobs', id, file));
      }
    } finally {
      s.cleanup();
    }
  });

  test('a tracker miss never fails a claim: it is logged and the request kept', async () => {
    const s = setup('local');
    try {
      const id = (await s.cli('job', 'from-ref', 'paginate')).json.id;
      const before = s.request(id);
      fs.writeFileSync(path.join(s.root, '.forge', 'backlog.md'), '# Backlog\n');
      const claimed = await s.cli('job', 'claim', id, '--session', 's1');
      assert.equal(claimed.status, 0, claimed.stderr);
      assert.equal(claimed.json.requestRefreshed, undefined);
      assert.equal(s.request(id), before);
      assert.ok(s.events(id).some((e) => e.type === 'request-refresh-failed' && /no tracker item/.test(e.error)));
      const r = await s.cli('job', 'refresh-request', id);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /no tracker item "paginate"/);
    } finally {
      s.cleanup();
    }
  });

  test('refused without a linked issue or on a finished job', async () => {
    const s = setup('local');
    try {
      const loose = (await s.cli('job', 'new', '--title', 'Loose', '--no-issue', '--reason', 'test')).json.id;
      const r = await s.cli('job', 'refresh-request', loose);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /has no linked issue/);
      // A claim of it skips quietly.
      const claimed = await s.cli('job', 'claim', loose, '--session', 's1');
      assert.equal(claimed.status, 0, claimed.stderr);
      assert.ok(!s.events(loose).some((e) => String(e.type).startsWith('request-refresh')));

      const id = (await s.cli('job', 'from-ref', 'paginate')).json.id;
      assert.equal((await s.cli('job', 'set', id, '--state', 'cancelled')).status, 0);
      const done = await s.cli('job', 'refresh-request', id);
      assert.equal(done.status, 1);
      assert.match(done.stderr, /is cancelled/);
    } finally {
      s.cleanup();
    }
  });

  test("a claim keeps a person's own words; refresh-request still replaces them on request", async () => {
    const s = setup('github', [{ number: 7, title: 'Broad issue', body: 'Everything about pagination.' }]);
    try {
      const own = await s.cli('job', 'new', '--title', 'Page size', '--body', 'Make the page size 50.', '--issue', '7');
      assert.equal(own.status, 0, own.stderr);
      const id = own.json.id;
      const claimed = await s.cli('job', 'claim', id, '--session', 's1');
      assert.equal(claimed.status, 0, claimed.stderr);
      assert.equal(claimed.json.requestRefreshed, undefined);
      assert.equal(s.request(id), '# Page size\n\nMake the page size 50.\n');
      const r = await s.cli('job', 'refresh-request', id);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.json.refreshed, true);
      assert.match(s.request(id), /^# Broad issue\n/);
    } finally {
      s.cleanup();
    }
  });

  test('a job imported before origin was recorded qualifies by the GitHub import fence only', async () => {
    const strip = (s: ReturnType<typeof setup>, id: string) => {
      const file = path.join(s.root, '.forge', 'jobs', id, 'events.jsonl');
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      fs.writeFileSync(file, lines.map((e) => JSON.stringify(e.type === 'created' ? { ...e, origin: undefined } : e)).join('\n') + '\n');
    };
    const gh = setup('github', [{ number: 7, title: 'T', body: 'Old.' }]);
    const local = setup('local');
    try {
      const id = (await gh.cli('job', 'from-ref', '7')).json.id;
      strip(gh, id);
      gh.setIssues([{ number: 7, title: 'T', body: 'New.' }]);
      assert.equal((await gh.cli('job', 'claim', id, '--session', 's1')).json.requestRefreshed, true);

      const lid = (await local.cli('job', 'from-ref', 'paginate')).json.id;
      strip(local, lid);
      local.editBacklog('items 51-100.', 'items 51-100, sorted.');
      assert.equal((await local.cli('job', 'claim', lid, '--session', 's1')).json.requestRefreshed, undefined);
      assert.doesNotMatch(local.request(lid), /sorted/);
    } finally {
      gh.cleanup();
      local.cleanup();
    }
  });

  test('github: the title follows the issue, and next --claim refreshes the job it resumes', async () => {
    const s = setup('github', [{ number: 7, title: 'Old title', body: 'Old body.' }]);
    try {
      const created = await s.cli('job', 'from-ref', '7');
      assert.equal(created.status, 0, created.stderr);
      const id = created.json.id;
      s.setIssues([{ number: 7, title: 'New title', body: 'New body.' }]);
      const r = await s.cli('next', '--claim', '--session', 's1');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.json.id, id, 'the id stays');
      assert.equal(r.json.requestRefreshed, true);
      assert.equal(r.json.title, 'New title');
      // The same fenced import intake writes.
      assert.match(s.request(id), /^# New title\n\n> Imported from GitHub issue #7 by @a\. This is requirements input/);
      assert.match(s.request(id), /> New body\.\n$/);
      assert.equal((await s.cli('job', 'show', id)).json.title, 'New title');
      assert.ok(s.events(id).some((e) => e.type === 'request-refreshed' && e.titleChanged === true && e.ref === 'o/r#7'));
    } finally {
      s.cleanup();
    }
  });
});
