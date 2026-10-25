// The approval record: a root counts as approved only while the files Forge trusts are exactly what a
// human last approved, and the record is private to its owner, one per root, and never read as anything
// but a plain file. Every call passes `home` explicitly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { trustDigest } from '#core/config/trust.ts';
import { approveTrust, trustApproved, trustFile } from './trust-approval.ts';

const made: string[] = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
/** A not-yet-created FORGE_HOME in a fresh scratch dir. */
const freshHome = (): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trust-')));
  made.push(d);
  return path.join(d, 'home');
};
const initialised = (): ReturnType<typeof tempRepo> => {
  const r = tempRepo();
  fs.mkdirSync(path.join(r.dir, '.forge'));
  fs.writeFileSync(path.join(r.dir, '.forge', 'config.yml'), 'project:\n  name: x\n');
  return r;
};

test('a root is approved only while its trusted files match what a human approved', () => {
  const home = freshHome();
  const a = initialised();
  const b = initialised();
  try {
    assert.equal(trustApproved(home, a.dir), false, 'nothing approved yet');
    approveTrust(home, a.dir);
    assert.equal(trustApproved(home, a.dir), true);
    assert.equal(trustApproved(home, b.dir), false, "a's approval is not b's");

    const changes: [string, () => void][] = [
      ['the config', () => fs.appendFileSync(path.join(a.dir, '.forge', 'config.yml'), 'daemon:\n  enabled: true\n')],
      ['CLAUDE.md', () => fs.writeFileSync(path.join(a.dir, 'CLAUDE.md'), 'new rules\n')],
      ['a note', () => (fs.mkdirSync(path.join(a.dir, '.forge', 'notes'), { recursive: true }), fs.writeFileSync(path.join(a.dir, '.forge', 'notes', 'learnings.md'), 'x\n'))],
    ];
    for (const [what, change] of changes) {
      change();
      assert.equal(trustApproved(home, a.dir), false, `${what} changed`);
      approveTrust(home, a.dir);
      assert.equal(trustApproved(home, a.dir), true, `approved again after ${what}`);
    }
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('the record is private, and a record that is not a plain, current digest approves nothing', { skip: process.platform === 'win32' }, () => {
  const home = freshHome();
  const a = initialised();
  try {
    approveTrust(home, a.dir);
    const file = trustFile(home, a.dir);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0, 'the directory is private too');
    assert.equal(fs.statSync(home).mode & 0o077, 0, 'in a private home');

    const rows: [string, () => void][] = [
      ['not JSON', () => fs.writeFileSync(file, 'not json')],
      ['no digest', () => fs.writeFileSync(file, '{}')],
      ['a digest that is not a string', () => fs.writeFileSync(file, '{"digest": 1}')],
      ['a record over 4 KiB', () => fs.writeFileSync(file, JSON.stringify({ digest: 'x'.repeat(5000) }))],
      [
        'a symlink to a record with the current digest',
        () => {
          const good = path.join(path.dirname(file), 'good');
          fs.writeFileSync(good, JSON.stringify({ digest: trustDigest(a.dir) }));
          fs.symlinkSync(good, file);
        },
      ],
    ];
    for (const [what, plant] of rows) {
      approveTrust(home, a.dir);
      assert.equal(trustApproved(home, a.dir), true);
      fs.rmSync(file, { force: true });
      plant();
      assert.equal(trustApproved(home, a.dir), false, what);
    }
  } finally {
    a.cleanup();
  }
});
