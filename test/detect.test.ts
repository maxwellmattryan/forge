import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.mjs';
import { detect } from '../lib/detect.ts';

/** A fresh repo with the given files; returns detect()'s commands and tools. @param {Record<string,string>} files */
function detectWith(files) {
  const repo = tempRepo();
  try {
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(repo.dir, rel), text as any);
    const d = detect(repo.dir);
    return { e2e: d.commands.e2e, tools: d.tools };
  } finally {
    repo.cleanup();
  }
}
const pkg = (o) => JSON.stringify({ name: 'x', ...o });

test('suggests an e2e command for Playwright and Cypress', () => {
  let r = detectWith({ 'package.json': pkg({ devDependencies: { '@playwright/test': '1.0.0' } }) });
  assert.equal(r.e2e, 'npx playwright test');
  assert.equal(r.tools.playwright, true);
  assert.equal(r.tools.cypress, false);

  r = detectWith({ 'package.json': pkg({ devDependencies: { cypress: '13.0.0' } }), 'pnpm-lock.yaml': '' });
  assert.equal(r.e2e, 'pnpm exec cypress run');
  assert.equal(r.tools.cypress, true);

  r = detectWith({ 'package.json': pkg({ scripts: { 'test:e2e': 'playwright test', e2e: 'other' }, devDependencies: { '@playwright/test': '1', cypress: '1' } }), 'yarn.lock': '' });
  assert.equal(r.e2e, 'yarn test:e2e');

  r = detectWith({ 'package.json': pkg({ scripts: { e2e: 'cypress run' }, devDependencies: { cypress: '1' } }) });
  assert.equal(r.e2e, 'npm run e2e');

  // A config file alone marks the tool but suggests no command: npx/bunx would fetch an unpinned package.
  r = detectWith({ 'playwright.config.ts': 'export default {}\n' });
  assert.equal(r.tools.playwright, true);
  assert.equal(r.e2e, null);
  r = detectWith({ 'package.json': pkg({}), 'bun.lock': '', 'cypress.config.mjs': '' });
  assert.equal(r.tools.cypress, true);
  assert.equal(r.e2e, null);

  r = detectWith({ 'package.json': pkg({ devDependencies: { cypress: '1' } }), 'bun.lock': '', 'cypress.config.mjs': '' });
  assert.equal(r.e2e, 'bunx cypress run');

  r = detectWith({ 'package.json': pkg({ devDependencies: { vitest: '1' } }) });
  assert.equal(r.e2e, null);
  assert.equal(r.tools.playwright, false);
  assert.equal(r.tools.cypress, false);
});
