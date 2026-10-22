import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { defaults, loadConfig, panelPathsProblems, validateConfig } from '../lib/core/config/load.ts';
import { detect } from '../lib/engine/ops/detect.ts';
import { MAX_MANIFEST_BYTES, detectComponents } from '../lib/engine/ops/detect-components.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

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

test('suggests panel paths for the detected stack', () => {
  const suggest = (files: Record<string, string>) => {
    const repo = tempRepo();
    try {
      for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(repo.dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo.dir, rel), text);
      }
      repo.git('add', '-A');
      repo.git('commit', '-qm', 'files');
      const d = detect(repo.dir);
      return { panel: d.suggestions['review.panel'] as string[], paths: d.suggestions['review.panelPaths'] as Record<string, string[]> };
    } finally {
      repo.cleanup();
    }
  };
  const svelte = suggest({ 'package.json': pkg({ dependencies: { svelte: '5.0.0' } }), 'package-lock.json': '{}' });
  assert.deepEqual(svelte.paths.design, defaults().verifyE2e.paths);
  assert.ok(svelte.paths.design.includes('*.svelte'));
  assert.deepEqual(svelte.paths.security, ['package.json', 'package-lock.json']);
  assert.deepEqual(svelte.paths.docs, ['*.md', 'docs/**']);
  assert.equal(svelte.paths.infra, undefined);
  // Only suggested lenses that aren't always-on.
  for (const lens of Object.keys(svelte.paths)) assert.ok(svelte.panel.includes(lens) && !['code', 'tests'].includes(lens), lens);

  const infra = suggest({ 'go.mod': 'module x\n', 'go.sum': '', Dockerfile: 'FROM x\n', 'deploy/main.tf': '', 'deploy/k8s/app.yaml': '' });
  assert.deepEqual(infra.paths.infra, ['Dockerfile', '*.tf', '**/k8s/**', '**/kubernetes/**', '**/helm/**', '**/charts/**']);
  assert.deepEqual(infra.paths.security, ['go.mod', 'go.sum', 'Dockerfile', '*.tf', '**/k8s/**', '**/kubernetes/**', '**/helm/**', '**/charts/**']);
  assert.equal(infra.paths.design, undefined);
  // Every suggested glob passes the config check.
  for (const [lens, globs] of Object.entries({ ...svelte.paths, ...infra.paths })) assert.deepEqual(panelPathsProblems(lens, globs), [], lens);
});

test('init write keeps panel paths', () => {
  const repo = tempRepo();
  const answers = path.join(path.dirname(repo.dir), `answers-${path.basename(repo.dir)}.json`);
  try {
    const panel = [
      { name: 'code', always: true },
      { name: 'security', when: 'dependencies and input handling', paths: ['package.json', 'lib/trackers/**', '*.tf'] },
    ];
    fs.writeFileSync(answers, JSON.stringify({ review: { panel } }));
    const env = { ...process.env, FORGE_ROOT: repo.dir };
    execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: repo.dir, env, stdio: 'pipe' });
    assert.deepEqual(loadConfig(repo.dir).config.review.panel, panel);
    execFileSync(process.execPath, [BIN, 'config', 'validate'], { cwd: repo.dir, env, stdio: 'pipe' });

    // A bad glob never reaches config.yml.
    fs.writeFileSync(answers, JSON.stringify({ review: { panel: [{ name: 'code', always: true, paths: ['../x'] }] } }));
    const r = spawnSync(process.execPath, [BIN, 'init', 'write', '--force', '--answers', answers], { cwd: repo.dir, env, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /review\.panel "code"\.paths entry "\.\.\/x" must not contain a \.\. segment/);
    assert.deepEqual(loadConfig(repo.dir).config.review.panel, panel);
  } finally {
    repo.cleanup();
    fs.rmSync(answers, { force: true });
  }
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

/** detect()'s suggested components for a fresh repo holding `files` (paths may have directories). */
function componentsWith(files: Record<string, string>, prepare?: (dir: string) => void): any[] {
  const repo = tempRepo();
  try {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo.dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, rel), text);
    }
    prepare?.(repo.dir);
    const components = detect(repo.dir).suggestions.components as any[];
    // Whatever detect suggests must be a config init write would accept.
    assert.deepEqual(validateConfig({ ...defaults(), components }, repo.dir), [], JSON.stringify(components));
    return components;
  } finally {
    repo.cleanup();
  }
}

