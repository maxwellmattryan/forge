import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { defaults } from '../lib/config.ts';
import { daemonSkeleton, omitProse, redactContext, redactText } from '../lib/redact.ts';
import type { RedactContext } from '../lib/redact.ts';
import { pem, token } from './secret-fixtures.ts';

const ctx = (over: Partial<RedactContext> = {}): RedactContext => ({ root: '/srv/nowhere/repo', home: '/home/nobody', identities: [], config: null, ...over });

describe('redactText', { concurrency: 4 }, () => {
  test('paths: repo before home, on name boundaries', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-redact-')));
    try {
      const home = path.join(dir, 'max');
      const root = path.join(home, 'dev', 'repo');
      fs.mkdirSync(root, { recursive: true });
      // A link to the repo: its realpath is the root, and the text may use either form.
      const link = path.join(dir, 'link');
      fs.symlinkSync(root, link);
      const c = ctx({ root: link, home });
      const text = [`cwd ${root}/lib/x.ts`, `wt ${link}.worktrees/job-1`, `home ${home}/.claude`, `other ${dir}/maxwell/notes`, `bare ${home}`].join('\n');
      const r = redactText(text, c);
      assert.equal(r.text, ['cwd <repo>/lib/x.ts', 'wt <repo>.worktrees/job-1', 'home ~/.claude', `other ${dir}/maxwell/notes`, 'bare ~'].join('\n'));
      assert.equal(r.counts.paths, 4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a worktrees root outside the repo and home becomes <worktrees>', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-redact-')));
    try {
      const root = path.join(dir, 'repo');
      fs.mkdirSync(root);
      const config = defaults();
      config.worktrees.root = '/Volumes/work/wt';
      const c = redactContext(root, config, '/home/nobody');
      assert.equal(c.worktrees, '/Volumes/work/wt');
      const r = redactText(`wt /Volumes/work/wt/job-1 and /Volumes/work/wtx/y and ${root}/lib`, c);
      assert.equal(r.text, 'wt <worktrees>/job-1 and /Volumes/work/wtx/y and <repo>/lib');
      assert.equal(r.counts.paths, 2);
      // The default sits beside the repo as `<repo>.worktrees`: the longer form wins.
      const sibling = redactContext(root, defaults(), '/home/nobody');
      assert.equal(redactText(`${root}.worktrees/job-1 ${root}/x`, sibling).text, '<worktrees>/job-1 <repo>/x');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the machine's host name is an identity", () => {
    const host = os.hostname();
    const c = redactContext(os.tmpdir(), null, '/home/nobody');
    if (/^localhost(\.localdomain)?$/i.test(host) || host.length < 3) return;
    assert.ok(c.identities.includes(host), JSON.stringify(c.identities));
    const label = host.split('.')[0];
    if (label.length >= 3) assert.ok(c.identities.includes(label));
    const r = redactText(`{"host":"${host}"} on ${label}`, c);
    assert.ok(!r.text.toLowerCase().includes(label.toLowerCase()), r.text);
  });

  test('secrets: every provider kind is replaced and JSON stays valid', () => {
    const values: [string, string][] = Object.entries(token).filter(([k]) => !['bearer', 'urlPassword'].includes(k)).map(([k, f]) => [k, (f as () => string)()]);
    for (const [kind, v] of values) {
      const plain = redactText(`the value is ${v} here`, ctx());
      assert.ok(!plain.text.includes(v), `${kind} in plain text`);
      assert.match(plain.text, /<secret:[a-z-]+>/, kind);
      assert.equal(plain.counts.secrets, 1, kind);
      const json = redactText(JSON.stringify({ commands: { test: `run --key ${v}` }, note: v }), ctx());
      assert.ok(!json.text.includes(v), `${kind} in JSON`);
      assert.doesNotThrow(() => JSON.parse(json.text), kind);
    }
    const key = pem();
    const r = redactText(`key:\n${key}\nend`, ctx());
    assert.ok(!r.text.includes(key.split('\n')[1]), 'pem body');
    assert.match(r.text, /<secret:private-key>/);
    const inJson = redactText(JSON.stringify({ key }), ctx());
    assert.doesNotThrow(() => JSON.parse(inJson.text));
    assert.match(inJson.text, /<secret:private-key>/);
  });

  test('emails and logins', () => {
    const c = ctx({ identities: ['plantedlogin', 'Some Person'] });
    const text = [
      'mail planted.person@corp.invalid now',
      'by PlantedLogin and plantedlogin2 and some person',
      'see https://github.com/someorg/repo and git@github.com:otherorg/repo.git and gitlab.com/third',
      'ping @reviewer-1 but not a@b and not x/@y',
      'token <repo> stays',
    ].join('\n');
    const r = redactText(text, c);
    assert.equal(
      r.text,
      [
        'mail <email> now',
        'by <login> and plantedlogin2 and <login>',
        'see https://github.com/<login>/repo and git@github.com/<login>/repo.git and gitlab.com/<login>',
        'ping @<login> but not a@b and not x/@y',
        'token <repo> stays',
      ].join('\n'),
    );
  });

  test('counts per class', () => {
    const v = token.github();
    const r = redactText(`${v} /home/nobody/x a@b.example me @someone`, ctx({ identities: ['me-me'] }));
    assert.deepEqual(r.counts, { secrets: 1, paths: 1, emails: 1, logins: 1 });
    const id = redactText('max effort and Max', ctx({ identities: ['max'] }));
    assert.equal(id.text, '<login> effort and <login>', 'over-redaction is accepted');
    assert.equal(id.counts.logins, 2);
  });

  test('an identity never rewrites a token another pass wrote', () => {
    const r = redactText('/srv/nowhere/repo/x and a@b.example', ctx({ identities: ['repo', 'email'] }));
    assert.equal(r.text, '<repo>/x and <email>');
  });

  test('hostile 10k-character lines stay fast', () => {
    const c = ctx({ identities: ['plantedlogin'] });
    for (const line of ['a'.repeat(10_000), 'a@' + 'a.'.repeat(5_000), '@'.repeat(10_000), 'github.com/'.repeat(1000), 'a.'.repeat(5_000) + '@']) {
      const start = Date.now();
      redactText(line, c);
      assert.ok(Date.now() - start < 1000, `${line.slice(0, 12)}… took ${Date.now() - start} ms`);
    }
  });
});

