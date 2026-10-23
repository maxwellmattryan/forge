// The HTTP plumbing every route shares, in-process: the source-address check dispatch runs before
// the Host check, and the body reader's byte cap, timeout and multibyte decoding.
import test from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { Readable } from 'node:stream';
import { isLoopbackAddress, readBody } from './http.ts';

test('readBody counts bytes, cuts off oversized and stalled bodies', async () => {
  const req = (s: Readable) => s as unknown as http.IncomingMessage;
  // 😀 is 4 bytes in UTF-8; split 2 + 2 across chunks, it must still decode whole.
  const smile = Buffer.from('{"a":"😀"}');
  const at = smile.indexOf(0xf0) + 2;
  assert.equal(await readBody(req(Readable.from([smile.subarray(0, at), smile.subarray(at)]))), '{"a":"😀"}');

  let sent = 0;
  const big = new Readable({
    read() {
      // 70 KiB in 1 KiB chunks, then it would end: the reader must stop it first.
      if (sent >= 70) return void this.push(null);
      sent++;
      this.push(Buffer.alloc(1024, 'a'));
    },
  });
  await assert.rejects(readBody(req(big)), { message: 'body too large' });
  assert.equal(big.destroyed, true);

  const stalled = new Readable({ read() {} });
  stalled.push('{"a":');
  await assert.rejects(readBody(req(stalled), { timeoutMs: 50 }), { message: 'body timeout' });
  assert.equal(stalled.destroyed, true);
});

test('isLoopbackAddress accepts loopback only', () => {
  const rows: [string | undefined, boolean][] = [
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['10.0.0.1', false],
    ['192.168.1.5', false],
    ['::ffff:10.0.0.1', false],
    ['fe80::1', false],
    ['127.0.0.256', false],
    ['127.0.0.1.evil', false],
    ['', false],
    [undefined, false],
  ];
  for (const [addr, want] of rows) assert.equal(isLoopbackAddress(addr), want, String(addr));
});
