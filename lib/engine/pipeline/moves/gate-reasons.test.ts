// forge job gate's rules: each reason from job facts, every detail CLI-composed, in table order.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { jobAt, tempRepo } from '../../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { jobDir, logEvent, updateJob } from '#core/job/store.ts';
import type { Config, Job, ProtectedPaths } from '#core/types.ts';
import { memberWorktreePath } from '../../project/job-repos.ts';
import { computeGate, goModRequires, manifestChange, manifestKind, packageDeps, tomlDependencyLines, versionOf } from './gate-reasons.ts';

const OLD = '2020-01-01T00:00:00.000Z';
const flag = (n: number): ProtectedPaths => ({
  hits: Array.from({ length: n }, (_, i) => ({ path: `db/migrations/${String(i).padStart(4, '0')}.sql`, rule: 1, glob: 'db/migrations/**', reason: 'migration', blob: 'b'.repeat(40) })),
  more: 0,
  at: OLD,
  gate: 'verify',
  head: null,
});
const SPEC = ['# S', '', '## Acceptance criteria', '- [ ] AC1 — a', '- [ ] AC2 — b', '- [ ] AC3 — c', ''].join('\n');
const BUILD = ['## Round 1', '', '| AC | Proof | Result |', '|---|---|---|', '| AC1 | `t.test.ts` | pass |', '| AC3 | `t.test.ts` | fail |', ''].join('\n');

test('gate rules from job facts', () => {
  const repo = tempRepo();
  try {
    const config = defaults();
    const rows: { name: string; setup: (dir: string, id: string) => void; want: unknown[] }[] = [
      { name: 'no facts, no reasons', setup: () => {}, want: [] },
      {
        name: 'an unapproved flag lists at most 10 paths and counts all',
        setup: (_, id) => updateJob(repo.dir, id, (j) => void (j.protectedPaths = { ...flag(12), more: 3 })),
        want: [{ rule: 'protected-paths', detail: '15 escalate paths no person approved', paths: flag(10).hits.map((h) => h.path) }],
      },
      {
        name: "a person's approve at an escalation park listing protected-paths, after at, approves the flag",
        setup: (_, id) => {
          updateJob(repo.dir, id, (j) => void (j.protectedPaths = flag(1)));
          logEvent(repo.dir, id, 'transition', { from: { stage: 'pr', state: 'running', waitingOn: null }, to: { stage: 'pr', state: 'waiting', waitingOn: 'escalation' }, reason: 'escalation: protected-paths' });
          logEvent(repo.dir, id, 'human', { action: 'approve', actor: { login: 'alice', source: 'env' } });
        },
        want: [],
      },
      {
        name: 'a runbook that runs after merge is still a reason',
        setup: (dir) => fs.writeFileSync(path.join(dir, 'runbook.md'), '# Runbook\n\nWhen: after merge\n\n## Steps\n1. flip the flag\n'),
        want: [{ rule: 'runbook', detail: 'runbook.md has steps for a person' }],
      },
      { name: 'a blank runbook is not', setup: (dir) => fs.writeFileSync(path.join(dir, 'runbook.md'), '  \n\n'), want: [] },
      {
        name: 'acs names unmapped and failing ids',
        setup: (dir) => {
          fs.writeFileSync(path.join(dir, 'spec.md'), SPEC);
          fs.writeFileSync(path.join(dir, 'build.md'), BUILD);
        },
        want: [{ rule: 'acs', detail: 'unmapped: AC2; failing: AC3' }],
      },
      {
        name: 'reasons keep the table order',
        setup: (dir, id) => {
          fs.writeFileSync(path.join(dir, 'spec.md'), SPEC);
          fs.writeFileSync(path.join(dir, 'runbook.md'), 'steps\n');
          updateJob(repo.dir, id, (j) => void (j.protectedPaths = flag(1)));
        },
        want: ['protected-paths', 'runbook', 'acs'],
      },
    ];
    for (const r of rows) {
      const { id } = jobAt(repo.dir, 'decide', { config });
      r.setup(jobDir(repo.dir, id), id);
      const got = computeGate(repo.dir, config, id).reasons;
      const want = r.want.every((w) => typeof w === 'string') ? got.map((x) => x.rule) : got;
      assert.deepEqual(want, r.want, r.name);
    }
  } finally {
    repo.cleanup();
  }
});

