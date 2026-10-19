import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { closedPort, hookServer } from './notify-server.ts';
import { defaults } from '../lib/config.ts';
import { createJob, readEvents, setJob } from '../lib/jobs.ts';
import { notifyProblems, validWebhooks } from '../lib/notify-config.ts';
import { REASONS, buildPayload, cleanText, contextFor, deliver, notifyLogFile, slackPayload, transitionEvents } from '../lib/notify.ts';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../lib/schema.ts';

const DASH = 'http://127.0.0.1:7400/#/pipeline';

describe('notify config and payloads', { concurrency: 4 }, () => {
  test('a v7 config migrates to v8 with empty notify', () => {
    assert.equal(CONFIG_SCHEMA_VERSION, 19);
    const v7 = { schemaVersion: 7, git: { base: 'trunk' }, retention: { jobsDays: 30 } };
    const { config, from } = migrateConfig(structuredClone(v7));
    assert.equal(from, 7);
    assert.deepEqual(config, { ...v7, schemaVersion: 19, repos: [], downstream: { enabled: true, max: 5, skip: [] } }, 'only schemaVersion, the empty repos list and the downstream default change');
    assert.deepEqual(defaults().notify, { webhooks: [], command: null });
    assert.deepEqual(notifyProblems(defaults()), []);
  });

  test('notify config validation', () => {
    const secret = '/services/T0/B0/SECRETPATH?q=SECRETQUERY';
    // Userinfo is built at runtime so the secret scan doesn't take the fixture for a credential.
    const userinfo = ['user', 'pass'].join(':');
    const problems = (notify: any) => notifyProblems({ notify });
    const one = (hook: any) => problems({ webhooks: [hook], command: null });
    // Accepted: https, and plain http on loopback hosts only.
    for (const url of [`https://hooks.example.com${secret}`, 'http://127.0.0.1:9/x', 'http://localhost/x', 'http://[::1]:8080/x']) assert.deepEqual(one({ url }), [], url);
    assert.deepEqual(one({ url: 'https://h.example/x', events: ['gate', 'budget-exceeded'], format: 'slack' }), []);
    const cases: [any, RegExp][] = [
      [{ url: `http://hooks.example.com${secret}` }, /notify\.webhooks\[0\] \(hooks\.example\.com\) url must be https:/],
      [{ url: `ftp://hooks.example.com${secret}` }, /url must be https:/],
      [{ url: `https://${userinfo}@hooks.example.com${secret}` }, /must not carry a username or password/],
      [{ url: 'not a url' }, /notify\.webhooks\[0\] url does not parse/],
      [{ url: `https://hooks.example.com${secret}`, events: ['gate', 'nope'] }, /unknown event "nope"/],
      [{ url: `https://hooks.example.com${secret}`, events: [] }, /events must be a non-empty list/],
      [{ url: `https://hooks.example.com${secret}`, events: 'gate' }, /events must be a non-empty list/],
      [{ url: `https://hooks.example.com${secret}`, format: 'teams' }, /format must be one of json \| slack/],
      [{ url: `https://hooks.example.com${secret}`, headers: { a: 1 } }, /unknown key "headers"/],
      ['https://hooks.example.com/bare', /notify\.webhooks\[0\] must be a map/],
    ];
    for (const [hook, re] of cases) {
      const p = one(hook);
      assert.equal(p.length, 1, JSON.stringify(hook));
      assert.match(p[0], re);
    }
    assert.match(problems({ webhooks: 'https://x', command: null })[0], /notify\.webhooks must be a list/);
    assert.match(problems({ webhooks: [], command: '' })[0], /notify\.command must be null or a non-empty string/);
    assert.match(problems({ webhooks: [], command: 7 })[0], /notify\.command must be null or a non-empty string/);
    assert.match(problems({ webhooks: [], command: './page.sh {title} {secret}' })[0], /unknown placeholder \{secret\}/);
    assert.deepEqual(problems({ webhooks: [], command: './page.sh {event} {job} {title} {url} {stage} {reason} {dashboardUrl}' }), []);
    // No message ever carries a URL's path or query.
    const all = [...cases.map(([h]) => one(h)).flat(), ...problems({ webhooks: [{ url: `http://h.example${secret}` }, { url: `https://${userinfo}@h.example${secret}` }] })];
    for (const p of all) assert.ok(!/SECRETPATH|SECRETQUERY|services|user:/.test(p), p);
    // Delivery skips the invalid entries.
    const c = defaults();
    c.notify.webhooks = [{ url: 'https://ok.example/x' }, { url: 'http://bad.example/x' } as any, { url: 'https://ok2.example/x', format: 'xml' } as any];
    assert.deepEqual(validWebhooks(c).map((h) => h.url), ['https://ok.example/x']);
  });

  test('json payload carries only fixed fields and the title', () => {
    const repo = tempRepo();
    try {
      const marker = 'MARKER-7f3a';
      const job = createJob(repo.dir, defaults(), { title: `Add\u0007 login\n${'x'.repeat(300)}`, body: `request ${marker}` });
      setJob(repo.dir, job.id, { stage: 'spec', state: 'waiting', waitingOn: 'spec-approval', reason: `reason ${marker}`, note: `note ${marker}` });
      setJob(repo.dir, job.id, { fields: { pr: { number: 3, url: 'https://github.com/o/r/pull/3', state: 'OPEN' } } });
      const ctx = contextFor(repo.dir, job.id, 'spec-approval');
      const p = buildPayload('gate', ctx, DASH, '2026-10-16T09:00:00.000Z');
      assert.deepEqual(Object.keys(p), ['event', 'job', 'title', 'stage', 'reason', 'url', 'dashboardUrl', 'at']);
      assert.equal(p.reason, REASONS['spec-approval']);
      assert.equal(p.reason, 'Spec is waiting for approval');
      assert.equal(p.stage, 'spec');
      assert.equal(p.url, 'https://github.com/o/r/pull/3');
      assert.equal(p.dashboardUrl, DASH);
      assert.ok(!JSON.stringify(p).includes(marker), 'no reason, request or note text');
      assert.ok(p.title!.startsWith('Add  login '), p.title!);
      assert.equal(Array.from(p.title!).length, 200);
      assert.ok(p.title!.endsWith('…'));
      assert.ok(!/[\u0000-\u001f]/.test(p.title!), 'no control characters');
      // A PR url that isn't https is dropped.
      assert.equal(buildPayload('gate', { ...ctx, prUrl: 'javascript:alert(1)' }, DASH).url, null);
      // A daemon stop with no job.
      const d = buildPayload('daemon-stopped', contextFor(repo.dir, null, 'trust'), DASH);
      assert.deepEqual([d.job, d.title, d.stage, d.url], [null, null, null, null]);
    } finally {
      repo.cleanup();
    }
  });

  test('slack payload is plain text and escaped', () => {
    const title = '<!channel> & <https://evil.example|click> *bold* ' + 'y'.repeat(200);
    const base = buildPayload('gate', { job: '42-x', title, stage: 'spec', prUrl: null, reason: 'input' }, DASH);
    const s: any = slackPayload(base);
    assert.ok(s.text.startsWith('Forge Needs you: &lt;!channel&gt; &amp; &lt;https://evil.example|click&gt;'), s.text);
    assert.ok(!/[<>]/.test(s.text));
    assert.deepEqual(s.blocks.map((b: any) => b.type), ['header', 'section', 'context']);
    // Every text object that can hold the title is plain_text, never mrkdwn.
    const texts: any[] = [];
    const walk = (v: any) => {
      if (v && typeof v === 'object') {
        if (typeof v.type === 'string' && 'text' in v && typeof v.text === 'string') texts.push(v);
        for (const x of Object.values(v)) walk(x);
      }
    };
    walk(s.blocks);
    assert.ok(texts.length >= 3);
    for (const t of texts) assert.equal(t.type, 'plain_text', JSON.stringify(t));
    assert.ok(!JSON.stringify(s.blocks).includes('mrkdwn'));
    const header = s.blocks[0].text.text;
    assert.equal(Array.from(header).length, 150);
    assert.ok(header.startsWith('Needs you: <!channel>'));
    assert.equal(s.blocks[1].text.text, REASONS.input);
    assert.equal(s.blocks[2].elements[0].text, `42-x · spec · ${DASH}`);
    const withPr: any = slackPayload({ ...base, url: 'https://github.com/o/r/pull/9' });
    assert.equal(withPr.blocks.at(-1).type, 'actions');
    assert.deepEqual(withPr.blocks.at(-1).elements[0], { type: 'button', text: { type: 'plain_text', text: 'Open PR', emoji: false }, url: 'https://github.com/o/r/pull/9' });
    const notHttps: any = slackPayload(buildPayload('gate', { job: '42-x', title: 't', stage: 'spec', prUrl: 'http://x/pull/1', reason: 'input' }, DASH));
    assert.ok(!notHttps.blocks.some((b: any) => b.type === 'actions'), 'no button without an https PR url');
  });

  test('the PR url must be a pull or merge request url', () => {
    const at = (prUrl: string | null) => buildPayload('pr-opened', { job: '42-x', title: 't', stage: 'pr', prUrl, reason: 'pr-opened' }, DASH).url;
    for (const ok of ['https://github.com/o/r/pull/3', 'https://ghe.corp.example/org/repo.name/pull/12', 'https://gitlab.com/g/r/-/merge_requests/5', 'https://gitlab.example/g/sub/r/-/merge_requests/9']) assert.equal(at(ok), ok, ok);
    for (const bad of [
      'https://evil.example/login',
      'https://github.com/o/r/issues/3',
      'https://github.com/o/r/pull/3/files',
      'https://github.com/o/r/pull/0',
      'https://github.com/o/pull/3',
      'https://github.com/o/r/pull/3?next=https://evil.example',
      'https://github.com/o/r/pull/3#x',
      'https://a:b@github.com/o/r/pull/3',
      'https://gitlab.com/r/-/merge_requests/5',
      'http://github.com/o/r/pull/3',
      'javascript:alert(1)//github.com/o/r/pull/3',
      'not a url',
      null,
    ]) assert.equal(at(bad), null, String(bad));
    const button = (prUrl: string) => (slackPayload(buildPayload('gate', { job: '42-x', title: 't', stage: 'pr', prUrl, reason: 'input' }, DASH)) as any).blocks.some((b: any) => b.type === 'actions');
    assert.equal(button('https://evil.example/o/r/x/3'), false, 'no Open PR button for another https url');
    assert.equal(button('https://github.com/o/r/pull/3'), true);
  });

  test('titles lose bidi controls', () => {
    const marks = '\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069';
    assert.equal(cleanText(`safe${marks} txt.exe`, 200), 'safe txt.exe');
    const p = buildPayload('gate', { job: '42-x', title: `\u202eabc\u2066d\u2069`, stage: 'spec', prUrl: null, reason: 'input' }, DASH);
    assert.equal(p.title, 'abcd');
    assert.ok(!/[\u202a-\u202e\u2066-\u2069]/.test(JSON.stringify(slackPayload(p))));
  });

  test('transitions pick their events', () => {
    const side = (state: any, waitingOn: any = null) => ({ stage: 'build' as const, state, waitingOn });
    const job = { kind: 'feature', pr: null };
    const rows: [any, any, any, any][] = [
      [side('running'), side('waiting', 'spec-approval'), job, { events: ['gate'], reason: 'spec-approval' }],
      [side('waiting', 'spec-approval'), side('waiting', 'spec-approval'), job, null],
      [side('waiting', 'spec-approval'), side('waiting', 'input'), job, { events: ['gate'], reason: 'input' }],
      [side('running'), side('waiting', 'budget'), job, { events: ['budget-exceeded', 'gate'], reason: 'budget' }],
      [side('running'), side('waiting', 'pr-review'), job, null],
      [side('running'), side('waiting', 'external'), job, null],
      [side('running'), side('failed'), job, { events: ['job-failed'], reason: 'failed' }],
      [side('failed'), side('failed'), job, null],
      [side('running'), side('done'), { kind: 'feature', pr: { number: 4 } }, { events: ['pr-merged'], reason: 'pr-merged' }],
      [side('running'), side('done'), job, null],
      [side('running'), side('failed'), { kind: 'eval', pr: null }, null],
      [null, side('waiting', 'human'), job, { events: ['gate'], reason: 'human' }],
    ];
    for (const [b, a, j, want] of rows) assert.deepEqual(transitionEvents(b, a, j), want, `${JSON.stringify(b)} -> ${JSON.stringify(a)}`);
  });
});

