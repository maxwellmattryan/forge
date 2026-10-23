// The HTTP plumbing every route shares, in-process: the source-address check dispatch runs before
// the Host check, and the body reader's byte cap, timeout and multibyte decoding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackAddress } from './http.ts';

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
