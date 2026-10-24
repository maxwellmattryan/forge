// The one temp-then-rename writer: a file or link an agent plants at a guessed name, or at the
// target itself, never redirects the write, and a failed write leaves nothing behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic, writeJsonAtomic, writeJsonPrivate, writeTextAtomic } from './fs.ts';

const POSIX = process.platform !== 'win32';

function scratch(): { dir: string; cleanup: () => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fs-')));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const temps = (dir: string) => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).sort();

/** A `rand` that hands out `names` in order. */
const seq = (...names: string[]) => {
  let i = 0;
  return () => names[Math.min(i++, names.length - 1)];
};

test('atomic writes never follow a planted link', { skip: !POSIX }, (t) => {
  const T = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => T);
  const writers: [string, (file: string) => void, string][] = [
    ['writeJsonAtomic', (f) => writeJsonAtomic(f, { a: 1 }), '{\n  "a": 1\n}\n'],
    ['writeTextAtomic', (f) => writeTextAtomic(f, 'new text'), 'new text'],
    ['writeJsonPrivate', (f) => writeJsonPrivate(f, { b: 2 }), '{\n  "b": 2\n}\n'],
  ];
  for (const [name, write, expected] of writers) {
    const s = scratch();
    try {
      const outTemp = path.join(s.dir, 'outside-temp');
      const outFile = path.join(s.dir, 'outside-file');
      fs.writeFileSync(outTemp, 'keep temp');
      fs.writeFileSync(outFile, 'keep file');
      fs.mkdirSync(path.join(s.dir, 'job'));
      const file = path.join(s.dir, 'job', 'state.json');
      const oldTemp = `${file}.${process.pid}.${T}.tmp`;
      fs.symlinkSync(outTemp, oldTemp);
      fs.symlinkSync(outFile, file);
      write(file);
      assert.equal(fs.readFileSync(outTemp, 'utf8'), 'keep temp', `${name}: the temp-name link was followed`);
      assert.equal(fs.readFileSync(outFile, 'utf8'), 'keep file', `${name}: the target link was followed`);
      assert.ok(fs.lstatSync(file).isFile(), `${name}: the target is a regular file`);
      assert.equal(fs.readFileSync(file, 'utf8'), expected, name);
      assert.ok(fs.lstatSync(oldTemp).isSymbolicLink(), `${name}: the planted link is left alone`);
      assert.equal(fs.readlinkSync(oldTemp), outTemp, name);
    } finally {
      s.cleanup();
    }
  }
});

test('a planted temp name is retried once, then refused', () => {
  const s = scratch();
  try {
    const file = path.join(s.dir, 'ledger.md');
    const first = 'a'.repeat(16);
    const planted = `${file}.${first}.tmp`;
    fs.writeFileSync(planted, 'planted');
    writeAtomic(file, 'new', { rand: seq(first, 'b'.repeat(16)) });
    assert.equal(fs.readFileSync(file, 'utf8'), 'new');
    assert.equal(fs.readFileSync(planted, 'utf8'), 'planted');
    assert.deepEqual(temps(s.dir), [path.basename(planted)], 'no second temp file is left');

    assert.throws(() => writeAtomic(file, 'newer', { rand: seq(first, first) }), (e: any) => e.code === 'EEXIST');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new', 'the target is unchanged');
    assert.equal(fs.readFileSync(planted, 'utf8'), 'planted');
    assert.deepEqual(temps(s.dir), [path.basename(planted)]);

    if (POSIX) {
      const outside = path.join(s.dir, 'outside');
      fs.writeFileSync(outside, 'outside');
      const link = `${file}.${'c'.repeat(16)}.tmp`;
      fs.symlinkSync(outside, link);
      assert.throws(() => writeAtomic(file, 'newest', { rand: seq('c'.repeat(16)) }), (e: any) => e.code === 'EEXIST');
      assert.equal(fs.readFileSync(outside, 'utf8'), 'outside', 'the link target is untouched');
      assert.equal(fs.readFileSync(file, 'utf8'), 'new');
      assert.deepEqual(temps(s.dir), [path.basename(planted), path.basename(link)].sort());
    }
  } finally {
    s.cleanup();
  }
});

test('modes are exact and JSON is pretty-printed', () => {
  const s = scratch();
  try {
    if (POSIX) {
      const priv = path.join(s.dir, 'token.json');
      fs.writeFileSync(priv, '{}', { mode: 0o644 });
      fs.chmodSync(priv, 0o644);
      writeJsonPrivate(priv, { token: 'x' });
      assert.equal(fs.statSync(priv).mode & 0o777, 0o600);
      const exact = path.join(s.dir, 'exact');
      writeAtomic(exact, 'x', { mode: 0o640 });
      assert.equal(fs.statSync(exact).mode & 0o777, 0o640);
    }
    const nested = path.join(s.dir, 'a', 'b', 'c.json');
    const data = { list: [1, 2], nested: { k: 'v' } };
    writeJsonAtomic(nested, data);
    assert.equal(fs.readFileSync(nested, 'utf8'), JSON.stringify(data, null, 2) + '\n');
  } finally {
    s.cleanup();
  }
});

test('a failed write leaves no temp file', () => {
  const s = scratch();
  try {
    const target = path.join(s.dir, 'occupied');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'inside'), 'x');
    assert.throws(() => writeAtomic(target, 'data'));
    assert.deepEqual(temps(s.dir), []);
    assert.equal(fs.readFileSync(path.join(target, 'inside'), 'utf8'), 'x');
  } finally {
    s.cleanup();
  }
});