test("lens-escalate reads each lens's latest review", () => {
  const repo = tempRepo();
  try {
    const config = defaults();
    const review = (summary: string, rest = '') => `## Verdict\nVERDICT: PASS\n\n## Summary\n${summary}\n\n## Findings\n${rest}\n`;
    const rows: { name: string; round: number; files: Record<string, string>; want: unknown[] }[] = [
      {
        name: 'narrowed panel: round 2 security escalated, round 3 re-ran only code',
        round: 3,
        files: { 'round-2/security.md': review('ESCALATE: auth change'), 'round-2/code.md': review('fine'), 'round-3/code.md': review('fine') },
        want: [{ rule: 'lens-escalate', detail: 'the security review of round 2 says ESCALATE' }],
      },
      { name: 'a later security file without it clears it', round: 3, files: { 'round-2/security.md': review('ESCALATE: auth change'), 'round-3/security.md': review('fixed') }, want: [] },
      { name: 'ESCALATE: outside the Summary', round: 1, files: { 'round-1/security.md': review('fine', 'ESCALATE: in findings') }, want: [] },
      { name: 'lowercase escalate:', round: 1, files: { 'round-1/security.md': review('escalate: maybe') }, want: [] },
      { name: 'only the integration review', round: 1, files: { 'integration/code.md': review('ESCALATE: conflicts') }, want: [] },
      { name: 'a round past the job round', round: 1, files: { 'round-2/code.md': review('ESCALATE: later') }, want: [] },
      {
        name: 'one reason per lens, in lens order, a member lens included',
        round: 1,
        files: { 'round-1/security.md': review('ESCALATE: a'), 'round-1/lib.realtime.md': review('ESCALATE: b'), 'round-1/code.md': review('ESCALATE: c') },
        want: ['code', 'lib:realtime', 'security'].map((l) => ({ rule: 'lens-escalate', detail: `the ${l} review of round 1 says ESCALATE` })),
      },
    ];
    for (const r of rows) {
      const { id } = jobAt(repo.dir, 'decide', { config });
      updateJob(repo.dir, id, (j) => void (j.round = r.round));
      for (const [rel, text] of Object.entries(r.files)) {
        const file = path.join(jobDir(repo.dir, id), 'review', rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      }
      assert.deepEqual(computeGate(repo.dir, config, id).reasons, r.want, r.name);
    }
  } finally {
    repo.cleanup();
  }
});

test('manifest rules', () => {
  const pkg = (o: Record<string, unknown>) => JSON.stringify(o, null, 2);
  const BASE = { name: 'x', version: '1.0.0', scripts: { test: 'node --test' }, dependencies: { a: '^1.0.0', b: '^2.0.0' }, devDependencies: { c: '1.0.0' } };
  const CARGO = '[package]\nname = "x"\ndescription = "old"\n\n[dependencies]\nserde = "1"\n\n[dev-dependencies]\nproptest = "1"\n';
  const PY = '[project]\nname = "x"\ndependencies = [\n  "requests>=2",\n  "rich",\n]\n\n[tool.poetry.group.dev.dependencies]\npytest = "^8"\n';
  const GO = 'module x\n\ngo 1.22\n\nrequire example.com/a v1.0.0\n\nrequire (\n\texample.com/b v1.2.0\n)\n';
  const hostile = 'x'.repeat(10_000);
  const rows: [string, string, string | null, string | null, { version: boolean; dependencies: boolean }][] = [
    ['a version bump is version only', 'package.json', pkg(BASE), pkg({ ...BASE, version: '1.1.0' }), { version: true, dependencies: false }],
    ['plugin.json version', '.claude-plugin/plugin.json', pkg({ version: '1.0.0' }), pkg({ version: '2.0.0' }), { version: true, dependencies: false }],
    ['a devDependencies change', 'packages/ui/package.json', pkg(BASE), pkg({ ...BASE, devDependencies: { c: '1.0.1' } }), { version: false, dependencies: true }],
    ['dependency keys reordered', 'package.json', pkg(BASE), pkg({ ...BASE, dependencies: { b: '^2.0.0', a: '^1.0.0' } }), { version: false, dependencies: false }],
    ['a scripts-only edit', 'package.json', pkg(BASE), pkg({ ...BASE, scripts: { test: 'vitest' } }), { version: false, dependencies: false }],
    ['an added package.json counts', 'tools/package.json', null, pkg({ version: '0.1.0', dependencies: { a: '1' } }), { version: true, dependencies: true }],
    ['an unparseable package.json after', 'package.json', pkg(BASE), '{ "version": ', { version: true, dependencies: true }],
    ['an unparseable package.json before', 'package.json', '[1, 2]', pkg(BASE), { version: true, dependencies: true }],
    ['Cargo [dev-dependencies]', 'Cargo.toml', CARGO, CARGO.replace('proptest = "1"', 'proptest = "1.4"'), { version: false, dependencies: true }],
    ["Cargo [target.'cfg(unix)'.dependencies]", 'crates/a/Cargo.toml', CARGO, `${CARGO}\n[target.'cfg(unix)'.dependencies]\nlibc = "0.2"\n`, { version: false, dependencies: true }],
    ['Cargo [workspace.dependencies]', 'Cargo.toml', '[workspace.dependencies]\ntokio = "1"\n', '[workspace.dependencies]\ntokio = "1.38"\n', { version: false, dependencies: true }],
    ['Cargo [package] description', 'Cargo.toml', CARGO, CARGO.replace('"old"', '"new"'), { version: false, dependencies: false }],
    ['pyproject [project] dependencies', 'pyproject.toml', PY, PY.replace('"rich",', '"rich>=13",'), { version: false, dependencies: true }],
    ['pyproject poetry dev group', 'pyproject.toml', PY, PY.replace('"^8"', '"^9"'), { version: false, dependencies: true }],
    ['go.mod require line', 'go.mod', GO, GO.replace('a v1.0.0', 'a v1.1.0'), { version: false, dependencies: true }],
    ['go.mod require block', 'go.mod', GO, GO.replace('b v1.2.0', 'b v1.3.0'), { version: false, dependencies: true }],
    ['go.mod replace', 'go.mod', GO, `${GO}\nreplace example.com/a => ../a\n`, { version: false, dependencies: true }],
    ['go.mod go directive', 'go.mod', GO, GO.replace('go 1.22', 'go 1.23'), { version: false, dependencies: false }],
    ['requirements-dev.txt', 'requirements-dev.txt', 'pytest==8\n', 'pytest==8\nruff==0.5\n', { version: false, dependencies: true }],
    ['a requirements comment', 'requirements.txt', 'pytest==8\n', '# pinned\npytest==8\n', { version: false, dependencies: false }],
    ['a 10k-character hostile line parses in linear time', 'Cargo.toml', `[${hostile}`, `[dependencies]\n${hostile}=`, { version: false, dependencies: true }],
  ];
  for (const [name, file, before, after, want] of rows) {
    const kind = manifestKind(file);
    assert.ok(kind, `${name}: ${file} is a manifest`);
    assert.deepEqual(manifestChange(kind!, before, after), want, name);
  }
  for (const lock of ['package-lock.json', 'Cargo.lock', 'go.sum', 'poetry.lock', 'yarn.lock']) assert.equal(manifestKind(lock), null, `${lock}: a lockfile-only change fires nothing`);
  // The pure parsers, directly.
  assert.equal(versionOf(null), null);
  assert.equal(versionOf('{"version":"1.0.0"}'), '"1.0.0"');
  assert.equal(packageDeps('{"dependencies":{"b":"1","a":"2"}}'), packageDeps('{"dependencies":{"a":"2","b":"1"}}'));
  assert.deepEqual(tomlDependencyLines('[dependencies]\nserde = "1"\n# note\n\n[package]\nname = "x"\n'), ['dependencies\tserde = "1"']);
  assert.deepEqual(goModRequires('require (\n\tb v1 // indirect\n\ta v2\n)\nrequire c v3\n'), ['require a v2', 'require b v1', 'require c v3']);
  assert.deepEqual(goModRequires(`require ${hostile}`), [`require ${hostile}`]);
});

/** A scratch repo with manifests on main, a job whose worktree is the repo itself on a branch of main. */
function branchJob(config: Config = defaults()) {
  const repo = tempRepo();
  const commit = (cwd: string, files: Record<string, string>, msg: string) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), text);
      repo.git('-C', cwd, 'add', '--', rel);
    }
    repo.git('-C', cwd, '-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', msg);
  };
  commit(repo.dir, { 'package.json': '{"version":"1.0.0","dependencies":{"a":"1"}}\n', '.claude-plugin/plugin.json': '{"version":"1.0.0"}\n' }, 'manifests');
  repo.git('checkout', '-q', '-b', 'forge/x');
  const { id } = jobAt(repo.dir, 'decide', { config });
  updateJob(repo.dir, id, (j) => {
    j.worktree = repo.dir;
    j.base = 'main';
  });
  return { repo, id, config, commit };
}

