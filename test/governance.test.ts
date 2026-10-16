// Keeps the repository governance files correct as paths, headings and the AGENTS.md verify list
// change. Reads files only: no git and no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '../lib/yaml.ts';
import { findAttribution } from '../lib/attribution.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const GOVERNANCE = [
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  '.github/CODEOWNERS',
  '.github/dependabot.yml',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/pull_request_template.md',
];
const OWNER = '@maxwellmattryan';
const ADVISORY_URL = 'https://github.com/maxwellmattryan/forge/security/advisories/new';
/** sha256 of Contributor Covenant 2.1 as published, `[INSERT CONTACT METHOD]` placeholder included. */
const COC_SHA256 = '369bf7301883368fc19203bd0f1233fed2b83f0378ad19c4d0708bf61925339b';
const COC_PLACEHOLDER = '[INSERT CONTACT METHOD]';
const COC_CONTACT = `[the private reporting form](${ADVISORY_URL}) (title the report "Code of Conduct")`;
const FORM_TYPES = new Set(['markdown', 'textarea', 'input', 'dropdown', 'checkboxes']);
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

/**
 * Inline link and image targets outside fenced code and code spans, without any title. Matching
 * on the `](` that ends every inline link's text, rather than on balanced brackets, also yields
 * both targets of a nested badge such as `[![CI](img.svg)](url)`.
 */
