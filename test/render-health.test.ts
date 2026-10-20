// lib/commands/render/{doctor,config,sync}.ts: `forge doctor`, `forge config show|get|validate` and `forge sync` in human mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configGet, configShow, configValidate } from '../lib/commands/render/config.ts';
import { doctor } from '../lib/commands/render/doctor.ts';
import { sync } from '../lib/commands/render/sync.ts';
import { HOSTILE, assertSafe, plain } from './render-helpers.ts';

test('doctor: summary, then problems, warnings and ok, each in check order', () => {
  const checks = [
    { name: 'node >= 22.18', ok: true, detail: '22.18.0' },
    { name: 'remote "origin"', ok: false, detail: 'add one:\ngit remote add origin <url>' },
    { name: 'gh auth', ok: true, warn: true, detail: 'not logged in' },
    { name: 'config present', ok: true, detail: '' },
    { name: 'base branch "main"', ok: false, detail: '' },
  ];
  assert.equal(
    plain(doctor, { ok: false, checks }),
    [
      '2 problems · 1 warning · 2 ok',
      '',
      'Problems',
      '  ✗ remote "origin"',
      '    add one:',
      '    git remote add origin <url>',
      '  ✗ base branch "main"',
      '',
      'Warnings',
      '  ! gh auth',
      '    not logged in',
      '',
      'OK',
      '  ✓ node >= 22.18  22.18.0',
      '  ✓ config present',
    ].join('\n'),
  );
  assert.equal(plain(doctor, { ok: true, checks: [checks[0]] }), ['0 problems · 0 warnings · 1 ok', '', 'OK', '  ✓ node >= 22.18  22.18.0'].join('\n'));
  assert.equal(plain(doctor, { ok: false, checks: [checks[1]] })!.split('\n')[0], '1 problem · 0 warnings · 0 ok');
});

test('doctor: --bundle and other shapes fall back', () => {
  assert.equal(plain(doctor, { file: '/x.zip', bytes: 1, entries: [], skipped: [], redactions: {}, includeText: false, jobs: [] }), null);
  assert.equal(plain(doctor, { ok: true, checks: [{ nope: 1 }] }), null);
});

const CONFIG = {
  schemaVersion: 20,
  git: { base: 'main', branchPrefix: 'forge/' },
  worktrees: { root: '../x', cargo: { sharedTarget: false, targetDir: null }, copy: [] },
  verify: ['build', 'test'],
  review: { panel: [{ name: 'code', always: true }, { name: 'security', model: 'opus' }], blockOn: ['blocker'] },
  runtime: {},
};

const OUTLINE = [
  'schemaVersion  20',
  '',
  'git',
  '  base          main',
  '  branchPrefix  forge/',
  '',
  'worktrees',
  '  root  ../x',
  '  cargo',
  '    sharedTarget  false',
  '    targetDir     -',
  '  copy  -',
  '',
  'verify  build, test',
  '',
  'review',
  '  panel',
  '    - name    code',
  '      always  true',
  '    - name   security',
  '      model  opus',
  '  blockOn  blocker',
  '',
  'runtime  -',
].join('\n');

test('config show and config get: a nested outline', () => {
  assert.equal(plain(configShow, CONFIG), OUTLINE);
  assert.equal(plain(configGet, CONFIG.review), ['panel', '  - name    code', '    always  true', '  - name   security', '    model  opus', '', 'blockOn  blocker'].join('\n'));
  assert.equal(plain(configGet, { panel: [{ name: 'code' }, 'odd'] }), ['panel', '  - name  code', '  - odd'].join('\n'));
  assert.equal(plain(configGet, 42), null, 'a scalar falls back');
  assert.equal(plain(configGet, true), null);
});

test('config validate: valid, problems, not initialised', () => {
  assert.equal(plain(configValidate, { ok: true, initialized: true, problems: [] }), '✓ config is valid');
  assert.equal(plain(configValidate, { ok: false, initialized: true, problems: ['commands.test is empty', 'ports.base must be\na number'] }), ['✗ 2 problems', '  - commands.test is empty', '  - ports.base must be', '    a number'].join('\n'));
  assert.equal(plain(configValidate, { ok: false, initialized: true, problems: ['x'] }), '✗ 1 problem\n  - x');
  assert.equal(plain(configValidate, { ok: false, initialized: false, problems: ['x'] }), '✗ not initialised: run /forge init\n✗ 1 problem\n  - x');
  assert.equal(plain(configValidate, { ok: true, initialized: false, problems: [] }), '✗ not initialised: run /forge init');
});

test('sync: each result kind and retention', () => {
  const results = [
    { id: 'a', pr: 12, state: 'OPEN', merged: false },
    { id: 'b', error: 'gh failed\nretry later' },
    { id: 'c', retargeted: { from: 'forge/x', to: 'main', dependency: 'x' } },
    { id: 'd', unblocked: true },
    { id: 'e', umbrellaDone: true },
    { id: 'f', repoBudgetReleased: true },
    { id: 'g', pr: 3, state: 'OPEN', reopen: true },
    { id: 'h', pr: null, state: null },
  ];
  assert.equal(
    plain(sync, { synced: 8, results, requests: 2, integrating: ['a'], retention: { archived: ['old1', 'old2'], logs: ['l1', 'l2', 'l3'] } }),
    [
      'synced 8 job(s) · 2 request(s) queued · integrating: a',
      '',
      'Jobs',
      '  a  #12 OPEN → integrate',
      '  b  ✗ gh failed',
      '       retry later',
      '  c  retargeted forge/x → main',
      '  d  unblocked',
      '  e  all child jobs finished',
      '  f  repo budget hold released',
      '  g  #3 OPEN reopened',
      '  h  -',
      '',
      'Retention',
      '  archived: old1, old2',
      '  logs pruned: 3',
    ].join('\n'),
  );
  assert.equal(plain(sync, { synced: 0, results: [], requests: 0, integrating: [] }), 'synced 0 job(s) · 0 request(s) queued');
});

test('doctor, config and sync: sanitizes untrusted text', () => {
  assertSafe(plain(doctor, { ok: false, checks: [{ name: HOSTILE, ok: false, detail: HOSTILE }, { name: HOSTILE, ok: true, warn: true, detail: HOSTILE }, { name: HOSTILE, ok: true, detail: HOSTILE }] }));
  assertSafe(plain(configShow, { [HOSTILE]: { [HOSTILE]: HOSTILE, list: [HOSTILE], items: [{ [HOSTILE]: HOSTILE }] }, top: HOSTILE }));
  assertSafe(plain(configValidate, { ok: false, initialized: true, problems: [HOSTILE] }));
  assertSafe(plain(sync, { synced: 3, results: [{ id: HOSTILE, error: HOSTILE }, { id: 'r', retargeted: { from: HOSTILE, to: HOSTILE } }, { id: 'p', pr: 1, state: HOSTILE }], requests: 0, integrating: [HOSTILE], retention: { archived: [HOSTILE], logs: [] } }));
});
