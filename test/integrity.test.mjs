import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo } from './helpers.mjs';
import { defaults } from '../lib/config.mjs';
import { commandSources, compactIntegrity, countTestDecls, devDepsSection, isConfigPath, markerHits, packageJsonDetail, renderIntegrity, testIntegrity } from '../lib/integrity.mjs';

const commitAll = (cwd, msg) => {
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', msg], { cwd });
};
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

test('markerHits: skip and focus markers, scoped to test files where the spelling is ambiguous', () => {
  const hit = (p, line, isTest = true) => markerHits(p, line, isTest);
  assert.equal(hit('test/a.test.mjs', "  it.skip('works', () => {"), true);
  assert.equal(hit('test/a.test.mjs', "describe.only('x', () => {"), true);
  assert.equal(hit('test/a.test.mjs', "test.todo('later')"), true);
  assert.equal(hit('test/a.test.mjs', "test('slow', { skip: true }, () => {"), true);
  assert.equal(hit('test/a.test.mjs', "test('flaky', { todo: 'fix' }, () => {"), true);
  assert.equal(hit('test/a.test.mjs', "  xit('pending', () => {"), true);
  assert.equal(hit('test/a.test.mjs', "fdescribe('focus', () => {"), true);
  assert.equal(hit('pkg/a_test.go', '\tt.Skip("flaky on CI")'), true);
  assert.equal(hit('pkg/a_test.go', '\tt.Skipf("no %s", x)'), true);
  assert.equal(hit('src/test/FooTest.java', '  @Disabled'), true);
  assert.equal(hit('tests/test_a.py', '@pytest.mark.skip(reason="later")'), true);
  assert.equal(hit('app/helpers.py', '@pytest.mark.xfail', false), true, 'pytest markers count in any file');
  assert.equal(hit('src/lib.rs', '    #[ignore]', false), true, '#[ignore] counts in any .rs file');
  assert.equal(hit('src/lib.rs', '    #[ignore = "slow"]', false), true);

  assert.equal(hit('src/lib.rs', '    let rest = rows.skip(1);', false), false, 'a Rust iterator skip in a non-test file');
  assert.equal(hit('tests/x.rs', '    let rest = rows.skip(1);'), false, 'and in a test file');
  assert.equal(hit('lib/a.mjs', "it.skip('x')", false), false, 'JS markers outside test files are not findings');
  assert.equal(hit('test/a.test.mjs', "test('skips nothing', () => {"), false);
  assert.equal(hit('test/a.test.mjs', 'const opts = { skipped: true };'), false);
  assert.equal(hit('test/a.test.mjs', 'const latest = list.skip;'), false);
});

test('countTestDecls: JS, Python, Rust and Go', () => {
  const js = ["test('a', () => {});", "  it('b', () => {});", "  it.skip('c', () => {});", "describe('d', () => {", "  t.test('e', () => {});", "const test2 = test;"].join('\n');
  assert.equal(countTestDecls(js), 4, 'skipped tests still count; describe does not');
  const py = ['def test_one():', '    pass', 'async def test_two():', '    pass', 'def helper():', '    pass', '  def test_method(self):'].join('\n');
  assert.equal(countTestDecls(py), 3);
  const rs = ['#[test]', 'fn a() {}', '#[tokio::test]', 'async fn b() {}', '#[ignore]', '#[test]', 'fn c() {}', '#[cfg(test)]'].join('\n');
  assert.equal(countTestDecls(rs), 3);
  const go = ['func TestA(t *testing.T) {}', 'func TestB(t *testing.T) {}', 'func helper() {}', 'func BenchmarkA(b *testing.B) {}'].join('\n');
  assert.equal(countTestDecls(go), 2);
  assert.equal(countTestDecls(''), 0);
});

test('devDepsSection: changes only when dev-dependencies change', () => {
  const base = ['[package]', 'name = "x"', '', '[dependencies]', 'serde = "1"', '', '[dev-dependencies]', 'proptest = "1"', '', "[target.'cfg(unix)'.dev-dependencies]", 'nix = "0.27"', '', '[[bin]]', 'name = "y"'].join('\n');
  const depsBumped = base.replace('serde = "1"', 'serde = "1.0.200"').replace('name = "x"', 'name = "z"');
  assert.equal(devDepsSection(base), devDepsSection(depsBumped), 'regular deps and package metadata do not count');
  assert.notEqual(devDepsSection(base), devDepsSection(base.replace('proptest = "1"', 'proptest = "2"')));
  assert.notEqual(devDepsSection(base), devDepsSection(base.replace('nix = "0.27"', 'nix = "0.28"')), 'target-specific dev-deps count');
  assert.notEqual(devDepsSection(base), devDepsSection(`${base}\n[dev-dependencies.criterion]\nversion = "0.5"\n`), 'dotted dev-deps tables count');
  assert.equal(devDepsSection('[package]\nname = "x"\n'), '');
});

