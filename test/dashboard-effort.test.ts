// dashboard/src/lib/effort.ts: the effort chip, the restart note and POST /api/jobs/:id/effort, and the
// precedence it mirrors from lib/config.ts resolveEffort, checked against the same table.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tags } from './svelte-markup.ts';
import { EFFORT_CASES } from './effort-cases.ts';
import { effectiveEffort, effortChip, effortTone, postJobEffort, restartPending } from '../dashboard/src/lib/effort.ts';
import { defaults, resolveEffort } from '../lib/config.ts';

test("effectiveEffort matches the engine's precedence", () => {
  for (const c of EFFORT_CASES) {
    const config = defaults();
    (config.runtime as any).effort = c.config;
    const label = `job ${JSON.stringify(c.job)} / config ${JSON.stringify(c.config)}`;
    assert.equal(effectiveEffort(c.job, c.config), c.level, label);
    assert.equal(effectiveEffort(c.job, c.config), resolveEffort(config, { effort: c.job }).level, `${label}: same as the engine`);
  }
});

test('effortChip shows a job only when it differs from the default', () => {
  assert.equal(effortChip('high', 'medium'), 'high');
  assert.equal(effortChip('xhigh', null), 'xhigh');
  assert.equal(effortChip('medium', 'medium'), null, 'the same as the default');
  assert.equal(effortChip(null, 'high'), null, 'an inheriting job adds no chip');
  assert.equal(effortChip(undefined, null), null);
  assert.equal(effortChip('ultra', null), null, 'a value outside the levels shows nothing');
  assert.equal(effortChip('low', 'ultra'), 'low', 'an invalid default counts as none');
});

test('effortTone warns for xhigh and max only', () => {
  assert.deepEqual((['low', 'medium', 'high', 'xhigh', 'max'] as const).map(effortTone), ['muted', 'muted', 'muted', 'warn', 'warn']);
});

test('restartPending only while a running session started at another level', () => {
  const running = (effort: string | null) => ({ running: true, effort }) as any;
  assert.equal(restartPending(running('high'), 'low', null), true, 'the job changed since the spawn');
  assert.equal(restartPending(running('high'), 'high', 'medium'), false);
  assert.equal(restartPending(running('medium'), null, 'medium'), false, 'inherits what it started with');
  assert.equal(restartPending(running('medium'), null, 'high'), true, 'the default changed');
  assert.equal(restartPending(running(null), null, null), false, 'nothing passed, nothing set');
  assert.equal(restartPending(running(null), 'max', null), true);
  assert.equal(restartPending({ running: true } as any, null, null), false, 'an older server without the field reads as none');
  assert.equal(restartPending({ running: false, effort: null } as any, 'max', null), false, 'no child: the next spawn uses the new level anyway');
  assert.equal(restartPending(null, 'max', null), false);
  assert.equal(restartPending(undefined, 'max', null), false);
});

test('EffortSelect is a button Select that keeps focus while saving', () => {
  const text = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'src', 'components', 'EffortSelect.svelte'), 'utf8');
  const [sel, ...rest] = tags('EffortSelect.svelte', text).filter((x) => x.name === 'Select');
  assert.ok(sel && rest.length === 0, 'one Select');
  const attr = (name: string) => sel.attrs.find((a) => a.name === name)?.value?.replace(/^(["'])([\s\S]*)\1$/, '$2');
  assert.deepEqual(
    { variant: attr('variant'), icon: attr('icon'), align: attr('align'), label: attr('label'), value: attr('value'), text: attr('text'), badge: attr('badge'), entry: attr('entry'), onchange: attr('onchange') },
    { variant: 'button', icon: 'gauge', align: 'end', label: "{$t('effort.label')}", value: '{current}', text: '{levelName}', badge: '{restart}', entry: '{level}', onchange: '{choose}' },
  );
  assert.equal(attr('title'), "{restart ? `${$t('effort.hint')} ${$t('effort.restart')}` : $t('effort.hint')}", 'the hint, and the restart note while it applies');
  assert.ok(!sel.attrs.some((a) => a.name === 'disabled'), 'the trigger is never disabled, so focus never drops to <body>');
  // Saving disables every entry instead: Inherit and each level.
  assert.match(text, /icon: 'settings', disabled: pending \}/);
  assert.match(text, /\.\.\.EFFORTS\.map\(\(e\) => \(\{ value: e, label: name\[e\], separator: e === EFFORTS\[0\], disabled: pending \}\)\)/, 'a separator before the levels');
  // The level snippet: the name and, for the costly levels, a decorative warn dot.
  assert.ok(text.includes(`{#if lv && effortTone(lv) === 'warn'}<span class="dot warn ml-auto mt-1.5" aria-hidden="true"></span>{/if}`));
  // choose keeps the picked level shown while it saves, toasts and reverts on a failure, and parks no focus.
  const choose = text.slice(text.indexOf('async function choose('), text.indexOf('\n  }\n', text.indexOf('async function choose(')));
  assert.match(choose, /picked = value;\s*pending = true;[\s\S]*toast\(\$t\('effort\.failed'[\s\S]*finally \{\s*picked = null;\s*pending = false;\s*\}$/);
  assert.doesNotMatch(text, /parkFocus|tick\(/);
});

test('postJobEffort posts the level with the token and throws the server error', async () => {
  const calls: any[] = [];
  const reply = (status: number, body: string, statusText = ''): any => async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, statusText, text: async () => body };
  };
  const ok = { id: 'job-a', effort: 'high', previous: null, changed: true };
  assert.deepEqual(await postJobEffort('job-a', 'high', 'tok', reply(200, JSON.stringify(ok))), ok);
  const { url, init } = calls[0];
  assert.equal(url, '/api/jobs/job-a/effort');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers['x-forge-token'], 'tok');
  assert.deepEqual(JSON.parse(init.body), { effort: 'high' });
  await postJobEffort('job-a', null, 'tok', reply(200, '{}'));
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { effort: null }, 'null inherits');
  await postJobEffort('a/../b?x#y', 'low', 'tok', reply(200, '{}'));
  assert.equal(calls.at(-1).url, '/api/jobs/a%2F..%2Fb%3Fx%23y/effort', 'the id is encoded as one path segment');
  await assert.rejects(postJobEffort('job-a', 'high', 't', reply(400, JSON.stringify({ error: 'effort must be one of low, medium, high, xhigh, max, or null' }))), { message: 'effort must be one of low, medium, high, xhigh, max, or null' });
  await assert.rejects(postJobEffort('job-a', 'high', 't', reply(403, 'bad token')), { message: 'bad token' });
  await assert.rejects(postJobEffort('job-a', 'high', 't', reply(500, '', 'Internal Server Error')), { message: 'Internal Server Error' });
});
