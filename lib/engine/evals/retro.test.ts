import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import { createJob, jobDir, logHumanEvent, updateJob } from '#core/job/store.ts';
import { jobFindings } from '../pipeline/findings.ts';
import { lastRetro, prepareRetro, retroDue } from './retro.ts';

const HEADING = '## Recurring findings across jobs';

/** C0 and C1 controls, U+2028/2029 and backticks: what safeText strips. */
const unsafe = (s: string): string[] =>
  [...s].filter((ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || ch === '`';
  });

test('retro signals list findings that recur across jobs', () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const config = defaults();
    const review = (id: string, round: number, lens: string, lines: string[]): string => {
      const dir = path.join(jobDir(root, id), 'review', `round-${round}`);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${lens}.md`);
      fs.writeFileSync(file, `VERDICT: CHANGES\n\n${lines.join('\n')}\n`);
      return file;
    };
    const signals = (): string => {
      const retro = createJob(root, config, { title: 'Retro', kind: 'retro' });
      return fs.readFileSync(prepareRetro(root, config, retro.id, { since: '1970-01-01', today: '2026-10-23' }).signals, 'utf8');
    };
    const section = (text: string): string[] => {
      const lines = text.split('\n');
      const start = lines.indexOf(HEADING);
      return start < 0 ? [] : lines.slice(start + 1, lines.indexOf('', start));
    };

    const controls = String.fromCharCode(0x0, 0x7, 0x85, 0x2028);
    const hostile = `- [major] lib/h.ts:1 — hostile header width ${controls} \`code\` ## Heading ${'x'.repeat(300)}`;
    const a = createJob(root, config, { title: 'Job A' }).id;
    const b = createJob(root, config, { title: 'Job B' }).id;
    const evalJob = createJob(root, config, { title: 'Eval', kind: 'eval' }).id;
    const aFile = review(a, 1, 'code', [hostile, '- [minor] lib/x.ts:3 — only one job sees this finding']);
    review(a, 2, 'code', ['- [major] lib/h.ts:1 — carried over again']);
    review(evalJob, 1, 'code', ['- [minor] lib/x.ts:3 — only one job sees this finding']);

    // An eval job carrying the same finding is not counted, and one job alone is no group.
    assert.ok(!signals().includes(HEADING), 'no cross-job group, no heading');
    assert.deepEqual(jobFindings(root, a).totals, { raised: 3, fixed: 0, disputed: 0, recurring: 1 });

    review(b, 1, 'code', [hostile]);
    // A review file linked to another job's is never read.
    const c = createJob(root, config, { title: 'Job C' }).id;
    fs.mkdirSync(path.join(jobDir(root, c), 'review', 'round-1'), { recursive: true });
    fs.symlinkSync(aFile, path.join(jobDir(root, c), 'review', 'round-1', 'code.md'));

    const many = Array.from({ length: 12 }, (_, i) => createJob(root, config, { title: `Many ${i}` }).id);
    for (const id of many) review(id, 1, 'docs', ['- [nit] docs/A.md:1 — the glossary term is missing']);

    const text = signals();
    const lines = section(text);
    assert.equal(lines.length, 2);
    const sorted = [...many].sort();
    assert.deepEqual(lines[0].split(' · ').slice(0, 4), ['- docs', 'glossary term missing', '12 jobs, 12 findings', `${sorted.slice(0, 10).join(', ')} +2 more`]);
    const line = lines[1];
    const ab = [a, b].sort().join(', ');
    assert.ok(line.startsWith(`- code · hostile header width heading · 2 jobs, 2 findings · ${ab} · e.g. lib/h.ts:1 — hostile header width `), line);
    assert.deepEqual(unsafe(line), [], 'no control, line separator or backtick');
    assert.ok(line.slice(line.indexOf(' · e.g. ') + ' · e.g. '.length).length <= 200);

    const all = text.split('\n');
    const at = all.indexOf(HEADING);
    const firstJob = all.findIndex((l) => /^## [a-z0-9]/.test(l));
    assert.ok(firstJob > at, 'before the first per-job section');
    assert.ok(all.indexOf('## Per-lens recall') < at, 'after per-lens recall when present');
  } finally {
    repo.cleanup();
  }
});

test("a mandate's retro reads only its jobs, keeps its scope and leaves the cadence alone", () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const config = defaults();
    const today = '2026-10-23';
    const read = (file: string) => fs.readFileSync(file, 'utf8');
    const cadence = createJob(root, config, { title: 'Retro', kind: 'retro' }).id;
    // Older than everything else, so a mandate retro created later would be the newest retro.
    updateJob(root, cadence, (j) => void (j.createdAt = '2026-01-01T00:00:00.000Z'));
    const mine = [createJob(root, config, { title: 'A', mandate: 'm1' }).id, createJob(root, config, { title: 'B', mandate: 'm1' }).id];
    const other = createJob(root, config, { title: 'Other' }).id;
    for (const id of [...mine, other]) logHumanEvent(root, id, 'human', { action: 'rework', note: `redo ${id}` }, { login: 'alice', source: 'gh' });
    const retro = createJob(root, config, { title: 'Forge retro: mandate m1', kind: 'retro' }).id;

    const out = prepareRetro(root, config, retro, { mandate: 'm1', today });
    const text = read(out.signals);
    assert.ok(text.startsWith('# Signals for mandate m1\n'), text);
    assert.ok(text.includes('\n2 job(s) in mandate m1.\n'), text);
    for (const id of mine) assert.ok(text.includes(`## ${id} (`), `${id} has its section`);
    assert.ok(!text.includes(other), 'no job outside the mandate');
    assert.deepEqual([JSON.parse(read(out.stats)).counts.total, out.mandate, out.since], [2, 'm1', null]);

    const again = prepareRetro(root, config, retro, { today });
    assert.deepEqual([again.mandate, again.since, read(again.signals).split('\n')[0]], ['m1', null, '# Signals for mandate m1'], 'a later prepare keeps the scope');
    const usage = (re: RegExp) => (e: unknown) => e instanceof ForgeError && e.code === 'usage' && re.test(e.message);
    assert.throws(() => prepareRetro(root, config, retro, { mandate: 'm2', today }), usage(/scoped to mandate m1/));
    assert.throws(() => prepareRetro(root, config, other, { mandate: 'm1', today }), usage(/is a \S+ job/));

    assert.equal(lastRetro(root)?.id, cadence, 'the mandate retro is not the last retro');
    assert.equal(retroDue(root, config).lastRetro, cadence);
  } finally {
    repo.cleanup();
  }
});