test('packageJsonDetail: scripts and runner keys only', () => {
  const a = JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node --test', build: 'tsc' } });
  assert.equal(packageJsonDetail(a, a.replace('1.0.0', '1.0.1')), null, 'a version bump is not a test-config edit');
  assert.equal(packageJsonDetail(a, JSON.stringify({ name: 'x', scripts: { test: 'true', lint: 'eslint' } })), 'scripts changed: build, lint, test');
  assert.equal(packageJsonDetail(a, JSON.stringify({ name: 'x', scripts: { test: 'node --test', build: 'tsc' }, jest: { bail: true } })), 'jest config changed');
  assert.equal(packageJsonDetail('', JSON.stringify({ scripts: { test: 'x' } })), 'scripts changed: test', 'an added package.json counts as {} before');
  assert.equal(packageJsonDetail('', JSON.stringify({ name: 'x' })), null);
  assert.equal(packageJsonDetail('{ nope', a), 'edited (unparseable)');
});

test('commandSources: script files the commands run, never their arguments', () => {
  const cfg = (commands, services = []) => ({ commands, services });
  assert.deepEqual(commandSources(cfg({ test: './scripts/test.sh && npm test' })), ['scripts/test.sh']);
  assert.deepEqual(commandSources(cfg({ ci: 'FOO=1 node scripts/ci.mjs --x' })), ['scripts/ci.mjs']);
  assert.deepEqual(commandSources(cfg({ test: 'python -u tools/run.py | tee out.log' })), ['tools/run.py']);
  assert.deepEqual(
    commandSources(cfg({ test: 'npm run test', lint: 'for f in lib/*.mjs lib/commands/*.mjs bin/forge; do node --check "$f" || exit 1; done && claude plugin validate . --strict', build: null })),
    [],
    "Forge's own commands name no script files",
  );
  assert.deepEqual(commandSources(cfg({}, [{ name: 'api', path: 'services/api', commands: { test: 'bash ./run-tests.sh', dev: 'go run .' } }])), ['services/api/run-tests.sh']);
});

test('isConfigPath: CI anchored at the root, build and runner config anywhere', () => {
  for (const p of ['.github/workflows/ci.yml', '.gitlab-ci.yml', '.circleci/config.yml', 'Jenkinsfile', 'Makefile', 'pkg/rules.mk', 'web/justfile', 'web/jest.config.ts', 'vitest.workspace.js', '.mocharc.yml', 'tox.ini', '.forge/config.yml']) {
    assert.equal(isConfigPath(p), true, p);
  }
  for (const p of ['docs/.github/workflows/ci.yml', 'sub/Jenkinsfile', 'sub/.forge/config.yml', 'lib/make.mjs', 'README.md', 'package.json']) {
    assert.equal(isConfigPath(p), false, p);
  }
});

