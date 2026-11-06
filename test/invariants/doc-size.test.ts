// Agent-facing docs stay small enough to read in parts. Briefs tell agents to grep a reference doc and read
// only the part they need, which a 2,000-word paragraph defeats: one hit returns all of it. So no paragraph
// (each heading, table row and list item is its own) of the docs agents read holds over 250 words, and no
// architecture topic under docs/architecture/ holds over 6,000 words (about 8,000 tokens), past which it
// becomes a folder with a small index. Today's offenders are pinned in doc-size-allowlist.ts; a pin may
// shrink but never grow, and `npm run check:touchpoints` keeps the list from growing. It reads doc text
// (docs/TESTING.md › Allowed source-text tests, entry 11).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DOC_ALLOWED } from './doc-size-allowlist.ts';
import type { DocAllowance } from './doc-size-allowlist.ts';
import { ALLOWLIST_ENTRY, DOC_ALLOWLIST_FILE } from '../../scripts/check-touchpoints.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CAPS = { paragraph: 250, topic: 6000 };
const TOPICS = 'docs/architecture/';

const isMd = (f: string) => f.endsWith('.md');
const isAgents = (f: string) => f === 'AGENTS.md' || f.endsWith('/AGENTS.md');

/** The checked roots: a single file, or a folder and which of its root-relative paths count. */
const ROOTS: { root: string; pick?: (rel: string) => boolean }[] = [
  { root: 'AGENTS.md' },
  { root: 'dashboard/AGENTS.md' },
  { root: 'docs', pick: isMd },
  { root: 'skills/forge', pick: isMd },
  { root: 'agents', pick: (f) => isMd(f) && !f.includes('/') },
  { root: 'lib', pick: isAgents },
  { root: 'dashboard/src/lib', pick: isAgents },
  { root: 'dashboard/src/components', pick: isAgents },
];

