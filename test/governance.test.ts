// Keeps the repository governance files correct as paths, headings and the AGENTS.md verify list
// change. Reads files only: no git and no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '../lib/yaml.ts';
import { findAttribution } from '../lib/attribution.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const GOVERNANCE = ['SECURITY.md', '.github/CODEOWNERS', '.github/dependabot.yml'];
const OWNER = '@maxwellmattryan';
const ADVISORY_URL = 'https://github.com/maxwellmattryan/forge/security/advisories/new';
const CODEOWNED = [
  '/.forge/config.yml',
  '/.forge/trackers/**',
  '/lib/server.ts',
  '/lib/daemon.ts',
  '/lib/daemon-pool.ts',
  '/hooks/**',
  '/lib/attribution.ts',
  '/lib/config-fields.ts',
  '/.github/**',
  '/lib/schema.ts',
];

/** Line count, not counting one trailing newline as a line. */
function lines(text: string): number {
  return text ? text.replace(/\n$/, '').split('\n').length : 0;
}

/** The lines outside fenced code blocks. */
function prose(md: string): string[] {
  const out: string[] = [];
  let fence = '';
  for (const line of md.split('\n')) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (m && (!fence || m[1][0] === fence)) {
      fence = fence ? '' : m[1][0];
      continue;
    }
    if (!fence) out.push(line);
  }
  return out;
}

/** The text of every ATX heading outside fenced code. */
function headings(md: string): string[] {
  return prose(md).flatMap((l) => {
    const m = l.match(/^#{1,6}[ \t]+(\S.*)$/);
    return m ? [m[1].trim()] : [];
  });
}

/** GitHub's heading anchor: lowercase, keep letters, digits, spaces, `-` and `_`, spaces to `-`. */
function slug(heading: string): string {
  return heading.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
}

/** Every anchor a file's headings produce, with GitHub's `-1`, `-2` suffixes for repeats. */
function anchors(md: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const h of headings(md)) {
    const s = slug(h);
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    out.add(n ? `${s}-${n}` : s);
  }
  return out;
}

/** Inline link and image targets outside fenced code and code spans, without any title. */
function links(md: string): string[] {
  return prose(md).flatMap((l) => [...l.replace(/`[^`]*`/g, '').matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)/g)].map((m) => m[1]));
}

/** The lines under `## <title>`, up to the next heading of level 1 or 2. */
function section(md: string, title: string): string {
  const all = md.split('\n');
  const start = all.indexOf(`## ${title}`);
  assert.ok(start >= 0, `missing "## ${title}"`);
  const end = all.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  return all.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

test('governance files exist and stay under 120 lines', () => {
  for (const rel of GOVERNANCE) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} exists`);
    assert.ok(lines(read(rel)) < 120, `${rel} has ${lines(read(rel))} lines`);
  }
  assert.equal(lines('a\nb\n'), 2, 'a trailing newline is not a line');
  assert.equal(lines('a\nb'), 2);
});

test('SECURITY.md names the private channel, windows, supported versions and threat-model sections', () => {
  const sec = read('SECURITY.md');
  assert.deepEqual(
    prose(sec).filter((l) => l.startsWith('## ')),
    ['## Reporting a vulnerability', '## What to expect', '## Supported versions', '## Threat model', '## Configuration is code'],
  );

  const reporting = section(sec, 'Reporting a vulnerability');
  assert.match(reporting, /GitHub private vulnerability reporting/);
  assert.ok(links(reporting).includes(ADVISORY_URL), 'links the private advisory form');
  assert.match(reporting, /\b(do not|don't|never)\b[^.]*\bpublic issue/i, 'says not to use public issues');
  assert.deepEqual(
    links(sec).filter((t) => /^https?:/.test(t)),
    [ADVISORY_URL],
    'the advisory form is the only external URL',
  );

  const expect = section(sec, 'What to expect');
  for (const window of ['5 business days', '14 days', '90 days']) assert.ok(expect.includes(window), window);

  const supported = section(sec, 'Supported versions');
  assert.match(supported, /\bonly the latest minor\b/i);
  assert.doesNotMatch(supported, /\d+\.\d+/, 'no hard-coded version, which would go stale');

  const threat = section(sec, 'Threat model');
  for (const anchor of ['untrusted-input', 'dashboard-security', 'daemon-security'])
    assert.ok(links(threat).includes(`docs/ARCHITECTURE.md#${anchor}`), anchor);

  const config = section(sec, 'Configuration is code');
  assert.ok(config.includes('`.forge/config.yml` is code'));
  assert.match(config, /code-owner review/);
  assert.ok(links(config).includes('.github/CODEOWNERS'));

  // A summary that links, never a copy: no long sentence is lifted from ARCHITECTURE.md.
  const arch = read('docs/ARCHITECTURE.md');
  const sentences = prose(sec)
    .map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, ''))
    .flatMap((l) => l.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 60);
  assert.ok(sentences.length > 5, 'found the long sentences');
  for (const s of sentences) assert.ok(!arch.includes(s), `copied from docs/ARCHITECTURE.md: ${s}`);
});

test('CODEOWNERS gives @maxwellmattryan the sensitive paths, and every named file exists', () => {
  const rules = read('.github/CODEOWNERS')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/));
  const patterns = rules.map(([p]) => p);
  assert.deepEqual([...patterns].sort(), [...CODEOWNED].sort());
  assert.equal(new Set(patterns).size, patterns.length, 'no pattern is listed twice');
  for (const [p, ...owners] of rules) assert.deepEqual(owners, [OWNER], `${p} is owned only by ${OWNER}`);
  // A rename would otherwise end the file's ownership without anyone noticing.
  for (const p of patterns.filter((x) => !x.includes('*'))) {
    const file = path.join(ROOT, p);
    assert.ok(fs.existsSync(file) && fs.statSync(file).isFile(), `${p} names a file that exists`);
  }
});

test('dependabot.yml updates dev dependencies and actions weekly, grouped', () => {
  const src = read('.github/dependabot.yml');
  const config = parse(src);
  assert.equal(config.version, 2);
  assert.equal(config.updates.length, 2);
  const [npm, actions] = ['npm', 'github-actions'].map((eco) => config.updates.find((u: any) => u['package-ecosystem'] === eco));
  assert.deepEqual(npm, {
    'package-ecosystem': 'npm',
    directory: '/',
    schedule: { interval: 'weekly' },
    allow: [{ 'dependency-type': 'development' }],
    cooldown: { 'default-days': 7 },
    ignore: [{ 'dependency-name': '@types/node', 'update-types': ['version-update:semver-major'] }],
    groups: { 'dev-toolchain': { 'dependency-type': 'development', patterns: ['*'], 'update-types': ['minor', 'patch'] } },
  });
  assert.deepEqual(actions, {
    'package-ecosystem': 'github-actions',
    directory: '/',
    schedule: { interval: 'weekly' },
    groups: { 'github-actions': { patterns: ['*'] } },
  });

  const comments = src
    .split('\n')
    .filter((l) => /^\s*#/.test(l))
    .map((l) => l.replace(/^\s*#\s?/, ''))
    .join(' ');
  assert.match(comments, /zero runtime dependencies by rule/);
  assert.match(comments, /runtime dependency is closed/);
  assert.ok(comments.includes('dashboard/dist/'));
  assert.ok(comments.includes('npm run build:dashboard'));
  assert.match(comments, /pinned map in test\/dashboard-dist\.test\.ts/);
});

test('governance files carry no AI attribution lines', () => {
  for (const rel of [...GOVERNANCE, 'README.md']) assert.deepEqual(findAttribution(read(rel)), [], rel);
});
