// Keeps the repository governance files correct as paths, headings and the AGENTS.md verify list
// change. Reads files only: no git and no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '../lib/core/format/yaml.ts';
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
const FORM_TYPES = new Set(['markdown', 'textarea', 'input', 'dropdown', 'checkboxes']);

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

test('CODEOWNERS gives @maxwellmattryan every pattern, and every named file exists', () => {
  const rules = read('.github/CODEOWNERS')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/));
  assert.ok(rules.length > 0, 'CODEOWNERS names paths');
  for (const [p, ...owners] of rules) assert.deepEqual(owners, [OWNER], `${p} is owned only by ${OWNER}`);
  // A rename would otherwise end the file's ownership without anyone noticing.
  for (const [p] of rules.filter(([x]) => !x.includes('*'))) {
    const file = path.join(ROOT, p);
    assert.ok(fs.existsSync(file) && fs.statSync(file).isFile(), `${p} names a file that exists`);
  }
});

test('issue forms are well formed', () => {
  for (const rel of ['.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml']) issueForm(rel);
});

test("the PR template's checklist mirrors the AGENTS.md verify commands", () => {
  const boxes = read('.github/pull_request_template.md').split('\n').filter((l) => l.startsWith('- [ ]'));
  for (const cmd of verifyCommands())
    assert.ok(
      boxes.some((l) => l.includes(cmd)),
      `add "- [ ] \`${cmd}\`" to .github/pull_request_template.md: its checklist mirrors AGENTS.md "Verify before claiming it works"`,
    );
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