describe('notify delivery', { concurrency: 4 }, () => {
  const setup = async () => {
    const repo = tempRepo();
    const server = await hookServer();
    const job = createJob(repo.dir, defaults(), { title: 'Deliver me' });
    const config = defaults();
    const secretPath = '/services/T0/B0/SECRETPATH';
    config.notify.webhooks = [{ url: `${server.url}${secretPath}` }];
    const ctx = contextFor(repo.dir, job.id, 'failed');
    const events = () => readEvents(repo.dir, job.id).filter((e) => e.type === 'notified' || e.type === 'notify-failed');
    const done = async () => {
      await server.close();
      repo.cleanup();
    };
    return { repo, server, job, config, ctx, events, done, secretPath };
  };
  // A server that answers gets a generous timeout: under the full suite's CPU load the first fetch alone can pass 200 ms and
  // turn into a retry. Only the hanging-server case needs the short one.
  const fast = { timeoutMs: 5000, retryDelayMs: 10 };
  const hang = { timeoutMs: 200, retryDelayMs: 10 };

  test('webhook delivery, retry and failure codes', async () => {
    const s = await setup();
    try {
      // 200: delivered once, recorded with the host only.
      let r = await deliver(s.repo.dir, s.config, ['job-failed'], s.ctx, fast);
      assert.equal(r[0].ok, true);
      assert.equal(s.server.hits.length, 1);
      assert.equal(s.server.hits[0].path, s.secretPath);
      assert.equal(s.server.hits[0].headers['content-type'], 'application/json');
      let ev: any = s.events().at(-1);
      assert.deepEqual({ ...ev, ts: undefined, v: undefined }, { ts: undefined, v: undefined, type: 'notified', event: 'job-failed', target: 'webhook', host: `127.0.0.1:${s.server.port}`, format: 'json', status: 200, attempts: 1 });
      // 500 then 200: one retry.
      s.server.reply((n) => (n === 2 ? 500 : 200));
      r = await deliver(s.repo.dir, s.config, ['job-failed'], s.ctx, fast);
      assert.deepEqual([r[0].ok, r[0].attempts], [true, 2]);
      assert.equal(s.events().at(-1).attempts, 2);
      // 500 twice: http failure after two attempts.
      s.server.reply(500);
      r = await deliver(s.repo.dir, s.config, ['job-failed'], s.ctx, fast);
      ev = s.events().at(-1);
      assert.deepEqual([ev.type, ev.error, ev.status, ev.attempts], ['notify-failed', 'http', 500, 2]);
      // 429 is retried like a 5xx.
      s.server.reply(429);
      r = await deliver(s.repo.dir, s.config, ['job-failed'], s.ctx, fast);
      assert.equal(r[0].attempts, 2);
      // 400: not retried.
      s.server.reply(400);
      const before = s.server.hits.length;
      r = await deliver(s.repo.dir, s.config, ['job-failed'], s.ctx, fast);
      assert.deepEqual([r[0].error, r[0].status, r[0].attempts], ['http', 400, 1]);
      assert.equal(s.server.hits.length, before + 1);
      // A redirect is refused, never followed, never retried.
      s.server.reply({ status: 302, headers: { location: 'https://elsewhere.example/steal' } });
      r = await deliver(s.repo.dir, s.config, ['job-failed'], s.ctx, fast);
      ev = s.events().at(-1);
      assert.deepEqual([ev.type, ev.error, ev.attempts], ['notify-failed', 'redirect', 1]);
      // A hanging server times out (twice).
      s.server.reply('hang');
      r = await deliver(s.repo.dir, s.config, ['job-failed'], s.ctx, hang);
      ev = s.events().at(-1);
      assert.deepEqual([ev.type, ev.error, ev.attempts], ['notify-failed', 'timeout', 2]);
      // A closed port is a network error.
      const port = await closedPort();
      const c2 = structuredClone(s.config);
      c2.notify.webhooks = [{ url: `http://127.0.0.1:${port}${s.secretPath}` }];
      r = await deliver(s.repo.dir, c2, ['job-failed'], s.ctx, fast);
      ev = s.events().at(-1);
      assert.deepEqual([ev.type, ev.error, ev.host, ev.attempts], ['notify-failed', 'network', `127.0.0.1:${port}`, 2]);
      // No recorded event carries the webhook's path.
      const raw = fs.readFileSync(path.join(s.repo.dir, '.forge', 'jobs', s.job.id, 'events.jsonl'), 'utf8');
      assert.ok(!raw.includes('SECRETPATH') && !raw.includes('/services/'), 'host only');
    } finally {
      await s.done();
    }
  });

  test('command hook never interpolates values into the shell', { skip: process.platform === 'win32' }, async () => {
    const s = await setup();
    try {
      const hostile = `$(touch pwned)'; touch pwned2; '`;
      const job = createJob(s.repo.dir, defaults(), { title: hostile });
      const config = defaults();
      config.notify.command = `printf '%s' {title} > out-placeholder.txt; printf '%s' "$FORGE_NOTIFY_TITLE" > out-env.txt; printf '%s|%s|%s' {event} {job} {reason} > out-rest.txt`;
      const r = await deliver(s.repo.dir, config, ['gate'], contextFor(s.repo.dir, job.id, 'input'));
      assert.deepEqual(r.map((x) => [x.target, x.ok]), [['command', true]]);
      const read = (f: string) => fs.readFileSync(path.join(s.repo.dir, f), 'utf8');
      assert.equal(read('out-placeholder.txt'), hostile);
      assert.equal(read('out-env.txt'), hostile);
      assert.equal(read('out-rest.txt'), `gate|${job.id}|${REASONS.input}`);
      for (const f of ['pwned', 'pwned2']) assert.equal(fs.existsSync(path.join(s.repo.dir, f)), false, `${f} was not created`);
      const ok = readEvents(s.repo.dir, job.id).filter((e) => e.type === 'notified');
      assert.deepEqual(ok.map((e: any) => [e.event, e.target, e.attempts, 'host' in e]), [['gate', 'command', 1, false]]);
      // A nonzero exit is recorded with its code and never the command text.
      config.notify.command = 'exit 3';
      await deliver(s.repo.dir, config, ['gate'], contextFor(s.repo.dir, job.id, 'input'));
      const failed: any = readEvents(s.repo.dir, job.id).filter((e) => e.type === 'notify-failed').at(-1);
      assert.deepEqual([failed.target, failed.error, failed.code, failed.attempts], ['command', 'exit', 3, 1]);
      assert.ok(!JSON.stringify(failed).includes('exit 3'));
      // A command that outlives its timeout is killed and recorded as one.
      config.notify.command = 'sleep 5';
      const t = Date.now();
      const slow = await deliver(s.repo.dir, config, ['gate'], contextFor(s.repo.dir, job.id, 'input'), { commandTimeoutMs: 200 });
      assert.equal(slow[0].error, 'timeout');
      assert.ok(Date.now() - t < 3000);
    } finally {
      await s.done();
    }
  });

  test('a budget transition sends one message per target, the most specific it subscribes to', async () => {
    const s = await setup();
    try {
      const config = defaults();
      config.notify.webhooks = [
        { url: `${s.server.url}/both`, events: ['budget-exceeded', 'gate'] },
        { url: `${s.server.url}/gate`, events: ['gate'] },
        { url: `${s.server.url}/other`, events: ['pr-opened'] },
        { url: `${s.server.url}/all` },
      ];
      await deliver(s.repo.dir, config, ['budget-exceeded', 'gate'], contextFor(s.repo.dir, s.job.id, 'budget'));
      const got = Object.fromEntries(s.server.hits.map((h) => [h.path, JSON.parse(h.body).event]));
      assert.deepEqual(got, { '/both': 'budget-exceeded', '/gate': 'gate', '/all': 'budget-exceeded' });
      assert.equal(s.server.hits.length, 3);
    } finally {
      await s.done();
    }
  });
  test('the repo notify log never follows a planted symlink', { skip: process.platform === 'win32' }, async () => {
    const s = await setup();
    try {
      const file = notifyLogFile(s.repo.dir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const target = path.join(s.repo.dir, 'outside.txt');
      fs.writeFileSync(target, 'untouched\n');
      fs.symlinkSync(target, file);
      const r = await deliver(s.repo.dir, s.config, ['daemon-stopped'], contextFor(s.repo.dir, null, 'trust'), fast);
      assert.equal(r[0].ok, true, 'delivery still succeeds');
      assert.equal(fs.readFileSync(target, 'utf8'), 'untouched\n', 'the link target is never appended to');
      assert.ok(fs.lstatSync(file).isSymbolicLink());
      // A regular file is appended to as before.
      fs.unlinkSync(file);
      await deliver(s.repo.dir, s.config, ['daemon-stopped'], contextFor(s.repo.dir, null, 'trust'), fast);
      await deliver(s.repo.dir, s.config, ['daemon-stopped'], contextFor(s.repo.dir, null, 'trust'), fast);
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual(lines.map((l) => [l.type, l.event, l.host]), Array(2).fill(['notified', 'daemon-stopped', `127.0.0.1:${s.server.port}`]));
    } finally {
      await s.done();
    }
  });
});
