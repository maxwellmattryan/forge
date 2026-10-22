// Known values (lib/known-secrets.ts): the private record of resolved secrets and the redactors.
// Platform-neutral: sinks render in process with env sources and no command sink.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, repoTemplate } from './helpers.ts';
import { applySinks } from '../lib/config-sinks-apply.ts';
import { loadConfig } from '../lib/core/config/load.ts';
import { createJob, jobDir, loadJob } from '../lib/core/job/store.ts';
import { PRIVATE_JOB_FILES, knownFile, knownRecordValues, knownValues, recordKnown, redactDeep, redactKnown } from '../lib/known-secrets.ts';
import { createWorktree } from '../lib/worktree.ts';
import * as yaml from '../lib/core/format/yaml.ts';

const template = repoTemplate((dir) => {
  fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'api/.env.local\n');
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', '.gitignore'), 'jobs/\nlocks/\nruntime/\n');
  fs.writeFileSync(path.join(dir, 'api', 'README.md'), 'api\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'api'], { cwd: dir, stdio: 'pipe' });
});

const hex = () => crypto.randomBytes(8).toString('hex');

describe('known secrets', { concurrency: 4 }, () => {
  test('record is private, merged and removed', async () => {
    const repo = template();
    const root = repo.dir;
    try {
      const a = `a-${hex()}`;
      const b = `b-${hex()}`;
      fs.writeFileSync(
        path.join(root, '.forge', 'config.yml'),
        yaml.stringify({
          tracker: { kind: 'none' },
          pr: { enabled: false },
          worktrees: { root: '../{repo}.wt' },
          secrets: { A: { env: 'FORGE_TEST_KNOWN_A' }, B: { env: 'FORGE_TEST_KNOWN_B' }, UNUSED: { env: 'FORGE_TEST_KNOWN_UNUSED' } },
          components: [{ name: 'api', path: 'api', kind: 'service', config: [{ env: { A: '{secret.A}' } }, { 'env-file': '.env.local', values: { B: '{secret.B}' } }] }],
        }),
      );
      const { config } = loadConfig(root);
      const id = createJob(root, config, { title: 'known' }).id;
      assert.equal(createWorktree(root, config, id).ok, true);
      const job = loadJob(root, id);
      const component = config.components[0];
      // A symlink planted at the record's path is replaced, never followed.
      const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.json`);
      fs.writeFileSync(outside, 'untouched\n');
      // Windows needs a privilege to create symlinks; the rename that replaces one is the same code.
      const links = process.platform !== 'win32';
      if (links) fs.symlinkSync(outside, knownFile(root, id));
      process.env.FORGE_TEST_KNOWN_A = a;
      process.env.FORGE_TEST_KNOWN_B = b;
      let applied;
      try {
        applied = applySinks(root, config, job, component, { env: process.env, fillCmd: (t) => t });
      } finally {
        delete process.env.FORGE_TEST_KNOWN_A;
        delete process.env.FORGE_TEST_KNOWN_B;
      }
      assert.deepEqual(applied!.summary.secrets, ['A', 'B']);
      assert.deepEqual(applied!.values.sort(), [a, b].sort());
      assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched\n', 'the symlink target is untouched');
      const file = knownFile(root, id);
      const st = fs.lstatSync(file);
      assert.equal(st.isSymbolicLink(), false);
      if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1, values: { A: a, B: b } }, 'no entry for UNUSED');
      assert.doesNotMatch(fs.readFileSync(path.join(jobDir(root, id), 'job.json'), 'utf8'), new RegExp(`${a}|${b}`));
      // Merged by name; rewritten only on a change.
      const ino = fs.statSync(file).ino;
      recordKnown(root, id, { A: a });
      assert.equal(fs.statSync(file).ino, ino, 'an unchanged record is not rewritten');
      const c = `c-${hex()}`;
      recordKnown(root, id, { C: c });
      assert.deepEqual(knownRecordValues(root, id).sort(), [a, b, c].sort());
      assert.deepEqual(knownValues(root, id, config).sort(), [a, b, c].sort());
      // A bad record counts as empty, never followed or blocked on.
      fs.rmSync(file);
      fs.writeFileSync(file, '{not json');
      assert.deepEqual(knownRecordValues(root, id), []);
      fs.rmSync(file);
      if (links) {
        fs.symlinkSync(outside, file);
        assert.deepEqual(knownRecordValues(root, id), []);
        fs.rmSync(file);
      }
      fs.writeFileSync(file, JSON.stringify({ v: 1, values: { A: a } }), { mode: 0o600 });
      assert.ok(PRIVATE_JOB_FILES.has(path.basename(file)) && PRIVATE_JOB_FILES.has('backing-db.json'));
      const r = await forgeAsync(root, ['worktree', 'remove', id]);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(fs.existsSync(file), false, 'forge worktree remove deletes the record');
      fs.rmSync(outside, { force: true });
    } finally {
      repo.cleanup();
      fs.rmSync(`${root}.wt`, { recursive: true, force: true });
    }
  });

  test('redactors replace raw and JSON-escaped values, longest first', () => {
    const v = 'pa"ss\\word-123';
    const short = 'abc';
    const line = JSON.stringify({ text: `x ${v} y`, n: 1, list: [v] });
    assert.doesNotMatch(redactKnown(line, [v]), /pa\\"ss/);
    assert.equal(redactKnown(line, [v]), JSON.stringify({ text: 'x [redacted] y', n: 1, list: ['[redacted]'] }));
    assert.equal(redactKnown(`raw ${v}`, [v]), 'raw [redacted]');
    assert.equal(redactKnown('abc abc', [short]), 'abc abc', 'values under 8 characters are never used');
    assert.equal(redactKnown('secret-12345678', ['secret-1234', 'secret-12345678']), '[redacted]');
    const obj = { a: `${v}!`, nested: { b: [v, 2] }, keep: true };
    const out = redactDeep(obj, [v]);
    assert.deepEqual(out, { a: '[redacted]!', nested: { b: ['[redacted]', 2] }, keep: true });
    assert.equal(obj.a, `${v}!`, 'the input is not mutated');
    assert.equal(redactDeep(obj, []), obj);
  });
});