test('suggests components and build edges for npm workspaces', () => {
  const got = componentsWith({
    'package.json': pkg({ private: true, workspaces: ['packages/*'] }),
    'pnpm-lock.yaml': '',
    'packages/ui/package.json': pkg({ name: '@x/ui', scripts: { build: 'vite build', test: 'vitest', check: 'svelte-check' }, dependencies: { react: '18', '@x/core': '1' } }),
    'packages/core/package.json': pkg({ name: '@x/core', scripts: { test: 'node --test', lint: 'eslint .', typecheck: 'tsc' } }),
    'packages/api/package.json': pkg({ name: '@x/api', scripts: { start: 'node server.js' }, devDependencies: { '@x/core': '1' } }),
    'packages/notes/README.md': 'no manifest',
  });
  assert.deepEqual(got, [
    { name: 'api', path: 'packages/api', kind: 'service', dependsOn: [{ component: 'core', type: 'build' }] },
    { name: 'core', path: 'packages/core', kind: 'library', commands: { test: 'pnpm test', lint: 'pnpm lint', typecheck: 'pnpm typecheck' }, dependsOn: [] },
    { name: 'ui', path: 'packages/ui', kind: 'app', commands: { build: 'pnpm build', test: 'pnpm test', typecheck: 'pnpm check' }, dependsOn: [{ component: 'core', type: 'build' }] },
  ]);
  // npm writes `npm run`, and `{ packages }` is read like the array form.
  const npm = componentsWith({ 'package.json': pkg({ workspaces: { packages: ['libs/a'] } }), 'libs/a/package.json': pkg({ name: 'a', scripts: { test: 't' } }) });
  assert.deepEqual(npm, [{ name: 'a', path: 'libs/a', kind: 'library', commands: { test: 'npm run test' }, dependsOn: [] }]);
});

test('suggests components and build edges for Cargo workspace members', () => {
  const got = componentsWith({
    'Cargo.toml': '[workspace]\nmembers = ["crates/*", "tools/cli"]\n\n[workspace.dependencies]\nproto = { path = "crates/proto" }\nserde = "1"\n',
    'crates/core/Cargo.toml': '[package]\nname = "core"\n\n[dependencies]\nproto = { workspace = true }\nserde = { workspace = true }\n',
    'crates/core/src/lib.rs': '',
    'crates/proto/Cargo.toml': '[package]\nname = "proto"\n',
    'crates/proto/src/lib.rs': '',
    'crates/empty/README.md': 'no manifest',
    'tools/cli/Cargo.toml': '[package]\nname = "cli"\n\n[dev-dependencies]\ncore = { path = "../../crates/core", version = "0.1" }\noutside = { path = "../../../elsewhere" }\n',
    'tools/cli/src/main.rs': 'fn main() {}',
  });
  const cargo = { build: 'cargo build', test: 'cargo test', lint: 'cargo clippy -- -D warnings' };
  assert.deepEqual(got, [
    { name: 'core', path: 'crates/core', kind: 'library', commands: cargo, dependsOn: [{ component: 'proto', type: 'build' }] },
    { name: 'proto', path: 'crates/proto', kind: 'library', commands: cargo, dependsOn: [] },
    { name: 'cli', path: 'tools/cli', kind: 'service', commands: cargo, dependsOn: [{ component: 'core', type: 'build' }] },
  ]);
  const tauri = componentsWith({ 'Cargo.toml': '[workspace]\nmembers = ["app"]\n', 'app/Cargo.toml': '[dependencies]\ntauri = "2"\n', 'app/src/lib.rs': '' });
  assert.equal(tauri[0].kind, 'app');
  const bin = componentsWith({ 'Cargo.toml': '[workspace]\nmembers = ["x"]\n', 'x/Cargo.toml': '[[bin]]\nname = "x"\n', 'x/src/lib.rs': '' });
  assert.equal(bin[0].kind, 'service', 'a [[bin]] target is not a library');
});

test('suggests components and build edges for CMake subprojects', () => {
  const got = componentsWith({
    'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)\nproject(x)\nadd_subdirectory(lib)\nadd_subdirectory(app)\nadd_subdirectory(missing)\n',
    'lib/CMakeLists.txt': 'add_library(mylib STATIC src/a.cpp)\n',
    'app/CMakeLists.txt': 'add_executable(app main.cpp)\ntarget_link_libraries(app PRIVATE mylib fmt::fmt)\n',
  });
  assert.deepEqual(got, [
    { name: 'app', path: 'app', kind: 'app', dependsOn: [{ component: 'lib', type: 'build' }] },
    { name: 'lib', path: 'lib', kind: 'library', dependsOn: [] },
  ]);
});

