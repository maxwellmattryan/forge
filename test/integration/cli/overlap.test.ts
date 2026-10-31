// `forge overlap` through the CLI: the gh adapter reads a fake gh, so the spawned test proves the command
// writes only its report and starts no agent, and the in-process rows check subject resolution and refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BIN, cliEnv, fakeBin, fakeGh, forgeAsync, forgeInProcess, ghPr, jobAt, repoTemplate } from '../../helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { OVERLAP_SCHEMA_VERSION } from '#core/versions/overlap.ts';
import { REASON_SENTENCES } from '../../../lib/cli/commands/render/overlap.ts';

const HISTORY = JSON.stringify({ data: { repository: { ref: { target: { history: { pageInfo: { hasNextPage: false }, nodes: [] } } } } } });
const udiff = (file: string, line: number) => `diff --git a/${file} b/${file}\nindex 1..2 100644\n--- a/${file}\n+++ b/${file}\n@@ -${line} +${line} @@\n-old\n+new\n`;

/** A Forge-initialised repo (tracker o/r) whose main has lib/a.ts with 30 lines. */
const initRepo = repoTemplate((dir) => {
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'a.ts'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  const answers = path.join(dir, '..', `answers-${path.basename(dir)}.json`);
  fs.writeFileSync(answers, JSON.stringify({ tracker: { github: { repo: 'o/r' } } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: cliEnv(dir), stdio: 'pipe' });
  fs.rmSync(answers, { force: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('add', '-A');
  git('commit', '-qm', 'forge');
});

function scenario() {
  const repo = initRepo();
  const config = loadConfig(repo.dir).config;
  const edit = (branch: string, line: number) => {
    repo.git('checkout', '-q', '-b', branch, 'main');
    const f = path.join(repo.dir, 'lib', 'a.ts');
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines[line - 1] = `changed on ${branch}`;
    fs.writeFileSync(f, lines.join('\n'));
    repo.git('commit', '-qam', `edit ${line}`);
    repo.git('checkout', '-q', 'main');
  };
  const job = (title: string, line: number | null) => {
    const j = jobAt(repo.dir, 'build', { config, title });
    if (line !== null) edit(j.branch!, line);
    return j;
  };
  return { ...repo, config, job };
}

/** Every file under `dir` outside .forge/runtime/, as path → size and mtime. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full);
      if (rel === path.join('.forge', 'runtime') || rel.startsWith(path.join('.forge', 'runtime') + path.sep)) continue;
      const st = fs.lstatSync(full);
      if (e.isDirectory()) walk(full);
      else out[rel] = `${st.size}:${st.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

test('forge overlap writes only its report and runs no agent', { skip: process.platform === 'win32' }, async () => {
  const s = scenario();
  const gh = fakeGh({ 'pr list': '[]', 'api graphql': HISTORY });
  const claude = fakeBin('claude', 'exit 0');
  try {
    const a = s.job('job a', 5);
    const b = s.job('job b', 5);
    const env = { PATH: `${claude.dir}${path.delimiter}${gh.dir}${path.delimiter}${process.env.PATH}` };
    const worktrees = `${s.dir}.worktrees`;
    const before = [snapshot(s.dir), snapshot(worktrees)];
    const r = await forgeAsync(s.dir, ['overlap', a.id], env);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.timing, { kind: 'merge-first', refs: [b.id] });
    assert.deepEqual(out.counterparts, [{ kind: 'job', ref: b.id, source: 'diff', human: false, stage: 'build', files: ['lib/a.ts'], fileCount: 1, sharedHunks: 1 }]);
    assert.equal(out.report, `.forge/runtime/overlap/jobs/${a.id}.json`);
    const report = JSON.parse(fs.readFileSync(path.join(s.dir, out.report), 'utf8'));
    assert.equal(report.schemaVersion, OVERLAP_SCHEMA_VERSION);
    const human = await forgeAsync(s.dir, ['overlap', a.id, '--mode', 'human'], env);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, new RegExp(`^merge-first: ${b.id}`));
    assert.ok(human.stdout.includes(REASON_SENTENCES['job-building']), human.stdout);
    assert.deepEqual([snapshot(s.dir), snapshot(worktrees)], before);
    assert.deepEqual(claude.calls(), []);
    assert.ok(gh.calls().every((c) => ['pr list', 'api graphql'].includes(c.args.slice(0, 2).join(' '))), JSON.stringify(gh.calls().map((c) => c.args.slice(0, 2))));
  } finally {
    fs.rmSync(gh.dir, { recursive: true, force: true });
    s.cleanup();
  }
});

test('subject resolution and errors', { skip: process.platform === 'win32' }, async () => {
  const s = scenario();
  const a = s.job('job a', 5);
  const bare = s.job('no diff yet', null);
  const pr = (over: Record<string, unknown>) => ghPr({ files: [{ path: 'docs/x.md' }], changedFiles: 1, createdAt: '2026-10-30T00:00:00Z', commits: [], ...over });
  const twelve = pr({ number: 12, url: 'https://github.com/o/r/pull/12', headRefName: 'feature/docs' });
  const gh = fakeGh({
    'pr view 12': JSON.stringify(twelve),
    'pr view 13': JSON.stringify(pr({ number: 13, state: 'CLOSED', headRefName: 'old' })),
    'pr view 14': JSON.stringify(pr({ number: 14, headRefName: a.branch })),
    'pr view 99': { stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 99. (repository.pullRequest)\n', status: 1 },
    'pr list': JSON.stringify([twelve]),
    'pr diff 12': udiff('docs/x.md', 1),
    'api graphql': HISTORY,
  });
  const env = { PATH: `${gh.dir}${path.delimiter}${process.env.PATH}` };
  const run = (...args: string[]) => forgeInProcess(s.dir, ['overlap', ...args], { env });
  try {
    const hash = await run('#12');
    const flag = await run('--pr', '12');
    assert.equal(hash.status, 0, JSON.stringify(hash.error));
    assert.deepEqual(flag.data, hash.data);
    assert.deepEqual((hash.data as any).subject, { kind: 'pr', ref: '#12', source: 'diff', files: 1 });
    assert.equal((hash.data as any).report, '.forge/runtime/overlap/prs/12.json');
    assert.equal((hash.data as any).timing.kind, 'merge-now');

    const viaJob = await run('#14');
    assert.equal(viaJob.status, 0, JSON.stringify(viaJob.error));
    assert.deepEqual((viaJob.data as any).subject.ref, a.id);
    assert.equal((viaJob.data as any).report, `.forge/runtime/overlap/jobs/${a.id}.json`);

    const refusals: [string[], string][] = [
      [['no-such-job'], 'not_found'],
      [['#13'], 'not_found'],
      [['#99'], 'not_found'],
      [['--pr', 'abc'], 'usage'],
      [['--pr', '0'], 'usage'],
      [['--pr'], 'usage'],
      [['#1x'], 'usage'],
      [[a.id, '--pr', '12'], 'usage'],
      [[], 'usage'],
      [[bare.id], 'failed'],
    ];
    for (const [args, code] of refusals) {
      const r = await run(...args);
      assert.equal(r.error?.code, code, `${args.join(' ')}: ${JSON.stringify(r.error)}`);
    }
    assert.match((await run('#13')).error!.message, /PR #13 is not open in o\/r/);
  } finally {
    fs.rmSync(gh.dir, { recursive: true, force: true });
    s.cleanup();
  }
});