test('version and dependencies over a branch', () => {
  const rules = (root: string, config: Config, id: string) => computeGate(root, config, id).reasons.filter((r) => r.rule === 'version' || r.rule === 'dependencies');
  const s = branchJob();
  try {
    assert.deepEqual(rules(s.repo.dir, s.config, s.id), [], 'no commit on the branch: nothing changed');
    s.commit(s.repo.dir, { 'package.json': '{"version":"1.1.0","dependencies":{"a":"1"}}\n', '.claude-plugin/plugin.json': '{"version":"1.1.0"}\n', 'package-lock.json': '{}\n' }, 'bump');
    assert.deepEqual(rules(s.repo.dir, s.config, s.id), [{ rule: 'version', detail: 'version changed in 2 manifests', paths: ['.claude-plugin/plugin.json', 'package.json'] }]);
    s.commit(s.repo.dir, { 'package.json': '{"version":"1.0.0","dependencies":{"a":"2"}}\n', '.claude-plugin/plugin.json': '{"version":"1.0.0"}\n' }, 'deps');
    assert.deepEqual(rules(s.repo.dir, s.config, s.id), [{ rule: 'dependencies', detail: 'dependency tables changed in 1 manifest', paths: ['package.json'] }]);
    // A rename is a delete plus an add: the old path counts as removed, the new one as added.
    fs.mkdirSync(path.join(s.repo.dir, 'app'));
    s.repo.git('mv', 'package.json', 'app/package.json');
    s.repo.git('-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', 'move');
    assert.deepEqual(
      rules(s.repo.dir, s.config, s.id).map((r) => [r.rule, r.paths]),
      [
        ['version', ['app/package.json', 'package.json']],
        ['dependencies', ['app/package.json', 'package.json']],
      ],
    );
    // A base that doesn't resolve: both rules fail closed.
    updateJob(s.repo.dir, s.id, (j) => void (j.base = 'nope'));
    assert.deepEqual(rules(s.repo.dir, s.config, s.id), [
      { rule: 'version', detail: 'could not be checked in the root repo' },
      { rule: 'dependencies', detail: 'could not be checked in the root repo' },
    ]);
    // No worktree, no diff.
    updateJob(s.repo.dir, s.id, (j) => void (j.worktree = null));
    assert.deepEqual(rules(s.repo.dir, s.config, s.id), []);
  } finally {
    s.repo.cleanup();
  }
});

