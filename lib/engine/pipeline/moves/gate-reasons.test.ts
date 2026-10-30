// forge job gate's rules (each reason from job facts, every detail CLI-composed, in table order) and the escalation
// park's reason that lists them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { jobAt, tempRepo } from '../../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { jobDir, logEvent, updateJob } from '#core/job/store.ts';
import type { Config, Job, JobEvent, ProtectedPaths } from '#core/types.ts';
import { memberWorktreePath } from '../../project/job-repos.ts';
import { computeGate, goModRequires, manifestChange, manifestKind, packageDeps, summaryEscalates, tomlDependencyLines, versionOf } from './gate-reasons.ts';
import { escalationReason, parseEscalationReason, waitingGateReasons } from './escalation.ts';

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

test('the escalation park reason and its reasons', () => {
  assert.equal(escalationReason(['version', 'approver', 'runbook', 'version']), 'escalation: approver, runbook, version');
  const parse: [string, unknown, string[]][] = [
    ['the collapsed park', 'escalation: approver, runbook, version', ['approver', 'runbook', 'version']],
    ["PP1's held push", 'push held: escalation: approver, protected-paths', ['approver', 'protected-paths']],
    ['an unknown token lists nothing', 'escalation: approver, everything', []],
    ['legacy PR15', 'approver escalated: see decision.md', ['approver']],
    ['legacy PR16', 'runbook: steps before merge', ['runbook']],
    ['legacy PP1b', 'protected paths: db/migrations/0001.sql, +2 more', ['protected-paths']],
    ['legacy PP1', 'push held: protected paths: .github/workflows/ci.yml', ['protected-paths']],
    ['a release bump', 'release bump: verify failed after the release of repo lib 1.2.0', []],
    ['DC3', 'decision.md has no APPROVE/ESCALATE line', []],
    ['not a string', null, []],
    ['a 10k-character hostile reason', `escalation: ${'approver, '.repeat(1000)}`, []],
  ];
  for (const [name, reason, want] of parse) assert.deepEqual(parseEscalationReason(reason), want, name);
  // /api/state's gateReasons: the park's rules with the details of the gate event before it.
  const events = [
    { v: 1, ts: 't1', type: 'gate', round: 1, head: null, reasons: [{ rule: 'runbook', detail: 'runbook.md has steps for a person' }, { rule: 'bogus', detail: 'x' }] },
    { v: 1, ts: 't2', type: 'transition', from: { stage: 'pr', state: 'running', waitingOn: null }, to: { stage: 'pr', state: 'waiting', waitingOn: 'escalation' }, reason: 'escalation: approver, runbook' },
  ] as JobEvent[];
  const waiting = { state: 'waiting', waitingOn: 'escalation', reason: 'escalation: approver, runbook', protectedPaths: null } as const;
  assert.deepEqual(waitingGateReasons(waiting, events), [
    { rule: 'approver', detail: 'the approver escalated: see decision.md' },
    { rule: 'runbook', detail: 'runbook.md has steps for a person' },
  ]);
  assert.equal(waitingGateReasons({ ...waiting, state: 'running' }, events), null, 'not waiting');
  assert.equal(waitingGateReasons({ ...waiting, waitingOn: 'human' }, events), null, 'another gate');
  assert.equal(waitingGateReasons({ ...waiting, reason: 'touches auth' }, events), null, 'a reason that lists no rule');
});

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

test('a Summary says ESCALATE only inside ## Summary, in capitals', () => {
  const review = (summary: string, rest = '') => `## Verdict\nVERDICT: PASS\n\n## Summary\n${summary}\n\n## Findings\n${rest}\n`;
  assert.equal(summaryEscalates(review('ESCALATE: auth change')), true);
  assert.equal(summaryEscalates(review('fine', 'ESCALATE: in findings')), false, 'outside the Summary');
  assert.equal(summaryEscalates(review('escalate: maybe')), false, 'lowercase');
  assert.equal(summaryEscalates(null), false, 'no text');
});

