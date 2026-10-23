import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ownDevProcess, parseDevProbe } from './dev-probe.ts';
import type { ProcessProbe } from './dev-probe.ts';

const LSTART = 'Tue Oct 20 18:18:47 2026';
const STARTED = Date.parse(LSTART);

test('parseDevProbe reads one ps row', () => {
  const rows: [string, string, { pgid: number; tty: boolean; started: number } | null][] = [
    ['a macOS row with no terminal', ` 4242 ??       ${LSTART}\n`, { pgid: 4242, tty: false, started: STARTED }],
    ['a Linux row with no terminal', `4242 ? ${LSTART}`, { pgid: 4242, tty: false, started: STARTED }],
    ['a macOS terminal', `4242 ttys002 ${LSTART}`, { pgid: 4242, tty: true, started: STARTED }],
    ['a Linux terminal', `4242 pts/3 ${LSTART}`, { pgid: 4242, tty: true, started: STARTED }],
    ['empty', '', null],
    ['a pid alone', '4242', null],
    ['a non-numeric pid', `abc ?? ${LSTART}`, null],
    ['a bad date', '4242 ?? Tue Oct 32 18:18:47 2026', null],
    ['trailing extra text', `4242 ?? ${LSTART} extra`, null],
    ['a 10k-character line', `4242 ?? ${'a'.repeat(10_000)}`, null],
    ['10k spaces between fields', `4242${' '.repeat(10_000)}??${' '.repeat(10_000)}x`, null],
  ];
  for (const [name, line, want] of rows) {
    const started = Date.now();
    assert.deepEqual(parseDevProbe(line), want, name);
    assert.ok(Date.now() - started < 100, `${name}: parses in linear time`);
  }
});

test('ownDevProcess proves a pid only through its probe', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dev-probe-')));
  try {
    const wt = path.join(dir, 'wt');
    fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'wt-other'));
    const pid = 4242;
    const rec = { pid, startedAt: new Date(STARTED).toISOString() };
    const fake = (o: Partial<ProcessProbe> = {}): ProcessProbe => ({
      platform: 'linux',
      row: () => ({ pgid: pid, tty: false, started: STARTED }),
      ownGroup: () => 99,
      cwd: () => wt,
      ...o,
    });
    const rows: [string, unknown, ProcessProbe, boolean][] = [
      ['a non-object rec', 'dev', fake(), false],
      ['a null rec', null, fake(), false],
      ['pid 1', { ...rec, pid: 1 }, fake({ row: () => ({ pgid: 1, tty: false, started: STARTED }) }), false],
      ['our own pid', { ...rec, pid: process.pid }, fake({ row: () => ({ pgid: process.pid, tty: false, started: STARTED }) }), false],
      ['a non-integer pid', { ...rec, pid: 4242.5 }, fake(), false],
      ['a pid as a string', { ...rec, pid: '4242' }, fake(), false],
      ['an unparseable startedAt', { ...rec, startedAt: 'yesterday' }, fake(), false],
      ['no startedAt', { pid }, fake(), false],
      ['win32', rec, fake({ platform: 'win32' }), false],
      ['no ps row', rec, fake({ row: () => null }), false],
      ['a pgid other than the pid', rec, fake({ row: () => ({ pgid: 7, tty: false, started: STARTED }) }), false],
      ['a controlling tty', rec, fake({ row: () => ({ pgid: pid, tty: true, started: STARTED }) }), false],
      ['our own group is the pid', rec, fake({ ownGroup: () => pid }), false],
      ['our own group unreadable', rec, fake({ ownGroup: () => null }), false],
      ['a start more than 30 s from startedAt', rec, fake({ row: () => ({ pgid: pid, tty: false, started: STARTED + 30_001 }) }), false],
      ['a start 30 s before startedAt', rec, fake({ row: () => ({ pgid: pid, tty: false, started: STARTED - 30_000 }) }), true],
      ['a null cwd', rec, fake({ cwd: () => null }), false],
      ['a cwd outside the worktree', rec, fake({ cwd: () => os.tmpdir() }), false],
      ['a sibling sharing its prefix', rec, fake({ cwd: () => path.join(dir, 'wt-other') }), false],
      ['a cwd equal to the worktree', rec, fake(), true],
      ['a cwd inside the worktree', rec, fake({ cwd: () => path.join(wt, 'sub') }), true],
    ];
    for (const [name, r, probe, want] of rows) assert.equal(ownDevProcess(wt, r, probe), want, name);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
