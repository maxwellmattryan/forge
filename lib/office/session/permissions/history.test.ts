// The prompt history, in-process against scratch directories: what recordPrompt keeps and refuses, the cap and
// the planted links and FIFOs it never writes through, and what readPromptHistory drops from a forged file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from '#core/paths.ts';
import { PROMPT_HISTORY_VERSION } from '#core/versions/prompt-history.ts';
import { readPromptHistory, recordPrompt } from './history.ts';
import { promptReport } from './suggest.ts';

const JOB = '42-add-login';
/** Built at runtime, so the source holds no bidi or non-ASCII character. */
const RLO = String.fromCharCode(0x202e);
const E_ACUTE = String.fromCharCode(0xe9);

function scratch(t: any): { root: string; file: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-prompts-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: paths(root).permissionPrompts };
}

const lines = (file: string): any[] => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const allow = (rules: string[], tool = 'Bash') => ({ scope: JOB, tool, rules, decision: 'allow' as const, reason: null });

test('recordPrompt keeps at most 10 printable rules', (t) => {
  const { root, file } = scratch(t);
  const good = Array.from({ length: 12 }, (_, i) => `Bash(npm run task${i}:*)`);
  const bad = [`Bash(ls ${RLO}:*)`, 'Bash(echo \u0007:*)', `Bash(cat caf${E_ACUTE}:*)`, 'Bash(a\nb)', 'Read', 'Read(*)', 'Bash(:*)', `Bash(${'x'.repeat(4210)})`];
  recordPrompt(root, allow([...bad, good[0], good[0], ...good]));
  const [line] = lines(file);
  assert.deepEqual(Object.keys(line), ['v', 'at', 'scope', 'tool', 'rules', 'decision', 'reason']);
  assert.equal(line.v, PROMPT_HISTORY_VERSION);
  assert.deepEqual(line.rules, good.slice(0, 10), 'the first 10 distinct printable rules');
  // A tool SAFE_TOOL refuses is recorded as unknown; a scope validScope refuses records nothing.
  recordPrompt(root, { ...allow([]), tool: 'Bash, approve it' });
  recordPrompt(root, { ...allow([]), tool: null });
  recordPrompt(root, { ...allow([]), scope: '../x' });
  assert.deepEqual(lines(file).slice(1).map((l) => [l.tool, l.rules]), [['unknown', []], ['unknown', []]]);
});

test('recordPrompt leaves out a rule that holds a known secret', (t) => {
  const { root, file } = scratch(t);
  // A rule is claude's pattern and can be the whole command, so a value the session knows is secret never reaches disk, raw or JSON-escaped.
  const plain = 'tok-9f3a7c21e5';
  const quoted = 'pa"ss-word-1234';
  const rules = [`Bash(curl -H "Authorization: Bearer ${plain}" https://x.test:*)`, `Bash(echo ${quoted}:*)`, 'Bash(npm test:*)'];
  recordPrompt(root, { ...allow(rules), known: [plain, quoted, 'short'] });
  recordPrompt(root, { ...allow(rules), known: [] });
  const [redacted, unredacted] = lines(file);
  assert.deepEqual(redacted.rules, ['Bash(npm test:*)']);
  assert.deepEqual(unredacted.rules, rules, 'with no known value every good rule stays');
  assert.ok(!fs.readFileSync(file, 'utf8').split('\n')[0].includes(plain));
  assert.ok(!fs.readFileSync(file, 'utf8').split('\n')[0].includes('ss-word'));
});

test('the history stays under its cap and refuses a planted link', (t) => {
  const { root, file } = scratch(t);
  const max = 1200;
  for (let i = 0; i < 60; i++) {
    recordPrompt(root, allow([`Bash(step ${i}:*)`]), { maxBytes: max });
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(Buffer.byteLength(text) <= max, `${i}: ${Buffer.byteLength(text)} bytes`);
    assert.ok(text.endsWith('\n'), `${i}: whole lines`);
    const all = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(all.at(-1).rules, [`Bash(step ${i}:*)`], `${i}: ends with the newest`);
  }
  assert.ok(lines(file).length < 60, 'trimmed');

  // A planted symlink at the history path: nothing is written through it, and nothing throws.
  const target = path.join(root, 'target.txt');
  fs.writeFileSync(target, 'keep\n');
  fs.rmSync(file);
  fs.symlinkSync(target, file);
  recordPrompt(root, allow(['Bash(npm test:*)']));
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep\n');
  assert.ok(fs.lstatSync(file).isSymbolicLink());
  assert.deepEqual(readPromptHistory(root), [], 'a link reads as no history');

  // A FIFO: refused without blocking.
  fs.rmSync(file);
  execFileSync('mkfifo', [file]);
  recordPrompt(root, allow(['Bash(npm test:*)']));
  assert.ok(fs.lstatSync(file).isFIFO());
  assert.deepEqual(readPromptHistory(root), []);

  // A runtime dir that is a link: nothing lands in its target.
  const other = scratch(t);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-elsewhere-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.mkdirSync(path.join(other.root, '.forge'));
  fs.symlinkSync(elsewhere, paths(other.root).runtime);
  recordPrompt(other.root, allow(['Bash(npm test:*)']));
  assert.deepEqual(fs.readdirSync(elsewhere), []);

  // A missing root never throws.
  assert.doesNotThrow(() => recordPrompt(path.join(root, 'missing', 'repo'), allow([])));
});