test("lens-escalate reads each lens's latest review", () => {
  const repo = tempRepo();
  try {
    const config = defaults();
    const review = (summary: string) => `## Verdict\nVERDICT: PASS\n\n## Summary\n${summary}\n`;
    const ESCALATES = review('ESCALATE: auth change');
    // `recorded`: the `verdicts` events forge job verdicts logged, as round → {lens: Summary said ESCALATE}; `legacy`: events from
    // before `escalate` existed, as round → the lenses job.verdicts names; `files`: review files on disk, recorded or not.
    const rows: { name: string; round: number; recorded?: Record<number, Record<string, boolean>>; legacy?: Record<number, string[]>; files?: Record<string, string>; events?: [string, Record<string, unknown>][]; want: unknown[] }[] = [
      {
        name: 'narrowed panel: round 2 security escalated, round 3 re-ran only code',
        round: 3,
        recorded: { 2: { security: true, code: false }, 3: { code: false } },
        want: [{ rule: 'lens-escalate', detail: 'the security review of round 2 says ESCALATE' }],
      },
      { name: 'a later record of the lens without it clears it', round: 3, recorded: { 2: { security: true }, 3: { security: false } }, want: [] },
      { name: 'a review edited after it was recorded still escalates', round: 1, recorded: { 1: { security: true } }, files: { 'round-1/security.md': review('fixed') }, want: [{ rule: 'lens-escalate', detail: 'the security review of round 1 says ESCALATE' }] },
      // forge job verdicts can be run again for a round; a later record adds an ESCALATE but never takes one back.
      {
        name: 'a round recorded again with the file fixed keeps the ESCALATE',
        round: 2,
        recorded: { 1: { security: true } },
        events: [['verdicts', { round: 1, outcome: 'PASS', sha: null, escalate: { security: false } }]],
        want: [{ rule: 'lens-escalate', detail: 'the security review of round 1 says ESCALATE' }],
      },
      {
        name: 'a round recorded again without the lens keeps its ESCALATE',
        round: 2,
        recorded: { 1: { security: true, code: false } },
        events: [['verdicts', { round: 1, outcome: 'PASS', sha: null, escalate: { code: false } }]],
        want: [{ rule: 'lens-escalate', detail: 'the security review of round 1 says ESCALATE' }],
      },
      {
        name: 'a record from before `escalate` existed after a recorded one keeps the ESCALATE',
        round: 2,
        recorded: { 1: { security: true } },
        legacy: { 1: ['security'] },
        files: { 'round-1/security.md': review('fixed') },
        want: [{ rule: 'lens-escalate', detail: 'the security review of round 1 says ESCALATE' }],
      },
      {
        name: 'a clean file planted for a round the CLI never recorded changes nothing',
        round: 3,
        recorded: { 2: { security: true } },
        files: { 'round-3/security.md': review('fixed'), 'round-3/code.md': review('fine') },
        want: [{ rule: 'lens-escalate', detail: 'the security review of round 2 says ESCALATE' }],
      },
      { name: 'an escalating file for a lens that was not recorded is no reason', round: 1, recorded: { 1: { code: false } }, files: { 'round-1/security.md': ESCALATES, 'round-1/foo.md': ESCALATES }, want: [] },
      { name: 'only the integration review', round: 1, events: [['integration-review', { outcome: 'PASS', reviewers: { code: 'PASS' }, escalate: { code: true } }]], want: [] },
      { name: 'a round past the job round', round: 1, recorded: { 2: { code: true } }, want: [] },
      {
        name: 'one reason per lens, in lens order, a member lens included',
        round: 1,
        recorded: { 1: { security: true, 'lib:realtime': true, code: true } },
        want: ['code', 'lib:realtime', 'security'].map((l) => ({ rule: 'lens-escalate', detail: `the ${l} review of round 1 says ESCALATE` })),
      },
      {
        name: 'a record from before `escalate` existed falls back to the round file of each lens job.verdicts names',
        round: 2,
        legacy: { 1: ['security', 'code'] },
        files: { 'round-1/security.md': ESCALATES, 'round-1/code.md': review('fine'), 'round-1/foo.md': ESCALATES },
        want: [{ rule: 'lens-escalate', detail: 'the security review of round 1 says ESCALATE' }],
      },
    ];
    for (const r of rows) {
      const { id } = jobAt(repo.dir, 'decide', { config });
      updateJob(repo.dir, id, (j) => {
        j.round = r.round;
        for (const [n, lenses] of Object.entries(r.legacy ?? {})) j.verdicts[n] = Object.fromEntries(lenses.map((l) => [l, 'PASS'])) as Job['verdicts'][string];
      });
      for (const [n, escalate] of Object.entries(r.recorded ?? {})) logEvent(repo.dir, id, 'verdicts', { round: Number(n), outcome: 'PASS', sha: null, escalate });
      for (const n of Object.keys(r.legacy ?? {})) logEvent(repo.dir, id, 'verdicts', { round: Number(n), outcome: 'PASS', sha: null });
      for (const [type, fields] of r.events ?? []) logEvent(repo.dir, id, type, fields);
      for (const [rel, text] of Object.entries(r.files ?? {})) {
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
  // A closing bracket in a comment or a string inside a multi-line value must not end it early.
  const PY_COMMENT = '[project]\nname = "x"\ndependencies = [\n  "requests>=2",\n  # ] closes nothing\n  "rich", # ]\n]\n';
  const PY_STRING = '[project]\nname = "x"\ndependencies = [\n  "a ] b",\n  "rich",\n]\n';
  const CARGO_STRING = '[dependencies]\nserde = "1"\nnote = """\n[tool.x]\n"""\ntokio = "1"\n';
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
    // Every shape below once slipped past the parser; each must fire `dependencies`.
    ['pyproject: a comment holding a closing bracket does not end the dependencies array', 'pyproject.toml', PY_COMMENT, PY_COMMENT.replace('"rich", # ]', '"evil", # ]'), { version: false, dependencies: true }],
    ['pyproject: a string holding a closing bracket does not end the dependencies array', 'pyproject.toml', PY_STRING, PY_STRING.replace('"rich"', '"evil"'), { version: false, dependencies: true }],
    ['pyproject: a trailing comment edit alone changes nothing', 'pyproject.toml', PY_COMMENT, PY_COMMENT.replace('# ] closes nothing', '# still nothing'), { version: false, dependencies: false }],
    ['Cargo: an inline dependencies table at the root', 'Cargo.toml', 'dependencies = { serde = "1" }\n\n[package]\nname = "x"\n', 'dependencies = { serde = "1", evil = "1" }\n\n[package]\nname = "x"\n', { version: false, dependencies: true }],
    ['Cargo: a dotted dependencies key at the root', 'Cargo.toml', 'dependencies.serde = "1"\n\n[package]\nname = "x"\n', 'dependencies.serde = "2"\n\n[package]\nname = "x"\n', { version: false, dependencies: true }],
    ['Cargo: a dotted target key holding the dependencies word', 'Cargo.toml', "[package]\nname = \"x\"\ntarget.'cfg(unix)'.dependencies.libc = \"0.2\"\n", "[package]\nname = \"x\"\ntarget.'cfg(unix)'.dependencies.libc = \"0.3\"\n", { version: false, dependencies: true }],
    ['pyproject: an inline dependencies table under [tool.poetry]', 'pyproject.toml', '[tool.poetry]\nname = "x"\ndependencies = { python = "^3.11" }\n', '[tool.poetry]\nname = "x"\ndependencies = { python = "^3.11", evil = "1" }\n', { version: false, dependencies: true }],
    ['pyproject: optional-dependencies as dotted keys', 'pyproject.toml', '[project]\noptional-dependencies.dev = [\n  "pytest",\n]\n', '[project]\noptional-dependencies.dev = [\n  "pytest",\n  "evil",\n]\n', { version: false, dependencies: true }],
    ['pyproject: an unrelated inline table under [tool] changes nothing', 'pyproject.toml', '[tool.x]\nopts = { a = 1 }\n', '[tool.x]\nopts = { a = 2 }\n', { version: false, dependencies: false }],
    // A multi-line string in a dependency table can hold a `[table]` line; the lines after it are still that table's.
    ['Cargo: a [table] line inside a """ string does not end [dependencies]', 'Cargo.toml', CARGO_STRING, CARGO_STRING.replace('tokio = "1"', 'tokio = "2"'), { version: false, dependencies: true }],
    ["Cargo: the same inside a ''' string", 'Cargo.toml', CARGO_STRING.replaceAll('"""', "'''"), CARGO_STRING.replaceAll('"""', "'''").replace('tokio = "1"', 'tokio = "2"'), { version: false, dependencies: true }],
    ['Cargo: a multi-line string outside the dependency tables changes nothing', 'Cargo.toml', '[package]\ndescription = """\nold [x]\n"""\n', '[package]\ndescription = """\nnew [x]\n"""\n', { version: false, dependencies: false }],
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
  assert.deepEqual(tomlDependencyLines('dependencies = { a = "1" } # x\n[package]\nname = "x"\n'), ['\tdependencies = { a = "1" }'], 'a root key, its comment dropped');
  assert.deepEqual(tomlDependencyLines('[project]\ndependencies = [\n  "a", # ]\n  # ]\n  "b",\n]\nname = "x"\n'), ['project\t"a",', 'project\t"b",', 'project\t]', 'project\tdependencies = ['].sort(), 'comments close nothing');
  assert.deepEqual(tomlDependencyLines(CARGO_STRING), ['dependencies\tserde = "1"', 'dependencies\tnote = """', 'dependencies\t[tool.x]', 'dependencies\t"""', 'dependencies\ttokio = "1"'].sort(), 'a string line is content');
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
