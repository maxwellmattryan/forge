import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { detect } from '../lib/detect.ts';
import { defaults } from '../lib/config.ts';

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

test('suggests worktrees.generated for committed build output', () => {
  const suggest = (files: Record<string, string>, untracked: Record<string, string> = {}) => {
    const repo = tempRepo();
    try {
      const write = (all: Record<string, string>) => {
        for (const [rel, text] of Object.entries(all)) {
          fs.mkdirSync(path.dirname(path.join(repo.dir, rel)), { recursive: true });
          fs.writeFileSync(path.join(repo.dir, rel), text);
        }
      };
      write(files);
      repo.git('add', '-A');
      repo.git('commit', '-qm', 'files');
      write(untracked);
      return detect(repo.dir).suggestions['worktrees.generated'];
    } finally {
      repo.cleanup();
    }
  };
  const build = { 'package.json': pkg({ scripts: { build: 'vite build' } }) };
  assert.deepEqual(suggest({ ...build, 'dashboard/dist/index.html': '<p>' }), ['dashboard/dist/**']);
  assert.deepEqual(suggest({ ...build, 'dist/a.js': '1' }), ['dist/**']);
  assert.deepEqual(suggest({ ...build, 'out/a.js': '1', 'web/build/b.js': '1', 'dist/a.js': '1', 'dist/c/d.js': '1' }), ['dist/**', 'out/**', 'web/build/**'], 'sorted and unique');
  assert.deepEqual(suggest(build, { 'dist/a.js': '1' }), [], 'an untracked dist is not committed output');
  assert.deepEqual(suggest({ ...build, 'a/b/dist/x': '1' }), [], 'third level is not suggested');
  assert.deepEqual(suggest({ 'dist/a.js': '1' }), [], 'no build command, nothing regenerates it');
});

test('suggests the design lens for UI repos', () => {
  const panel = (files: Record<string, string>) => {
    const repo = tempRepo();
    try {
      for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(repo.dir, rel), text);
      return detect(repo.dir).suggestions['review.panel'] as string[];
    } finally {
      repo.cleanup();
    }
  };
  const ui = panel({ 'package.json': pkg({ dependencies: { svelte: '5.0.0' } }) });
  assert.ok(ui.includes('design'), JSON.stringify(ui));
  for (const lens of ['ui', 'ux', 'accessibility']) assert.ok(!ui.includes(lens), `${lens} in ${JSON.stringify(ui)}`);

  const plain = panel({ 'package.json': pkg({ dependencies: { express: '4.0.0' } }) });
  for (const lens of ['design', 'ui', 'ux', 'accessibility']) assert.ok(!plain.includes(lens), `${lens} in ${JSON.stringify(plain)}`);
});

test('suggests protected paths from the stack', () => {
  const suggest = (files: Record<string, string>) => {
    const repo = tempRepo();
    try {
      for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(repo.dir, rel), text);
      return detect(repo.dir).suggestions['policy.protectedPaths'] as { paths: string[]; action: string; reason: string }[];
    } finally {
      repo.cleanup();
    }
  };
  const rules = suggest({ 'package.json': pkg({}), 'Cargo.toml': '[package]\nname = "x"\n' });
  const locks = rules.find((r) => r.reason === 'dependency lockfile');
  assert.deepEqual(locks, { paths: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock'], action: 'escalate', reason: 'dependency lockfile' });
  assert.equal(rules.length, defaults().policy.protectedPaths.length, 'every other default rule stays');
  assert.deepEqual(rules.filter((r) => r !== locks), defaults().policy.protectedPaths.filter((r) => r.reason !== 'dependency lockfile'));
  assert.deepEqual(suggest({ 'go.mod': 'module x\n', Gemfile: '' }).find((r) => r.reason === 'dependency lockfile')?.paths, ['go.sum', 'Gemfile.lock']);
  assert.deepEqual(suggest({ 'pyproject.toml': '' }).find((r) => r.reason === 'dependency lockfile')?.paths, ['poetry.lock', 'uv.lock']);
  const none = suggest({ 'README.txt': 'x' });
  assert.equal(none.find((r) => r.reason === 'dependency lockfile'), undefined, 'no ecosystem: no lockfile rule');
  assert.equal(none.length, defaults().policy.protectedPaths.length - 1);
});
