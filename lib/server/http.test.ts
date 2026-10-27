// The HTTP plumbing every route shares, in-process: the source-address check dispatch runs before
// the Host check, the login's cookie and header parsing, and the body reader's byte cap, timeout and
// multibyte decoding.
import test from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { Readable } from 'node:stream';
import { authorized, cookieValue, isLoopbackAddress, loginCookieName, readBody } from './http.ts';

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

test('login credentials: the per-port cookie or the header', () => {
  const token = 'a'.repeat(32);
  const port = 7400;
  const name = loginCookieName(port);
  assert.equal(name, 'forge-7400');
  const cookies: [string | null, string | null][] = [
    [`${name}=${token}`, token],
    [`theme=dark;${name}=${token};x=1`, token],
    [`theme=dark ; ${name}=${token} ; x=1`, token],
    [`${name}=a=b`, 'a=b'],
    [`${name}=${token}; ${name}=${token}`, null],
    [`forge-7401=${token}`, null],
    [`x${name}=${token}`, null],
    ['', null],
    [null, null],
  ];
  for (const [header, want] of cookies) assert.equal(cookieValue(header, name), want, String(header));

  const req = (headers: http.IncomingHttpHeaders) => ({ headers }) as http.IncomingMessage;
  const rows: [http.IncomingHttpHeaders, boolean][] = [
    [{}, false],
    [{ 'x-forge-token': token }, true],
    [{ 'x-forge-token': 'b'.repeat(32) }, false],
    [{ 'x-forge-token': [token, token] }, false],
    [{ cookie: `${name}=${token}` }, true],
    [{ cookie: `other=1; ${name}=${token}` }, true],
    [{ cookie: `${name}=${'b'.repeat(32)}` }, false],
    [{ cookie: `forge-7401=${token}` }, false],
    [{ cookie: `${name}=${token}; ${name}=${token}` }, false],
    [{ cookie: `${name}=${token}`, 'x-forge-token': 'wrong' }, true],
    [{ cookie: `${name}=wrong`, 'x-forge-token': token }, true],
  ];
  for (const [headers, want] of rows) assert.equal(authorized(req(headers), token, port), want, JSON.stringify(headers));
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
