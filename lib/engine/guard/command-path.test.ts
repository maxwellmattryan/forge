// The PATH configured commands get: sanitizePath's rules per platform. In-process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePath } from './command-path.ts';

test('sanitizePath drops empty, relative and duplicate entries', () => {
  const rows: [string, string | undefined, NodeJS.Platform, string | undefined, string][] = [
    ['linux', '/a::.:./node_modules/.bin:/b:/a:rel/bin', 'linux', undefined, '/a:/b'],
    ['darwin keeps case', '/A:/a', 'darwin', undefined, '/A:/a'],
    ['win32 folds case and uses ;', 'C:\\a;;.\\x;C:\\A;D:\\b', 'win32', undefined, 'C:\\a;D:\\b'],
    ['first goes in front, its later copy dropped', '/a:/plugin/bin:/b', 'linux', '/plugin/bin', '/plugin/bin:/a:/b'],
    ['first on an empty PATH', '', 'linux', '/plugin/bin', '/plugin/bin'],
    ['nothing', undefined, 'linux', undefined, ''],
    ['only relative entries', '.:bin', 'linux', undefined, ''],
  ];
  for (const [name, value, platform, first, want] of rows) assert.equal(sanitizePath(value, platform, first), want, name);
});