test('testIntegrity: moving a skip is not a finding; an added #[ignore] is; an unresolvable base is an error', () => {
  const repo = tempRepo();
  try {
    write(repo.dir, 'test/a.test.mjs', ["test('one', () => {});", "it.skip('two', () => {});", "test('three', () => {});", ''].join('\n'));
    write(repo.dir, 'src/iter.rs', 'fn f() {}\n');
    commitAll(repo.dir, 'base');
    repo.git('checkout', '-qb', 'job');
    const config = defaults();
    const job = { id: 'job', worktree: repo.dir, base: 'main' };

    let r = testIntegrity(repo.dir, config, job);
    assert.equal(r.error, undefined);
    assert.equal(r.findings, 0, 'no commits beyond base: empty report');
    assert.deepEqual([r.count.before, r.count.after], [0, 0]);
    assert.match(renderIntegrity(r), /^## integrity: ok\n/);

    write(repo.dir, 'test/a.test.mjs', ["it.skip('two', () => {});", "test('one', () => {});", "test('three', () => {});", ''].join('\n'));
    write(repo.dir, 'src/iter.rs', 'fn f() { let x = rows.skip(1); }\n');
    commitAll(repo.dir, 'move the skip');
    r = testIntegrity(repo.dir, config, job);
    assert.equal(r.markers.length, 0, 'one removed and one added skip line is a move');
    assert.equal(r.findings, 0);
    assert.equal(r.count.delta, 0);

    write(repo.dir, 'src/iter.rs', 'fn f() { let x = rows.skip(1); }\n#[ignore]\nfn g() {}\n');
    commitAll(repo.dir, 'ignore');
    r = testIntegrity(repo.dir, { ...config, verifyIntegrity: 'block' }, job);
    assert.deepEqual(r.markers.map((m) => `${m.path}:${m.line}`), ['src/iter.rs:2']);
    assert.equal(r.blocking, 1);
    assert.equal(r.ok, false);
    assert.match(renderIntegrity(r), /^## integrity: FAILED \(1 blocking\)/);
    assert.deepEqual(compactIntegrity(r).skipMarkers, ['src/iter.rs:2']);

    const missing = { ...job, base: 'no-such-branch' };
    r = testIntegrity(repo.dir, config, missing);
    assert.match(r.error, /no-such-branch/);
    assert.equal(r.ok, true, 'warn passes on an error');
    assert.deepEqual(compactIntegrity(r), { mode: 'warn', ok: true, error: r.error });
    r = testIntegrity(repo.dir, { ...config, verifyIntegrity: 'block' }, missing);
    assert.equal(r.ok, false, 'block fails on an error');
    assert.match(renderIntegrity(r), /^## integrity: error[\s\S]*no-such-branch/);

    r = testIntegrity(repo.dir, { ...config, evals: { testPattern: '(' } }, job);
    assert.match(r.error, /invalid evals\.testPattern/);
  } finally {
    repo.cleanup();
  }
});

test('testIntegrity: renames, config edits and capped JSON lists', () => {
  const repo = tempRepo();
  try {
    for (let i = 0; i < 12; i++) write(repo.dir, `test/t${i}.test.mjs`, "test('x', () => {});\n");
    write(repo.dir, 'test/keep.test.mjs', "test('a', () => {});\ntest('b', () => {});\n");
    write(repo.dir, 'Cargo.toml', '[package]\nname = "x"\n\n[dev-dependencies]\nproptest = "1"\n');
    write(repo.dir, 'scripts/test.sh', 'echo hi\n');
    commitAll(repo.dir, 'base');
    repo.git('checkout', '-qb', 'job');
    for (let i = 0; i < 12; i++) fs.rmSync(path.join(repo.dir, `test/t${i}.test.mjs`));
    repo.git('mv', 'test/keep.test.mjs', 'test/kept.test.mjs');
    write(repo.dir, 'Cargo.toml', '[package]\nname = "y"\n\n[dev-dependencies]\nproptest = "2"\n');
    write(repo.dir, 'scripts/test.sh', 'echo bye\n');
    write(repo.dir, 'test has space.test.mjs', "it.only('x', () => {});\n");
    commitAll(repo.dir, 'change');
    const config = { ...defaults(), commands: { ...defaults().commands, test: './scripts/test.sh' } };
    const r = testIntegrity(repo.dir, config, { id: 'job', worktree: repo.dir, base: 'main' });
    assert.equal(r.error, undefined);
    assert.equal(r.deleted.length, 12);
    assert.deepEqual(r.renamed, [{ from: 'test/keep.test.mjs', to: 'test/kept.test.mjs' }]);
    assert.deepEqual(r.markers.map((m) => `${m.path}:${m.line}`), ['test has space.test.mjs:1'], 'paths with spaces parse');
    assert.deepEqual(
      r.configEdits.map((e) => `${e.path}: ${e.detail}`),
      ['Cargo.toml: [dev-dependencies] changed', 'scripts/test.sh: edited'],
    );
    assert.deepEqual(r.count, { before: 14, after: 3, delta: -11, files: r.count.files });
    assert.equal(r.findings, 12 + 1 + 1 + 2 + 1);
    const c = compactIntegrity(r);
    assert.equal(c.deletedTests.length, 10);
    assert.equal(c.more, 2);
    const md = renderIntegrity(r);
    assert.match(md, /^## integrity: WARN \(17 findings\)/);
    assert.equal((md.match(/^- `test\/t\d+\.test\.mjs`$/gm) ?? []).length, 12, 'the markdown lists everything');
    assert.match(md, /```text\ntest has space\.test\.mjs:1: it\.only\('x', \(\) => \{\}\);\n```/);
  } finally {
    repo.cleanup();
  }
});
