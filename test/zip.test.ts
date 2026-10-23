import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import zlib from 'node:zlib';
import { hasBinary } from '#core/os/process.ts';
import { dosDateTime, zip } from '#core/format/zip.ts';

const HAS_UNZIP = hasBinary('unzip');

const entries = () => [
  { name: 'doctor.json', data: Buffer.from('{"ok":true}\n') },
  { name: 'jobs/é/ü.txt', data: Buffer.from('unicode name\n') },
  { name: 'empty.txt', data: Buffer.alloc(0) },
  { name: 'big.log', data: Buffer.from('a line that repeats and compresses well\n'.repeat(2700).slice(0, 100 * 1024)) },
  { name: 'random.bin', data: crypto.randomBytes(4096) },
];

/** The central directory records, read back by hand: what unzip would see. */
function central(buf: Buffer) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const nameLen = buf.readUInt16LE(at + 28);
    const rec = {
      flags: buf.readUInt16LE(at + 8),
      method: buf.readUInt16LE(at + 10),
      time: buf.readUInt16LE(at + 12),
      date: buf.readUInt16LE(at + 14),
      crc: buf.readUInt32LE(at + 16),
      csize: buf.readUInt32LE(at + 20),
      usize: buf.readUInt32LE(at + 24),
      offset: buf.readUInt32LE(at + 42),
      name: buf.subarray(at + 46, at + 46 + nameLen).toString('utf8'),
    };
    out.push(rec);
    at += 46 + nameLen;
  }
  return out;
}

describe('zip', { concurrency: 4 }, () => {
  test('unzip -t accepts it and unzip -p returns every entry exactly', { skip: !HAS_UNZIP && 'unzip is not installed' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-zip-'));
    try {
      const list = entries();
      const file = path.join(dir, 'a.zip');
      fs.writeFileSync(file, zip(list));
      const t = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
      assert.match(t, /No errors detected/);
      for (const e of list) {
        const got = execFileSync('unzip', ['-p', file, e.name], { maxBuffer: 1 << 24 });
        assert.ok(got.equals(e.data), `${e.name} round-trips`);
      }
      const recs = central(fs.readFileSync(file));
      assert.equal(recs.find((r) => r.name === 'big.log')!.method, 8, 'compressible text is deflated');
      assert.equal(recs.find((r) => r.name === 'random.bin')!.method, 0, 'random bytes are stored');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('headers carry crc, sizes, utf-8 flag and DOS time', () => {
    const when = new Date(2026, 9, 16, 13, 45, 31);
    const list = entries();
    const buf = zip(list, when);
    const dos = dosDateTime(when);
    assert.equal(dos.time, (13 << 11) | (45 << 5) | 15);
    assert.equal(dos.date, ((2026 - 1980) << 9) | (10 << 5) | 16);
    const recs = central(buf);
    assert.deepEqual(recs.map((r) => r.name), list.map((e) => e.name));
    for (const [i, r] of recs.entries()) {
      const e = list[i];
      assert.equal(r.crc, zlib.crc32(e.data) >>> 0, `${e.name} crc`);
      assert.equal(r.usize, e.data.length, `${e.name} size`);
      assert.equal(r.flags & 0x0800, 0x0800, 'utf-8 flag');
      assert.equal(r.time, dos.time);
      assert.equal(r.date, dos.date);
      // The local header repeats the same fields.
      assert.equal(buf.readUInt32LE(r.offset), 0x04034b50);
      assert.equal(buf.readUInt16LE(r.offset + 6) & 0x0800, 0x0800);
      assert.equal(buf.readUInt16LE(r.offset + 10), dos.time);
      assert.equal(buf.readUInt16LE(r.offset + 12), dos.date);
      assert.equal(buf.readUInt32LE(r.offset + 14), r.crc);
      assert.equal(buf.readUInt32LE(r.offset + 18), r.csize);
      assert.equal(buf.readUInt32LE(r.offset + 22), r.usize);
      const body = buf.subarray(r.offset + 30 + Buffer.byteLength(e.name), r.offset + 30 + Buffer.byteLength(e.name) + r.csize);
      assert.ok((r.method === 8 ? zlib.inflateRawSync(body) : body).equals(e.data), `${e.name} body`);
    }
  });

  test('refuses names that escape the extraction dir or carry control characters', () => {
    const data = Buffer.from('x');
    for (const name of ['a\\..\\..\\evil', '../evil', 'a/../../evil', '/etc/evil', 'a\x1b[31m.log', 'tab\there', 'del\x7f', '']) {
      assert.throws(() => zip([{ name, data }]), /refusing a zip entry name/, JSON.stringify(name));
    }
    assert.doesNotThrow(() => zip([{ name: 'jobs/a-1/logs/verify-test-2026.log', data }, { name: 'jobs/<login>/..x/~', data }]));
  });

  test('refuses what would need zip64', () => {
    const many = Array.from({ length: 65536 }, (_, i) => ({ name: `f${i}`, data: Buffer.alloc(0) }));
    assert.throws(() => zip(many), /zip64/);
    // A stand-in with a 4 GiB length: no real buffer is allocated.
    assert.throws(() => zip([{ name: 'huge', data: { length: 0xffffffff } as Buffer }]), /zip64/);
  });
});