/** Whitespace-separated tokens holding a letter or digit: table pipes, dashes, arrows and dots are not words. */
function words(text: string): number {
  return text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

const HEADING = /^\s*#{1,6}\s/;
const ROW = /^\s*\|/;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`+|~+)\s*$/;

/**
 * The units the paragraph cap counts, each with its 1-based start line: frontmatter and fenced code are
 * exempt, a blank line or a fence ends a unit, a heading or table row is a unit of its own, a list item
 * starts one that its continuation lines join, and any other line joins the current unit or starts one.
 */
function paragraphs(md: string): { line: number; words: number }[] {
  const lines = md.split('\n');
  const out: { line: number; words: number }[] = [];
  let cur: { line: number; words: number } | null = null;
  const end = () => {
    if (cur) out.push(cur);
    cur = null;
  };
  let i = 0;
  if (lines[0]?.trimEnd() === '---') {
    const close = lines.findIndex((l, j) => j > 0 && l.trimEnd() === '---');
    if (close > 0) i = close + 1;
  }
  let fence: { ch: string; len: number } | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const m = FENCE_CLOSE.exec(line);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      end();
      fence = { ch: open[1][0], len: open[1].length };
    } else if (!line.trim()) {
      end();
    } else if (HEADING.test(line) || ROW.test(line)) {
      end();
      out.push({ line: i + 1, words: words(line) });
    } else if (ITEM.test(line) || !cur) {
      end();
      cur = { line: i + 1, words: words(line) };
    } else {
      cur.words += words(line);
    }
  }
  end();
  return out;
}

/** Every checked doc, repo-relative with `/` separators, sorted, outside any node_modules or dist folder. */
function docFiles(): string[] {
  const out = new Set<string>();
  for (const { root, pick } of ROOTS) {
    const abs = path.join(REPO, root);
    if (!pick) {
      if (fs.existsSync(abs)) out.add(root);
      continue;
    }
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs, { recursive: true }) as string[]) {
      const rel = f.split(path.sep).join('/');
      if (rel.split('/').some((s) => s === 'node_modules' || s === 'dist') || !pick(rel)) continue;
      if (fs.statSync(path.join(abs, f)).isFile()) out.add(`${root}/${rel}`);
    }
  }
  return [...out].sort();
}

/** Over-cap paragraphs and topics off the list, growth past a pin, pins that now fit, and malformed or stale entries. */
function docProblems(texts: Map<string, string>, allowed: Record<string, DocAllowance>, caps = CAPS): string[] {
  const problems: string[] = [];
  for (const file of [...texts.keys()].sort()) {
    const text = texts.get(file) ?? '';
    const entry = Object.hasOwn(allowed, file) ? allowed[file] : undefined;
    const over = paragraphs(text).filter((p) => p.words > caps.paragraph);
    if (entry?.words === undefined) {
      for (const p of over) problems.push(`${file}:${p.line}: paragraph of ${p.words} words, over the ${caps.paragraph}-word cap: split it into shorter paragraphs or a list`);
    } else if (!over.length) {
      problems.push(`${file}: no paragraph over the ${caps.paragraph}-word cap: drop words from its entry`);
    } else {
      const sum = over.reduce((n, p) => n + p.words, 0);
      if (sum > entry.words) {
        const at = over.map((p) => p.line).join(', ');
        problems.push(`${file}: ${sum} words in paragraphs over the ${caps.paragraph}-word cap, over its pin of ${entry.words} (lines ${at}): split them rather than raise the pin`);
      }
    }
    if (file.startsWith(TOPICS)) {
      const n = words(text);
      if (entry?.topic === undefined) {
        if (n > caps.topic) problems.push(`${file}: ${n} words, over the ${caps.topic}-word topic cap: make it a folder with a small index`);
      } else if (n > entry.topic) {
        problems.push(`${file}: ${n} words, over its topic pin of ${entry.topic}: split it rather than raise the pin`);
      } else if (n <= caps.topic) {
        problems.push(`${file}: ${n} words, within the ${caps.topic}-word topic cap: drop topic from its entry`);
      }
    } else if (entry?.topic !== undefined) {
      problems.push(`${file}: topic pin outside ${TOPICS}: drop topic from its entry`);
    }
    if (entry && !entry.reason?.trim()) problems.push(`${file}: allowlisted without a reason: give one`);
    if (entry && entry.words === undefined && entry.topic === undefined) problems.push(`${file}: allowlisted with no pin: drop it from the list`);
  }
  for (const file of Object.keys(allowed).sort()) {
    if (!texts.has(file)) problems.push(`${file}: allowlisted but not found: drop it from the list`);
  }
  return problems;
}

test('agent-facing docs keep paragraphs under 250 words and topics under 6000 unless allowlisted', () => {
  const files = docFiles();
  for (const { root } of ROOTS) assert.ok(files.some((f) => f === root || f.startsWith(`${root}/`)), `found no checked doc under ${root}`);
  const texts = new Map(files.map((f) => [f, fs.readFileSync(path.join(REPO, f), 'utf8')]));
  const problems = docProblems(texts, DOC_ALLOWED);
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('paragraphs splits a doc into the units the cap counts', () => {
  assert.equal(words('| a | --- | → · - b1 — |'), 2);
  const md = [
    '---',
    'title: front matter words',
    '---',
    '# Heading words',
    'First para line',
    'continues here',
    '',
    '| a | b |',
    '|---|---|',
    '- item one',
    '  continued',
    '  - nested item',
    '1. numbered',
    '```js',
    'code words here',
    '````',
    'after fence',
    '~~~~',
    '~~~',
    'still code',
    '~~~~~ ',
    'tail - — → · word',
    '',
    '```',
    'unclosed code',
    '',
    'more code',
  ].join('\n');
  assert.deepEqual(paragraphs(md), [
    { line: 4, words: 2 },
    { line: 5, words: 5 },
    { line: 8, words: 2 },
    { line: 9, words: 0 },
    { line: 10, words: 3 },
    { line: 12, words: 2 },
    { line: 13, words: 2 },
    { line: 17, words: 2 },
    { line: 22, words: 2 },
  ]);
  // Frontmatter only on line 1; a heading ends a paragraph; every list marker starts an item.
  assert.deepEqual(paragraphs('a b\n---\nc\n## h\nd\n* star\n+ plus\n2) paren\nmore'), [
    { line: 1, words: 3 },
    { line: 4, words: 1 },
    { line: 5, words: 1 },
    { line: 6, words: 1 },
    { line: 7, words: 1 },
    { line: 8, words: 3 },
  ]);
});