test('component suggestions skip what they cannot read and always validate', () => {
  const got = componentsWith(
    {
      'package.json': pkg({ workspaces: ['apps/*', 'packages/**', 'libs/?', '!skip', 'one', 'broken', 'missing', '../outside'] }),
      'apps/web/package.json': pkg({ name: 'web' }),
      'one/web/package.json': pkg({ name: 'not-listed' }),
      'one/package.json': pkg({ name: 'one' }),
      'broken/package.json': '{ not json',
      'packages/deep/package.json': pkg({ name: 'deep' }),
      'libs/a/package.json': pkg({ name: 'la' }),
      'Cargo.toml': '[workspace]\nmembers = ["crates/web", "crates/**"]\n',
      'crates/web/Cargo.toml': '[package]\nname = "web"\n',
      'crates/web/src/lib.rs': '',
    },
    // A FIFO manifest would block a plain read; detection must pass it by.
    (dir) => {
      if (process.platform === 'win32') return;
      fs.mkdirSync(path.join(dir, 'apps', 'pipe'));
      execFileSync('mkfifo', [path.join(dir, 'apps', 'pipe', 'package.json')]);
    },
  );
  // Both `web`s fall back to their paths; the globs, the bad manifest and the missing member are skipped.
  assert.deepEqual(
    got.map((c) => [c.name, c.path]),
    [
      ['apps-web', 'apps/web'],
      ['crates-web', 'crates/web'],
      ['one', 'one'],
    ],
  );
  assert.deepEqual(componentsWith({ 'package.json': pkg({}) }), []);
  assert.deepEqual(componentsWith({}), []);
  // A name is sanitised to SAFE_REF, and a hostile 10k-character manifest line doesn't stall detection.
  const long = 'x'.repeat(10_000);
  const odd = componentsWith({
    'Cargo.toml': `[workspace]\nmembers = ["_we ird;dir"]\n`,
    '_we ird;dir/Cargo.toml': `[dependencies]\n${'a = {'.repeat(2000)}\n${long}= {${' '.repeat(10_000)}\n`,
  });
  assert.deepEqual(odd.map((c) => c.name), ['we-ird-dir']);
  // Hostile input where each pattern runs: unclosed `target_link_libraries(` calls in a subproject's
  // CMakeLists.txt, and a long blank-line run in a member Cargo.toml's [dependencies], which the tauri
  // and [[bin]] checks scan. Both stay under the size cap, and a quadratic scan of either takes seconds.
  const t0 = Date.now();
  const hostile = componentsWith({
    'Cargo.toml': `[workspace]\nmembers = ["crates/lib"]\n`,
    'crates/lib/Cargo.toml': `[package]\nname = "lib"\n[dependencies]\n${'\n'.repeat(200_000)}`,
    'crates/lib/src/lib.rs': '',
    'CMakeLists.txt': 'add_subdirectory(sub)\n',
    'sub/CMakeLists.txt': `add_library(sub sub.cpp)\n${'target_link_libraries('.repeat(30_000)}\n`,
  });
  // Round 1's quadratic scan took ~61 s here; 10 s leaves headroom for slow CI runners.
  assert.ok(Date.now() - t0 < 10_000, `detection took ${Date.now() - t0} ms on hostile manifests`);
  assert.deepEqual(
    hostile.map((c) => [c.name, c.kind, c.dependsOn]),
    [
      ['lib', 'library', []],
      ['sub', 'library', []],
    ],
  );
  // A member manifest over the size cap is skipped, not read.
  const big = componentsWith({
    'package.json': pkg({ workspaces: ['big', 'small'] }),
    'big/package.json': pkg({ name: 'big' }) + ' '.repeat(MAX_MANIFEST_BYTES),
    'small/package.json': pkg({ name: 'small' }),
  });
  assert.deepEqual(big.map((c) => c.name), ['small']);
  // Read only from the repo: a member reached through a symlink out of it is skipped.
  const repo = tempRepo();
  const outside = fs.mkdtempSync(path.join(path.dirname(repo.dir), 'forge-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'package.json'), pkg({ name: 'out' }));
    fs.symlinkSync(outside, path.join(repo.dir, 'linked'));
    assert.deepEqual(detectComponents(repo.dir, { pm: 'npm', ui: [], pkg: { workspaces: ['linked'] }, cargo: '' }), []);
  } finally {
    repo.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
