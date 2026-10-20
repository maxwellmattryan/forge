// Hidden check for the eval task `config-unknown-key-suggests`: `forge config get|set` refuse an
// unknown key as a usage error and suggest the closest known keys. Black-box: drives bin/forge only.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scratch, json, type Scratch, type CliResult } from './eval-check-harness.ts';

let s: Scratch;
let configPath: string;
let original: string;

before(() => {
  s = scratch();
  configPath = path.join(s.dir, '.forge', 'config.yml');
  original = fs.readFileSync(configPath, 'utf8');
});
after(() => s?.cleanup());

function usageError(r: CliResult, label: string): any {
  assert.equal(r.status, 2, `${label}: exit 2 (stdout ${r.stdout} stderr ${r.stderr})`);
  const e = json(r).error;
  assert.ok(e && typeof e === 'object', `${label}: an error object`);
  assert.equal(e.code, 'usage', `${label}: code usage`);
  assert.equal(e.exit, 2, `${label}: exit field`);
  assert.ok(Array.isArray(e.suggestions), `${label}: error.suggestions is an array (${JSON.stringify(e)})`);
  assert.ok(e.suggestions.length <= 3, `${label}: at most three suggestions`);
  for (const k of e.suggestions) assert.equal(typeof k, 'string', label);
  assert.ok(!e.message.includes('\n'), `${label}: one-line message`);
  return e;
}

function assertUnchanged(label: string): void {
  assert.equal(fs.readFileSync(configPath, 'utf8'), original, `${label}: .forge/config.yml is byte-identical`);
}

const TYPOS: Array<[string, string]> = [
  ['pipeline.splt', 'pipeline.split'],
  ['review.pannel', 'review.panel'],
  ['pipline.split', 'pipeline.split'],
];

describe('unknown keys are usage errors with suggestions', { concurrency: 4 }, () => {
  for (const [typo, want] of TYPOS) {
    test(`config get ${typo} suggests ${want} first`, async () => {
      const e = usageError(await s.forge(['config', 'get', typo, '--json']), `get ${typo}`);
      assert.equal(e.suggestions[0], want);
      assert.ok(e.message.includes(typo), `message names the key: ${e.message}`);
      assert.match(e.message, /did you mean/);
      assert.ok(e.message.includes(want), `message offers ${want}: ${e.message}`);
    });

    test(`config set ${typo} suggests ${want} first and writes nothing`, async () => {
      const e = usageError(await s.forge(['config', 'set', typo, 'auto', '--json']), `set ${typo}`);
      assert.equal(e.suggestions[0], want);
      assert.ok(e.message.includes(typo), `message names the key: ${e.message}`);
      assert.match(e.message, /did you mean/);
      assertUnchanged(`set ${typo}`);
    });
  }

  test('a top-level section typo suggests the section', async () => {
    const e = usageError(await s.forge(['config', 'get', 'pipline', '--json']), 'get pipline');
    assert.equal(e.suggestions[0], 'pipeline');
  });

  test('suggestions come closest first', async () => {
    // pipeline.plan is one edit away, pipeline.split two.
    const e = usageError(await s.forge(['config', 'get', 'pipeline.splan', '--json']), 'get pipeline.splan');
    const iPlan = e.suggestions.indexOf('pipeline.plan');
    const iSplit = e.suggestions.indexOf('pipeline.split');
    assert.equal(iPlan, 0, `pipeline.plan first: ${JSON.stringify(e.suggestions)}`);
    if (iSplit !== -1) assert.ok(iSplit > iPlan);
  });

  test('a key with nothing close gets no suggestion, on get and set', async () => {
    for (const args of [['config', 'get', 'zzqqxx.wwvv'], ['config', 'set', 'zzqqxx.wwvv', '1']]) {
      const e = usageError(await s.forge([...args, '--json']), args.join(' '));
      assert.deepEqual(e.suggestions, []);
      assert.ok(e.message.includes('zzqqxx.wwvv'), e.message);
      assert.doesNotMatch(e.message, /did you mean/);
    }
    assertUnchanged('set zzqqxx.wwvv');
  });

  test('without --json the error is one line on stderr naming the key and the suggestion', async () => {
    for (const args of [['config', 'get', 'review.pannel'], ['config', 'set', 'review.pannel', '[]']]) {
      const r = await s.forge(args);
      assert.equal(r.status, 2, args.join(' '));
      assert.equal(r.stdout, '', 'nothing on stdout');
      const lines = r.stderr.trimEnd().split('\n');
      assert.equal(lines.length, 1, `one line: ${r.stderr}`);
      assert.ok(lines[0].includes('review.pannel') && lines[0].includes('review.panel'), lines[0]);
      assert.match(lines[0], /did you mean/);
    }
    assertUnchanged('set review.pannel');
  });
});

describe('known keys keep working', { concurrency: 4 }, () => {
  test('get of a known key with no value prints null and exits 0', async () => {
    for (const key of ['pipeline.budget.tokens', 'commands.e2e', 'tracker.github.ready.assignee']) {
      const r = await s.forge(['config', 'get', key, '--json']);
      assert.equal(r.status, 0, `${key}: ${r.stdout}${r.stderr}`);
      assert.equal(json(r), null, key);
    }
  });

  test('get of a known key prints its value, and of a section the section', async () => {
    const r = await s.forge(['config', 'get', 'pipeline.split', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(json(r), 'ask');
    const sec = await s.forge(['config', 'get', 'pipeline', '--json']);
    assert.equal(sec.status, 0, sec.stdout + sec.stderr);
    assert.equal(json(sec).split, 'ask');
  });

  test('get with no key prints the whole config', async () => {
    const r = await s.forge(['config', 'get', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(json(r).pipeline.split, 'ask');
  });

  test('a read-only known key is still refused as read-only, not unknown', async () => {
    const r = await s.forge(['config', 'set', 'tracker.kind', 'github', '--json']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.doesNotMatch(json(r).error.message, /unknown config key/);
    assertUnchanged('set tracker.kind');
  });
});

test('set of a valid key still writes', async () => {
  const r = await s.forge(['config', 'set', 'pipeline.maxRounds', '5', '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(json(r).ok, true);
  const got = await s.forge(['config', 'get', 'pipeline.maxRounds', '--json']);
  assert.equal(json(got), 5);
});
