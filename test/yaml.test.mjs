import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify, YamlError } from '../lib/yaml.mjs';

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
    git: { base: 'develop', branchPrefix: 'factory/' },
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