function links(md: string): string[] {
  return prose(md).flatMap((l) => [...l.replace(/`[^`]*`/g, '').matchAll(/\]\(\s*<?([^)\s>]+)/g)].map((m) => m[1]));
}

/** The lines under `## <title>`, up to the next heading of level 1 or 2. */
function section(md: string, title: string): string {
  const all = md.split('\n');
  const start = all.indexOf(`## ${title}`);
  assert.ok(start >= 0, `missing "## ${title}"`);
  const end = all.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  return all.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

/** The command lines of the AGENTS.md verify block, each without its trailing ` # comment`. */
function verifyCommands(): string[] {
  const agents = read('AGENTS.md').split('\n');
  const heading = agents.indexOf('## Verify before claiming it works');
  assert.ok(heading >= 0, 'AGENTS.md has "## Verify before claiming it works"');
  const open = agents.findIndex((l, i) => i > heading && l.startsWith('```'));
  const close = agents.findIndex((l, i) => i > open && l.startsWith('```'));
  assert.ok(open > heading && close > open, 'the verify section starts with a fenced block');
  const commands = agents
    .slice(open + 1, close)
    .map((l) => l.split(/\s+#\s/)[0].trim())
    .filter(Boolean);
  assert.ok(commands.includes('npm ci') && commands.length >= 5, `parsed the verify commands: ${commands.join(' | ')}`);
  return commands;
}

const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

/** A parsed issue form, after the checks GitHub applies before it shows the form instead of a blank issue. */
function issueForm(rel: string): any {
  const form = parse(read(rel));
  for (const key of ['name', 'description']) assert.ok(typeof form[key] === 'string' && form[key].trim(), `${rel}: ${key}`);
  assert.ok(Array.isArray(form.body) && form.body.length, `${rel}: body`);
  assert.equal(form.title, undefined, `${rel}: no title, because Forge turns issue titles into job ids`);
  const ids = new Set<string>();
  for (const el of form.body) {
    const where = `${rel}: ${el.id ?? el.type}`;
    assert.ok(FORM_TYPES.has(el.type), `${where}: type ${el.type}`);
    if (el.id !== undefined) {
      assert.match(String(el.id), /^[A-Za-z0-9_-]+$/, where);
      assert.ok(!ids.has(el.id), `${where}: duplicate id`);
      ids.add(el.id);
    }
    if (el.type === 'markdown') {
      assert.ok(typeof el.attributes?.value === 'string' && el.attributes.value.trim(), `${where}: value`);
      assert.equal(el.validations, undefined, `${where}: markdown takes no validations`);
    } else {
      assert.ok(typeof el.attributes?.label === 'string' && el.attributes.label.trim(), `${where}: label`);
    }
    if (el.type === 'dropdown') assert.ok(Array.isArray(el.attributes.options) && el.attributes.options.length, `${where}: options`);
  }
  assert.ok(form.body.some((el: any) => el.type !== 'markdown'), `${rel}: at least one field`);
  return form;
}

const field = (form: any, id: string): any => form.body.find((el: any) => el.id === id);

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
    ignore: [{ 'dependency-name': '@types/node', 'update-types': ['version-update:semver-major', 'version-update:semver-minor'] }],
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

test('CONTRIBUTING.md links the verify list instead of copying it and states the PR conventions', () => {
  const contributing = read('CONTRIBUTING.md');
  const targets = links(contributing);
  for (const t of ['AGENTS.md#verify-before-claiming-it-works', 'README.md#authorship', 'SECURITY.md', 'CODE_OF_CONDUCT.md'])
    assert.ok(targets.includes(t), `links ${t}`);
  for (const s of ['claude --plugin-dir', 'Closes #', 'CHANGELOG.md', 'test/dashboard-dist.test.ts']) assert.ok(contributing.includes(s), s);
  assert.match(contributing, /one PR per issue/i);
  // The verify list lives in AGENTS.md alone, so a copy here can't drift from it.
  for (const cmd of verifyCommands().filter((c) => c !== 'npm ci')) assert.ok(!contributing.includes(cmd), `copies the verify command ${cmd}`);
});

test('CODE_OF_CONDUCT.md is Contributor Covenant 2.1 verbatim apart from the contact', () => {
  const coc = read('CODE_OF_CONDUCT.md');
  const found = [...coc.matchAll(/responsible for enforcement at (.+)\. All complaints will be reviewed/g)];
  assert.equal(found.length, 1);
  assert.equal(found[0][1], COC_CONTACT);
  assert.ok(!coc.includes(COC_PLACEHOLDER), 'the placeholder is replaced');
  const restored = coc.replace(`at ${COC_CONTACT}. All complaints`, () => `at ${COC_PLACEHOLDER}. All complaints`);
  assert.equal(sha256(restored), COC_SHA256);
});

test('issue forms are well formed and the bug form asks for forge doctor and forge version', () => {
  const bug = issueForm('.github/ISSUE_TEMPLATE/bug_report.yml');
  assert.deepEqual(bug.labels, ['bug']);
  const doctor = field(bug, 'doctor');
  assert.equal(doctor?.type, 'textarea');
  assert.equal(doctor.attributes.render, 'text');
  assert.equal(doctor.validations?.required, true);
  assert.match(doctor.attributes.label, /forge doctor/);
  const version = field(bug, 'version');
  assert.equal(version?.type, 'input');
  assert.equal(version.validations?.required, true);
  assert.match(version.attributes.label, /forge version/);
  const bundle = field(bug, 'bundle');
  assert.equal(bundle?.type, 'textarea');
  assert.equal(bundle.validations?.required, false, 'the support bundle is optional');
  assert.match(bundle.attributes.description, /forge doctor --bundle/);
  assert.ok(
    bug.body.some((el: any) => el.type === 'markdown' && el.attributes.value.includes('(https://github.com/maxwellmattryan/forge/blob/main/SECURITY.md)')),
    'a markdown note sends security reports to SECURITY.md',
  );

  const feature = issueForm('.github/ISSUE_TEMPLATE/feature_request.yml');
  assert.deepEqual(feature.labels, ['enhancement']);
  for (const id of ['problem', 'proposal']) {
    assert.equal(field(feature, id)?.type, 'textarea', id);
    assert.equal(field(feature, id).validations?.required, true, id);
  }

  // The rest of each form, in order, as the spec's Approach lays it out.
  const fields = (form: any) => form.body.filter((el: any) => el.type !== 'markdown').map((el: any) => `${el.id}:${el.type}:${el.validations?.required === true ? 'required' : 'optional'}`);
  assert.deepEqual(fields(bug), [
    'what-happened:textarea:required',
    'steps:textarea:required',
    'expected:textarea:required',
    'doctor:textarea:required',
    'bundle:textarea:optional',
    'version:input:required',
    'install:dropdown:required',
    'environment:input:optional',
  ]);
  assert.deepEqual(field(bug, 'install').attributes.options, ['Claude Code plugin', 'CLI from a clone']);
  assert.ok(
    field(bug, 'environment').attributes.description.includes('(https://github.com/maxwellmattryan/forge/blob/main/docs/SUPPORT.md)'),
    'the environment field links the support matrix',
  );
  assert.deepEqual(fields(feature), ['problem:textarea:required', 'proposal:textarea:required', 'alternatives:textarea:optional', 'area:dropdown:optional']);
  assert.deepEqual(field(feature, 'area').attributes.options, [
    'CLI',
    'Orchestrator and agents',
    'Dashboard',
    'Daemon',
    'Trackers and PRs',
    'Evals and retros',
    'Docs',
  ]);
});

test("the PR template's checklist mirrors the AGENTS.md verify commands", () => {
  const template = read('.github/pull_request_template.md');
  const boxes = template.split('\n').filter((l) => l.startsWith('- [ ]'));
  for (const cmd of verifyCommands())
    assert.ok(
      boxes.some((l) => l.includes(cmd)),
      `add "- [ ] \`${cmd}\`" to .github/pull_request_template.md: its checklist mirrors AGENTS.md "Verify before claiming it works"`,
    );
  assert.match(template, /^Closes #/m);
  assert.ok(boxes.some((l) => /AI attribution/.test(l)), 'checklist item for no AI attribution');
  assert.ok(boxes.some((l) => /version/i.test(l) && l.includes('CHANGELOG')), 'checklist item for no version or CHANGELOG bump');
  // Relative links don't resolve in a PR body.
  assert.deepEqual(links(template).filter((t) => !/^(https?|mailto):/.test(t)), []);
});

test('README links the governance files from a Project section before License', () => {
  const readme = read('README.md').split('\n');
  const start = readme.indexOf('## Project');
  assert.ok(start >= 0, 'README has "## Project"');
  const next = readme.findIndex((l, i) => i > start && /^#{1,6} /.test(l));
  assert.equal(readme[next], '## License', 'the next heading is "## License"');
  const targets = links(readme.slice(start, next).join('\n'));
  for (const t of ['SECURITY.md', 'SECURITY.md#supported-versions', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md']) assert.ok(targets.includes(t), `links ${t}`);
});

test('relative links and anchors in the governance docs and README resolve', () => {
  let checked = 0;
  for (const rel of ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md']) {
    const from = path.join(ROOT, rel);
    for (const target of links(read(rel))) {
      if (/^(https?|mailto):/i.test(target)) continue;
      const hash = target.indexOf('#');
      const file = hash === 0 ? from : path.resolve(path.dirname(from), decodeURIComponent(hash === -1 ? target : target.slice(0, hash)));
      assert.ok(fs.existsSync(file), `${rel}: ${target} names a path that does not exist`);
      if (hash !== -1) {
        const anchor = target.slice(hash + 1);
        assert.ok(anchors(fs.readFileSync(file, 'utf8')).has(anchor), `${rel}: ${target} names no heading in ${path.relative(ROOT, file)}`);
      }
      checked++;
    }
  }
  assert.ok(checked >= 20, `checked ${checked} links`);
  // The slug rules the anchors above rely on.
  assert.equal(slug('Verify before claiming it works'), 'verify-before-claiming-it-works');
  assert.equal(slug('`.forge/config.yml`'), 'forgeconfigyml');
  assert.equal(slug('Split gate: why 2 ways?'), 'split-gate-why-2-ways');
  assert.deepEqual([...anchors('# A\n## A\n```\n# B\n```\n')], ['a', 'a-1']);
  assert.deepEqual(links('[![CI](ci.svg)](docs/CI.md "CI") and `[x](code.md)`\n```\n[y](fenced.md)\n```\n'), ['ci.svg', 'docs/CI.md']);
});

test('governance files carry no AI attribution lines', () => {
  for (const rel of [...GOVERNANCE, 'README.md']) assert.deepEqual(findAttribution(read(rel)), [], rel);
});
