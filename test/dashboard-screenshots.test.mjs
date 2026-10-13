import test from 'node:test';
import assert from 'node:assert/strict';
import { screenshotsPanel } from '../dashboard/screenshots.js';

test('escapes names and builds encoded URLs', () => {
  assert.equal(screenshotsPanel('job-1', []), '');
  assert.equal(screenshotsPanel('job-1', undefined), '');

  const evil = 'screenshots/"><img src=x onerror=alert(1)>.png';
  const html = screenshotsPanel('job-1', [evil, 'screenshots/nested/ac18-drawer-375.png']);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /onerror=alert\(1\)>/);
  const url = `/api/jobs/job-1/file?path=${encodeURIComponent(evil)}`;
  assert.ok(html.includes(`href="${url}"`), 'link uses the encoded URL');
  assert.ok(html.includes(`src="${url}"`), 'image uses the encoded URL');
  assert.ok(html.includes('alt="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;.png"'), 'alt is the escaped name without screenshots/');
  assert.match(html, /<h3 class="text-sm font-semibold">Screenshots<\/h3><span class="text-\[11px\] text-muted">2<\/span>/);
  assert.equal((html.match(/target="_blank" rel="noopener"/g) ?? []).length, 2);
  assert.equal((html.match(/loading="lazy"/g) ?? []).length, 2);
  assert.match(html, /grid-cols-2 md:grid-cols-3/);
  assert.match(html, />nested\/ac18-drawer-375\.png</);

  // The job id is encoded too.
  assert.ok(screenshotsPanel('a"b', ['screenshots/a.png']).includes('/api/jobs/a%22b/file?path=screenshots%2Fa.png'));
});