test('the doc-size check reports over-cap docs, growth, fits and stale entries', () => {
  const para = (n: number) => Array(n).fill('w').join(' ');
  const topic = (n: number) => [...Array(Math.floor(n / 100)).fill(para(100)), para(n % 100)].join('\n\n');
  const texts = new Map([
    ['a/1.md', `${para(251)}\n\n${para(250)}\n`],
    ['a/2-held.md', para(260)],
    ['a/2.md', `${para(260)}\n\n${para(270)}`],
    ['a/3.md', para(10)],
    ['docs/architecture/4.md', topic(6001)],
    ['docs/architecture/5-held.md', topic(6600)],
    ['docs/architecture/5.md', topic(6600)],
    ['docs/architecture/6.md', topic(100)],
    ['docs/b7.md', para(10)],
    ['docs/c8.md', para(260)],
    ['docs/d9.md', para(10)],
  ]);
  const allowed: Record<string, DocAllowance> = {
    'a/2-held.md': { words: 300, reason: '#694: x' },
    'a/2.md': { words: 500, reason: '#694: x' },
    'a/3.md': { words: 300, reason: '#694: x' },
    'docs/architecture/5-held.md': { topic: 7000, reason: '#693: x' },
    'docs/architecture/5.md': { topic: 6500, reason: '#693: x' },
    'docs/architecture/6.md': { topic: 7000, reason: '#693: x' },
    'docs/b7.md': { topic: 7000, reason: '#694: x' },
    'docs/c8.md': { words: 300, reason: '' },
    'docs/d9.md': { reason: '#694: x' },
    'gone.md': { words: 300, reason: '#694: x' },
  };
  assert.deepEqual(docProblems(texts, allowed), [
    'a/1.md:1: paragraph of 251 words, over the 250-word cap: split it into shorter paragraphs or a list',
    'a/2.md: 530 words in paragraphs over the 250-word cap, over its pin of 500 (lines 1, 3): split them rather than raise the pin',
    'a/3.md: no paragraph over the 250-word cap: drop words from its entry',
    'docs/architecture/4.md: 6001 words, over the 6000-word topic cap: make it a folder with a small index',
    'docs/architecture/5.md: 6600 words, over its topic pin of 6500: split it rather than raise the pin',
    'docs/architecture/6.md: 100 words, within the 6000-word topic cap: drop topic from its entry',
    'docs/b7.md: topic pin outside docs/architecture/: drop topic from its entry',
    'docs/c8.md: allowlisted without a reason: give one',
    'docs/d9.md: allowlisted with no pin: drop it from the list',
    'gone.md: allowlisted but not found: drop it from the list',
  ]);
});

test('every allowlist entry is one line the touchpoints rule can read', () => {
  const lines = fs.readFileSync(path.join(REPO, DOC_ALLOWLIST_FILE), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('export const DOC_ALLOWED'));
  const close = lines.findIndex((l, i) => i > start && l === '};');
  assert.ok(start >= 0 && close > start, 'DOC_ALLOWED opens and closes on lines of its own');
  const seen = new Map<string, number>();
  for (const line of lines.slice(start + 1, close)) {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
    const m = ALLOWLIST_ENTRY.exec(line);
    assert.ok(m, `not an allowlist entry line: ${line}`);
    const [, file, w, tp, reason] = m;
    seen.set(file, (seen.get(file) ?? 0) + 1);
    const entry = DOC_ALLOWED[file];
    assert.ok(entry, `${file}: on a line but not in DOC_ALLOWED`);
    assert.deepEqual(
      { words: w === undefined ? undefined : Number(w), topic: tp === undefined ? undefined : Number(tp), reason: reason.replace(/\\(.)/g, '$1') },
      { words: entry.words, topic: entry.topic, reason: entry.reason },
      `${file}: the line and the object agree`,
    );
  }
  for (const file of Object.keys(DOC_ALLOWED)) assert.equal(seen.get(file), 1, `${file}: on exactly one entry line`);
  const keys = Object.keys(DOC_ALLOWED);
  assert.deepEqual(keys, [...keys].sort(), 'entries sorted by path');
});