test("a member repo's manifest reads <repo>:<path>", () => {
  const REMOTE = 'https://example.com/lib.git';
  const config = defaults();
  config.repos = [{ name: 'lib', remote: REMOTE, defaultBranch: 'main' }] as Config['repos'];
  const s = branchJob(config);
  const lib = tempRepo();
  lib.git('remote', 'add', 'origin', REMOTE);
  fs.writeFileSync(path.join(s.repo.dir, '.forge', 'local.yml'), `repos:\n  lib:\n    path: ${path.relative(s.repo.dir, lib.dir)}\n`);
  const libWt = memberWorktreePath(s.repo.dir, config, 'lib', s.id);
  try {
    lib.git('worktree', 'add', '-q', '-b', `forge/${s.id}`, libWt);
    updateJob(s.repo.dir, s.id, (j) => {
      j.repos = [...j.repos.slice(0, 1), { repo: 'lib', worktree: libWt, branch: `forge/${s.id}`, base: 'main', pr: null, verifyOnly: false, interim: null }] as Job['repos'];
    });
    s.commit(libWt, { 'requirements.txt': 'ruff==0.5\n' }, 'deps');
    const got = computeGate(s.repo.dir, config, s.id).reasons.filter((r) => r.rule === 'dependencies');
    assert.deepEqual(got, [{ rule: 'dependencies', detail: 'dependency tables changed in 1 manifest', paths: ['lib:requirements.txt'] }]);
  } finally {
    s.repo.cleanup();
    lib.cleanup();
    fs.rmSync(path.dirname(libWt), { recursive: true, force: true });
  }
});
