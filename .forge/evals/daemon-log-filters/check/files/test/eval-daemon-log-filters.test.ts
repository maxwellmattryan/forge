// Hidden check for the `daemon-log-filters` eval task: `forge daemon log` --since and --grep.
// It fabricates session logs the way the daemon writes them: `.forge/runtime/daemons/<scope>.log`,
// one JSON object per line, timed by `at` (Forge's own lines) or `timestamp` (claude's).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scratch } from './eval-check-harness.ts';

const repo = scratch();
after(() => repo.cleanup());
const daemons = path.join(repo.dir, '.forge', 'runtime', 'daemons');
fs.mkdirSync(daemons, { recursive: true });

function writeLog(scope: string, lines: string[]): void {
  fs.writeFileSync(path.join(daemons, `${scope}.log`), lines.map((l) => l + '\n').join(''));
}

async function log(args: string[]): Promise<string[]> {
  const r = await repo.forge(['daemon', 'log', ...args]);
  assert.equal(r.status, 0, `forge daemon log ${args.join(' ')} exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const out = r.stdout.trim();
  return out ? out.split('\n') : [];
}

const tag = (line: string): string => JSON.parse(line).tag;

const JOB = '12-log-job';
// Absolute times, oldest first, as a session appends them.
writeLog(JOB, [
  JSON.stringify({ type: 'forge-daemon', at: '2026-10-01T10:00:00.000Z', event: 'spawn', tag: 'a' }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-10-01T10:05:00.000Z', message: 'Running the BUILD now', tag: 'b' }),
  JSON.stringify({ type: 'forge-stderr', at: '2026-10-01T10:10:00.000Z', text: 'build failed: exit 1', tag: 'c' }),
  JSON.stringify({ type: 'progress', tag: 'd', note: 'no time of its own' }),
  JSON.stringify({ type: 'forge-raw', at: '2026-10-01T10:20:00.000Z', text: 'rebuild ok', tag: 'e' }),
  JSON.stringify({ type: 'user', timestamp: '2026-10-01T10:30:00.000Z', message: 'tests pass', tag: 'f' }),
]);
const UNTIMED = 'u-job';
writeLog(UNTIMED, [
  JSON.stringify({ type: 'system', tag: 'head', note: 'before any timed line' }),
  JSON.stringify({ type: 'forge-daemon', at: '2026-10-01T09:00:00.000Z', event: 'spawn', tag: 'old' }),
  JSON.stringify({ type: 'system', tag: 'after-old' }),
  JSON.stringify({ type: 'forge-daemon', at: '2026-10-01T12:00:00.000Z', event: 'turn', tag: 'new' }),
  JSON.stringify({ type: 'system', tag: 'after-new' }),
]);

describe('forge daemon log --since / --grep', { concurrency: 4 }, () => {
  test('--grep keeps lines containing the text, ignoring case', async () => {
    assert.deepEqual((await log([JOB, '--grep', 'build'])).map(tag), ['b', 'c', 'e']);
    assert.deepEqual((await log([JOB, '--grep', 'REBUILD'])).map(tag), ['e']);
    assert.deepEqual(await log([JOB, '--grep', 'nothing-matches-this']), [], 'no match prints nothing and exits 0');
  });

  test('--lines counts lines after filtering', async () => {
    assert.deepEqual((await log([JOB, '--grep', 'build', '--lines', '1'])).map(tag), ['e']);
    assert.deepEqual((await log([JOB, '--grep', 'forge-', '--lines', '2'])).map(tag), ['c', 'e']);
    assert.deepEqual((await log([JOB, '--since', '2026-10-01T10:05:00Z', '--lines', '2'])).map(tag), ['e', 'f']);
  });

  test('--since with an ISO timestamp reads `at` and `timestamp`, from that instant on', async () => {
    assert.deepEqual((await log([JOB, '--since', '2026-10-01T10:05:00Z'])).map(tag), ['b', 'c', 'd', 'e', 'f'], 'inclusive');
    assert.deepEqual((await log([JOB, '--since', '2026-10-01T10:05:00.001Z'])).map(tag), ['c', 'd', 'e', 'f']);
    assert.deepEqual((await log([JOB, '--since', '2026-10-01T12:20:00+02:00'])).map(tag), ['e', 'f'], 'the zone is honoured');
    assert.deepEqual(await log([JOB, '--since', '2026-10-02T00:00:00Z']), []);
  });

  test('a line without a time goes with the timed line before it', async () => {
    assert.deepEqual((await log([JOB, '--since', '2026-10-01T10:10:00Z'])).map(tag), ['c', 'd', 'e', 'f']);
    assert.deepEqual((await log([JOB, '--since', '2026-10-01T10:15:00Z'])).map(tag), ['e', 'f']);
    assert.deepEqual((await log([UNTIMED, '--since', '2026-10-01T11:00:00Z'])).map(tag), ['new', 'after-new']);
    assert.deepEqual((await log([UNTIMED, '--since', '2026-10-01T08:00:00Z'])).map(tag), ['old', 'after-old', 'new', 'after-new'], 'lines before any timed line are dropped');
    assert.deepEqual((await log([UNTIMED])).map(tag), ['head', 'old', 'after-old', 'new', 'after-new'], 'without --since nothing is dropped');
  });

  test('--since with a duration counts back from now, for the inbox and the office too', async () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const lines = [
      JSON.stringify({ type: 'forge-daemon', at: ago(3 * 3600_000), event: 'spawn', tag: 'h3' }),
      JSON.stringify({ type: 'assistant', timestamp: ago(30 * 60_000), message: 'half an hour ago', tag: 'm30' }),
      JSON.stringify({ type: 'forge-daemon', at: ago(5 * 60_000), event: 'turn', tag: 'm5' }),
      JSON.stringify({ type: 'forge-daemon', at: ago(5_000), event: 'turn', tag: 's5' }),
    ];
    writeLog('_inbox', lines);
    writeLog('_office', lines);
    assert.deepEqual((await log(['--inbox', '--since', '2h'])).map(tag), ['m30', 'm5', 's5']);
    assert.deepEqual((await log(['--inbox', '--since', '10m'])).map(tag), ['m5', 's5']);
    assert.deepEqual((await log(['--office', '--since', '120s'])).map(tag), ['s5']);
    assert.deepEqual((await log(['--office', '--since', '1h', '--grep', 'TURN'])).map(tag), ['m5', 's5'], 'the filters combine');
    assert.deepEqual((await log(['--office', '--since', '1h', '--grep', 'turn', '--lines', '1'])).map(tag), ['s5']);
  });

  test('an invalid --since or a --grep without text is a usage error', async () => {
    const bads = [['--since', 'yesterday'], ['--since', '10x'], ['--since', '-5m'], ['--since', '2026-13-45T99:00:00Z'], ['--since'], ['--grep']];
    const runs = await Promise.all(bads.map((bad) => repo.forge(['daemon', 'log', JOB, ...bad])));
    bads.forEach((bad, i) => {
      const r = runs[i];
      assert.equal(r.status, 2, `${bad.join(' ')}: exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.equal(r.stdout.trim(), '', `${bad.join(' ')} prints no log lines`);
    });
    const j = await repo.forge(['daemon', 'log', JOB, '--since', 'yesterday', '--json']);
    assert.equal(j.status, 2);
    assert.equal(JSON.parse(j.stdout.trim().split('\n').pop()!).error.code, 'usage', '--json names the usage code');
  });
});
