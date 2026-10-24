import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo } from '../../../test/helpers.ts';
import { dashboardRecordFile, isForgeDash, loopbackOrigin, provenDashboard } from './dashboard-record.ts';
import type { DashboardProbe } from './dashboard-record.ts';

const STARTED_AT = '2026-10-23T10:00:00.000Z';
const STARTED = Date.parse(STARTED_AT);
const BASE = { pid: 4242, url: 'http://127.0.0.1:7400', startedAt: STARTED_AT };
const posix = process.platform !== 'win32';

test('a dashboard record counts only when its file, process and url are proven', () => {
  const repo = tempRepo();
  try {
    const file = dashboardRecordFile(repo.dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const probe = (o: Partial<DashboardProbe> = {}): DashboardProbe => ({
      platform: 'linux',
      alive: () => true,
      startMs: () => STARTED,
      command: () => 'node /x/bin/forge dash --foreground',
      ...o,
    });
    const json = (v: unknown) => () => fs.writeFileSync(file, JSON.stringify(v));
    const proven = { pid: 4242, url: 'http://127.0.0.1:7400', startedAt: STARTED_AT };
    type Row = { name: string; plant: () => void; probe?: DashboardProbe; want: typeof proven | null; posixOnly?: boolean };
    const rows: Row[] = [
      { name: 'a proven record', plant: json(BASE), want: proven },
      { name: 'a trailing slash becomes the origin', plant: json({ ...BASE, url: 'http://127.0.0.1:7400/' }), want: proven },
      { name: 'the start 29 s off', plant: json(BASE), probe: probe({ startMs: () => STARTED + 29_000 }), want: proven },
      { name: 'npm run dev\'s command', plant: json(BASE), probe: probe({ command: () => 'node bin/forge dash --dev' }), want: proven },
      { name: 'no file', plant: () => fs.rmSync(file, { force: true }), want: null },
      { name: 'malformed JSON', plant: () => fs.writeFileSync(file, '{"pid": 4242,'), want: null },
      { name: 'a JSON array', plant: json([BASE]), want: null },
      { name: 'a 5 KiB file', plant: json({ ...BASE, pad: 'x'.repeat(5 * 1024) }), want: null },
      {
        name: 'a symlink to a valid record',
        posixOnly: true,
        plant: () => {
          const target = path.join(repo.dir, 'elsewhere.json');
          fs.writeFileSync(target, JSON.stringify(BASE));
          fs.symlinkSync(target, file);
        },
        want: null,
      },
      // A blocking open would hang this file rather than return a wrong value, so want null is the check.
      { name: 'a FIFO', posixOnly: true, plant: () => execFileSync('mkfifo', [file]), want: null },
      { name: 'pid missing', plant: json({ url: BASE.url, startedAt: STARTED_AT }), want: null },
      { name: 'pid 1', plant: json({ ...BASE, pid: 1 }), want: null },
      { name: 'pid 1.5', plant: json({ ...BASE, pid: 1.5 }), want: null },
      { name: 'pid as a string', plant: json({ ...BASE, pid: '123' }), want: null },
      { name: 'our own pid', plant: json({ ...BASE, pid: process.pid }), want: null },
      { name: 'a dead pid', plant: json(BASE), probe: probe({ alive: () => false }), want: null },
      { name: 'startedAt missing', plant: json({ pid: 4242, url: BASE.url }), want: null },
      { name: 'startedAt unparseable', plant: json({ ...BASE, startedAt: 'yesterday' }), want: null },
      { name: 'no start time', plant: json(BASE), probe: probe({ startMs: () => null }), want: null },
      { name: 'the start 31 s off', plant: json(BASE), probe: probe({ startMs: () => STARTED - 31_000 }), want: null },
      { name: 'no command line', plant: json(BASE), probe: probe({ command: () => null }), want: null },
      { name: 'node -e', plant: json(BASE), probe: probe({ command: () => 'node -e x' }), want: null },
      { name: 'another forge command', plant: json(BASE), probe: probe({ command: () => 'node /x/bin/forge daemon status' }), want: null },
      { name: 'forge-dash is not forge dash', plant: json(BASE), probe: probe({ command: () => 'node /x/forge-dash' }), want: null },
      { name: 'claude /forge dash', plant: json(BASE), probe: probe({ command: () => 'claude /forge dash' }), want: null },
      { name: 'win32', plant: json(BASE), probe: probe({ platform: 'win32' }), want: null },
      { name: 'a non-loopback url', plant: json({ ...BASE, url: 'http://evil.example/' }), want: null },
    ];
    for (const row of rows) {
      if (row.posixOnly && !posix) continue;
      fs.rmSync(file, { force: true });
      row.plant();
      assert.deepEqual(provenDashboard(repo.dir, row.probe ?? probe()), row.want, row.name);
    }
  } finally {
    repo.cleanup();
  }
});

test('isForgeDash accepts forge only in the script position', () => {
  const E = '/usr/local/bin/node';
  const F = '/plug/bin/forge';
  const rows: [string, boolean, { E?: string; F?: string }?][] = [
    ['node /x/bin/forge dash', true],
    ['/usr/local/bin/node /plug/bin/forge dash --foreground --port 7400 --quiet', true],
    ['node bin/forge dash --dev', true],
    ['/x/bin/forge dash', true],
    ['C:\\nodejs\\NODE.EXE C:\\x\\bin\\forge dash', true],
    ['C:\\Program Files\\nodejs\\node.exe C:\\x\\bin\\forge dash --foreground', true, { E: 'C:\\Program Files\\nodejs\\node.exe' }],
    ['/opt/my node/bin/node22 /x/bin/forge dash', true, { E: '/opt/my node/bin/node22' }],
    ['/usr/bin/node /Users/A B/forge/bin/forge dash --dev', true, { F: '/Users/A B/forge/bin/forge' }],
    ['  node /x/bin/forge dash  ', true],
    ['claude /forge dash', false],
    ['grep -rn forge dash .', false],
    ['node -e setInterval(()=>{},1e3) /x/bin/forge dash', false],
    ['node --inspect /x/bin/forge dash', false],
    ['vim /tmp/node /x/bin/forge dash', false],
    ['node /x/bin/forge dashboard', false],
    ['node /x/bin/forge daemon status', false],
    ['node /x/forge-dash', false],
    ['/usr/bin/node /Users/A B/forge/bin/forge dash', false],
    ['/usr/bin/nodejs /x/bin/forge dash', false],
    ['', false],
    // A hostile 10k-character line returns at once.
    [`node /plug/bin/forge${' '.repeat(10_000)}dashx`, false],
  ];
  for (const [command, want, o = {}] of rows) assert.equal(isForgeDash(command, o.E ?? E, o.F ?? F), want, JSON.stringify(command));
});

test('loopbackOrigin accepts only an http loopback origin with a port', () => {
  const rows: [unknown, string | null][] = [
    ['http://127.0.0.1:7400', 'http://127.0.0.1:7400'],
    ['http://localhost:7400', 'http://localhost:7400'],
    ['http://[::1]:7400', 'http://[::1]:7400'],
    ['http://127.0.0.1:7400/', 'http://127.0.0.1:7400'],
    ['http://evil.example/', null],
    ['https://127.0.0.1:7400', null],
    ['http://127.0.0.1', null],
    ['http://localhost.evil.example:7400', null],
    ['http://127.0.0.1:7400@evil.example/', null],
    ['http://u:p@127.0.0.1:7400', null],
    ['http://127.0.0.1:7400/x', null],
    ['http://127.0.0.1:7400/?a=1', null],
    ['http://127.0.0.1:7400/#h', null],
    ['', null],
    [7400, null],
    [null, null],
  ];
  for (const [url, want] of rows) assert.equal(loopbackOrigin(url), want, JSON.stringify(url));
});
