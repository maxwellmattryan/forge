// A repo's own tracker adapter as `.forge/trackers/<name>.ts`, loaded through Node's type stripping.
// tempRepo has no package.json, so Node's syntax detection decides the module type, as in most repos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { defaults, trustDigest, validateConfig } from '../lib/config.ts';
import { paths } from '../lib/paths.ts';
import { loadTracker } from '../lib/trackers/index.ts';
import { ForgeError } from '../lib/util.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

// Erasable syntax only: a type alias and annotations, which Node strips before running it.
const TS_ADAPTER = `type Item = { ref: string; title: string };
type Ctx = { root: string };
export default {
  name: 'acme',
  list: (_ctx: Ctx): Item[] => [{ ref: 'A-1', title: 'From TypeScript' }],
  get: (_ctx: Ctx, _ref: string): Item | null => null,
  claim: (_ctx: Ctx, _ref: string): { ok: boolean } => ({ ok: true }),
  update(_ctx: Ctx, _ref: string): void {},
  comment(_ctx: Ctx, _ref: string, _body: string): void {},
  create: (_ctx: Ctx): { ref: string } => ({ ref: 'A-2' }),
  close(_ctx: Ctx, _ref: string): void {},
};
`;
const MJS_ADAPTER = `export default { name: 'acme', list: () => [{ ref: 'A-1', title: 'From mjs' }], get: () => null, claim: () => ({ ok: true }), update() {}, comment() {}, create: () => ({ ref: 'A-2' }), close() {} };\n`;

function writeTracker(root: string, file: string, text: string): void {
  fs.mkdirSync(paths(root).trackers, { recursive: true });
  fs.writeFileSync(path.join(paths(root).trackers, file), text);
}

function forge(root: string, ...args: string[]): string {
  return execFileSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: root } });
}

function initWithTracker(root: string, kind: string): void {
  const answers = path.join(root, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { build: 'true', test: 'true', lint: 'true' }, tracker: { kind } }));
  assert.equal(JSON.parse(forge(root, 'init', 'write', '--answers', answers)).ok, true);
}

test('a .ts adapter loads, validates and lists through the CLI', () => {
  const repo = tempRepo();
  try {
    writeTracker(repo.dir, 'acme.ts', TS_ADAPTER);
    initWithTracker(repo.dir, 'acme');
    assert.equal(JSON.parse(forge(repo.dir, 'config', 'validate')).ok, true);
    assert.equal(forge(repo.dir, 'tracker', 'list'), '[{"ref":"A-1","title":"From TypeScript"}]\n');
  } finally {
    repo.cleanup();
  }
});

test('.mjs wins over .ts and declaration files are not adapters', () => {
  const repo = tempRepo();
  try {
    writeTracker(repo.dir, 'acme.mjs', MJS_ADAPTER);
    writeTracker(repo.dir, 'acme.ts', TS_ADAPTER);
    writeTracker(repo.dir, 'types.d.ts', 'export {};\n');
    initWithTracker(repo.dir, 'acme');
    assert.equal(forge(repo.dir, 'tracker', 'list'), '[{"ref":"A-1","title":"From mjs"}]\n');

    const config = defaults();
    config.tracker.kind = 'nope';
    const problems = validateConfig(config, repo.dir);
    assert.ok(problems.includes('tracker.kind must be one of local | github | none | acme (got "nope")'), problems.join('\n'));
  } finally {
    repo.cleanup();
  }
});

test('a .ts adapter missing a method is named in the error', async () => {
  const repo = tempRepo();
  try {
    writeTracker(repo.dir, 'acme.ts', "export default { name: 'acme' };\n");
    const config = defaults();
    config.tracker.kind = 'acme';
    const file = path.join(paths(repo.dir).trackers, 'acme.ts');
    await assert.rejects(loadTracker(repo.dir, config), (e: unknown) => {
      assert.ok(e instanceof ForgeError);
      assert.equal(e.message, `custom tracker ${file} is missing list()`);
      return true;
    });
  } finally {
    repo.cleanup();
  }
});

test('the daemon trust digest pins .ts adapters', () => {
  const repo = tempRepo();
  try {
    const before = trustDigest(repo.dir);
    writeTracker(repo.dir, 'acme.ts', TS_ADAPTER);
    const created = trustDigest(repo.dir);
    assert.notEqual(created, before, 'adding a .ts adapter changes the digest');
    writeTracker(repo.dir, 'acme.ts', TS_ADAPTER.replace('From TypeScript', 'Changed'));
    assert.notEqual(trustDigest(repo.dir), created, 'editing it changes the digest again');
  } finally {
    repo.cleanup();
  }
});