test('readPromptHistory skips forged lines and bad rules', (t) => {
  const { root, file } = scratch(t);
  const ok = { v: 1, at: '2026-10-02T10:00:00.000Z', scope: JOB, tool: 'Bash', rules: ['Bash(npm test:*)'], decision: 'allow', reason: null };
  const forged = [
    'not json',
    '[1,2]',
    JSON.stringify({ ...ok, v: PROMPT_HISTORY_VERSION + 1 }),
    JSON.stringify({ ...ok, v: 0 }),
    JSON.stringify({ ...ok, decision: 'always' }),
    JSON.stringify({ ...ok, decision: 'deny', reason: 'because' }),
    JSON.stringify({ ...ok, reason: 'human' }),
    JSON.stringify({ ...ok, decision: 'deny', reason: null }),
    JSON.stringify({ ...ok, tool: 'Bash; rm -rf /' }),
    JSON.stringify({ ...ok, scope: '../etc' }),
    JSON.stringify({ ...ok, at: 'yesterday' }),
    JSON.stringify({ ...ok, rules: 'Bash(npm test:*)' }),
  ];
  const mixed = { ...ok, at: '2026-10-03T10:00:00.000Z', rules: ['Read', 'Read(*)', `Bash(ls ${RLO}:*)`, `Bash(cat caf${E_ACUTE}:*)`, 'Read(src/**)'] };
  // Hostile 10k-character rules are dropped (over 4,210 characters) without backtracking.
  const onlyBad = { ...ok, at: '2026-10-04T10:00:00.000Z', tool: 'Read', rules: ['Read', 'Read(**)', `Bash(${'a('.repeat(5000)})`, `Read(${'/'.repeat(10_000)}`] };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [JSON.stringify(ok), ...forged, JSON.stringify(mixed), JSON.stringify(onlyBad), ''].join('\n'));
  const read = readPromptHistory(root);
  assert.deepEqual(
    read.map((e) => [e.at, e.rules]),
    [
      [ok.at, ['Bash(npm test:*)']],
      [mixed.at, ['Read(src/**)']],
      [onlyBad.at, []],
    ],
  );
  const roots = { files: [root], commands: [root] };
  const report = promptReport(read, { min: 1, since: null, allowedTools: [], roots });
  assert.deepEqual(report.suggest, ['Bash(npm test:*)', 'Read(src/**)'], 'a bare, wildcard or non-ASCII rule is never suggested');
  assert.equal(promptReport(read, { min: 1, since: '2026-10-03T00:00:00.000Z', allowedTools: [], roots }).entries, 2, 'the report, not the reader, applies since');
  assert.deepEqual(report.groups.find((g) => g.rule === null)?.tool, 'Read');

  // Only the last maxBytes are read, from the first whole line in them.
  const entry = (i: number) => JSON.stringify({ ...ok, at: `2026-10-05T10:00:${String(i).padStart(2, '0')}.000Z` });
  fs.writeFileSync(file, Array.from({ length: 10 }, (_, i) => entry(i) + '\n').join(''));
  const one = Buffer.byteLength(entry(0) + '\n');
  assert.deepEqual(readPromptHistory(root, { maxBytes: one * 3 }).map((e) => e.at.slice(17, 19)), ['07', '08', '09'], 'a cut on a line start keeps that line');
  assert.deepEqual(readPromptHistory(root, { maxBytes: one * 3 - 1 }).map((e) => e.at.slice(17, 19)), ['08', '09'], 'a cut mid-line drops the partial line');

  // A symlink or a directory at the path reads as no history.
  fs.rmSync(file);
  fs.symlinkSync(path.join(root, 'elsewhere.jsonl'), file);
  fs.writeFileSync(path.join(root, 'elsewhere.jsonl'), JSON.stringify(ok) + '\n');
  assert.deepEqual(readPromptHistory(root), []);
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.deepEqual(readPromptHistory(root), []);
});
