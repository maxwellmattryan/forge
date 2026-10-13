import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse, setIn, stringify, YamlError } from '../lib/yaml.ts';
import { FIELDS, validateFieldValue } from '../lib/config-fields.ts';
import { setPath } from '../lib/util.ts';

test('parses a GitHub project-config file', () => {
  const doc = parse(`# GitHub Project Configuration
repository:
  owner: example
  repo: app
project:
  number: 8
  name: Example Project
fields:
  status:
    name: Status
    options:
      - "📚 Backlog"
      - "🏗 In Progress"
      - "🎉 Done"
defaults:
  status: "📚 Backlog"
`);
  assert.equal(doc.project.number, 8);
  assert.deepEqual(doc.fields.status.options, ['📚 Backlog', '🏗 In Progress', '🎉 Done']);
  assert.equal(doc.defaults.status, '📚 Backlog');
});

test('handles sequences of maps, flow collections, block scalars and comments', () => {
  const doc = parse(`panel:
  - name: code
    always: true
  - { name: ui, when: "visual changes" }
tags: [a, 'b c', 3]
url: https://example.com/x#frag   # trailing comment
notes: |
  line one
  line two
empty:
`);
  assert.deepEqual(doc.panel, [{ name: 'code', always: true }, { name: 'ui', when: 'visual changes' }]);
  assert.deepEqual(doc.tags, ['a', 'b c', 3]);
  assert.equal(doc.url, 'https://example.com/x#frag');
  assert.equal(doc.notes, 'line one\nline two\n');
  assert.equal(doc.empty, null);
});

test('round-trips stringify output', () => {
  const value = {
    schemaVersion: 1,
    git: { base: 'develop', branchPrefix: 'forge/' },
    review: { panel: [{ name: 'code', always: true }, { name: 'security', model: 'opus', when: 'auth: tokens, sessions' }], blockOn: ['blocker', 'major'] },
    commands: { test: 'cargo test --workspace', dev: null },
    statusMap: { queued: '🔖 Todo', 'in-progress': '🏗 In Progress' },
    multiline: 'a\nb\n',
    tricky: ['yes', '123', '', ' padded', '#hash', '- dash'],
  };
  assert.deepEqual(parse(stringify(value)), value);
});

test('fails loudly outside the subset', () => {
  assert.throws(() => parse('a: &anchor 1\nb: *anchor\n'), YamlError);
  assert.throws(() => parse('a:\n\t- x\n'), YamlError);
  assert.throws(() => parse('a: 1\na: 2\n'), /duplicate key/);
});

test('setIn edits one value in place and refuses what it cannot keep', () => {
  const refuse = (src: string, p: string, v: any) => {
    let out: string | undefined;
    assert.throws(() => {
      out = setIn(src, p.split('.'), v);
    }, YamlError, p);
    assert.equal(out, undefined);
  };
  refuse('a:\n  b: 1\n', 'a', 1); // a block map
  refuse('a: |\n  text\n', 'a', 'x'); // a block scalar
  refuse('a:\n  - name: x\n', 'a', ['y']); // a list of maps
  refuse('a:\n  - x\n  # note\n  - y\n', 'a', ['z']); // a comment between items
  refuse('a:\n  - x  # note\n', 'a', ['z']); // a comment after an item
  refuse('a: { b: 1 }\n', 'a.b', 2); // inside a flow map
  refuse('a:\n  - b: 1\n', 'a.b', 2); // behind a sequence
  refuse('a: 1\n', 'a.b', 2); // behind a scalar

  assert.equal(setIn('a: 1   # keep\nb: 2\n', ['a'], 5), 'a: 5   # keep\nb: 2\n');
  assert.equal(setIn('a:\n  b: 1\n\nc: 2', ['a', 'd'], true), 'a:\n  b: 1\n  d: true\n\nc: 2', 'insertion keeps the missing final newline');
  assert.equal(setIn('a:\n  - x\n  - y\nb: 1\n', ['a'], []), 'a: []\nb: 1\n');
  assert.equal(setIn('a:\n- x\nb: 1\n', ['a'], ['p', 'q']), 'a:\n- p\n- q\nb: 1\n', 'a same-indent list keeps its dash column');
  assert.equal(setIn('a:\nb: 1\n', ['a', 'c'], 'v'), 'a:\n  c: v\nb: 1\n', 'a null map gets children at parent + 2');
  assert.equal(setIn('a: 1\n', ['n', 'm'], [ 'x', 'y,z' ]), 'a: 1\nn:\n  m: [x, "y,z"]\n', 'a missing section goes at the end');
  assert.equal(setIn('a: 1\r\nb: 2\r\n', ['b'], 3), 'a: 1\r\nb: 3\r\n', 'CRLF stays CRLF');

  const comments = (t: string) => t.split(/\r?\n/).map((l) => l.match(/(?:^|\s)(#.*)$/)?.[1]).filter(Boolean);
  const valueFor = (f: (typeof FIELDS)[number]): any => {
    const d = f.default as any;
    if (f.type === 'boolean') return !d;
    if (f.type === 'enum') return f.options!.find((o) => o !== d);
    if (f.type === 'integer' || f.type === 'number') return d === null ? (f.min ?? 0) + 3 : f.max !== null && d + 1 > f.max ? d - 1 : d + 1;
    if (f.type === 'list') return f.options ? ['blocker', 'major', 'nit'] : ['ready', 'needs triage'];
    if (f.key.startsWith('runtime.models.')) return d === 'haiku' ? 'sonnet' : 'haiku';
    if (f.key === 'tracker.github.labels.prefix') return 'new-prefix:';
    return 'new-value';
  };
  const sources = {
    'this repo': fs.readFileSync(path.join(import.meta.dirname, '..', '.forge', 'config.yml'), 'utf8'),
    fixture: fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'config-commented.yml'), 'utf8'),
  };
  for (const [name, src] of Object.entries(sources)) {
    const before = parse(src);
    for (const f of FIELDS.filter((x) => x.editable)) {
      const value = valueFor(f);
      assert.equal(validateFieldValue(f, value), null, `${f.key} test value is valid`);
      const out = setIn(src, f.key.split('.'), value);
      const expected = structuredClone(before);
      setPath(expected, f.key, value);
      assert.deepEqual(parse(out), expected, `${name}: ${f.key} changes only that key`);
      assert.deepEqual(comments(out), comments(src), `${name}: ${f.key} keeps every comment`);
    }
    const crlf = setIn(src.replace(/\n/g, '\r\n'), ['pipeline', 'maxRounds'], 9);
    assert.ok(!/[^\r]\n/.test(crlf), `${name}: CRLF input stays CRLF`);
    assert.equal(parse(crlf).pipeline.maxRounds, 9);
  }
});