describe('prose filters', { concurrency: 4 }, () => {
  test('omitProse drops prose keys at any depth and keeps error', () => {
    const v = omitProse({ type: 'verdict', summary: 'secret plan', n: 3, nested: [{ title: 'abc', ok: true, error: 'boom' }], reason: null });
    assert.deepEqual(v, { type: 'verdict', summary: '<omitted: 11 chars>', n: 3, nested: [{ title: '<omitted: 3 chars>', ok: true, error: 'boom' }], reason: null });
  });

  test('daemonSkeleton keeps structure, ids and types only', () => {
    const line = JSON.stringify({ type: 'assistant', session_id: 's1', message: { model: 'opus', content: [{ type: 'text', text: 'PROSE MARKER' }, { type: 'tool_use', name: 'Bash', input: { command: 'rm -rf x' } }] }, n: 2, ok: false, x: null });
    const out = JSON.parse(daemonSkeleton(line));
    assert.equal(out.type, 'assistant');
    assert.equal(out.session_id, 's1');
    assert.equal(out.message.model, 'opus');
    assert.equal(out.message.content[0].type, 'text');
    assert.equal(out.message.content[0].text, '<omitted: 12 chars>');
    assert.equal(out.message.content[1].name, 'Bash');
    assert.equal(out.message.content[1].input.command, '<omitted: 8 chars>');
    assert.deepEqual([out.n, out.ok, out.x], [2, false, null]);
    assert.equal(daemonSkeleton('not json at all'), '<omitted: 15 chars>');
  });
});
