// Downstream verification in `forge verify` (issue #186): each consumer's tests run against the
// root worktree through its cmake link, a break is reported against the consumer that saw it, and a
// consumer without an active link fails instead of testing the released library.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { downstreamProject } from './downstream-fixture.ts';
import type { DownstreamProject } from './downstream-fixture.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

/** A job on the project with both consumers added downstream, its worktrees created and a round started. */
async function started(opts: { downstream?: boolean } = {}) {
  const p = await downstreamProject();
  cleanups.push(p.cleanup);
  const j = await p.f('job', 'new', '--title', `core change ${Math.random().toString(36).slice(2, 8)}`);
  if (opts.downstream === false) await p.f('job', 'repo', 'add', '--verify-only', j.id, 'app-a');
  else assert.deepEqual((await p.f('job', 'repo', 'downstream', j.id)).added, ['app-a', 'app-b']);
  await p.f('worktree', 'create', j.id);
  await p.f('job', 'round', j.id);
  return { p, id: j.id as string, wt: p.worktree(j.id) };
}

function commit(p: DownstreamProject, cwd: string, change: (dir: string) => void, msg: string) {
  change(cwd);
  p.git(cwd, 'add', '-A');
  p.git(cwd, '-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', msg);
}

async function verify(p: DownstreamProject, id: string) {
  const r = await p.raw(['verify', id]);
  const out = JSON.parse(r.stdout);
  const report = fs.readFileSync(path.join(p.root, out.file), 'utf8');
  return { status: r.status, out, report };
}

/** The report section of one member, from its header to the next. */
const section = (report: string, header: string) => {
  const start = report.indexOf(header);
  assert.ok(start >= 0, `report has ${header}`);
  const next = report.indexOf('\n# ', start + header.length);
  return report.slice(start, next < 0 ? undefined : next);
};

describe('downstream verification: verify', { concurrency: 4 }, () => {
  test('changing a library used by two consumers runs both; a break in either is reported against it', async () => {
    const { p, id, wt } = await started();
    commit(p, wt, (d) => fs.writeFileSync(path.join(d, 'core', 'core.txt'), 'core v2\n'), 'feat: core v2');
    let v = await verify(p, id);
    assert.equal(v.status, 0, v.report);
    assert.equal(v.out.ok, true);
    assert.deepEqual(v.out.downstream, [{ repo: 'app-a', ok: true, failure: null }, { repo: 'app-b', ok: true, failure: null }]);
    for (const repo of ['app-a', 'app-b']) assert.match(section(v.report, `# Downstream consumer ${repo} · `), /^## test: ok$/m);
    assert.doesNotMatch(v.report, /^# Repo /m);

    // A break only consumer A sees: staged in the root worktree, so A read the job's library, not the released one.
    for (const [broken, fine] of [['app-a', 'app-b'], ['app-b', 'app-a']]) {
      commit(p, wt, (d) => {
        for (const f of fs.readdirSync(path.join(d, 'core'))) if (f.startsWith('BREAK-')) fs.rmSync(path.join(d, 'core', f));
        fs.writeFileSync(path.join(d, 'core', `BREAK-${broken}`), 'x\n');
      }, `break ${broken}`);
      assert.equal(fs.existsSync(path.join(p.root, 'core', `BREAK-${broken}`)), false, 'the main checkout has no break');
      v = await verify(p, id);
      assert.equal(v.out.ok, false, broken);
      assert.deepEqual(v.out.downstream, [
        { repo: broken, ok: false, failure: 'test' },
        { repo: fine, ok: true, failure: null },
      ].sort((a, b) => (a.repo < b.repo ? -1 : 1)));
      assert.match(v.report, /^VERIFY: FAIL$/m);
      const lines = v.report.split('\n');
      assert.equal(lines[2].startsWith('Round '), true);
      assert.equal(lines[4], `Downstream consumer \`${broken}\` failed \`test\`: fix the library on this job, or propose changing the consumer: forge job repo propose ${id} ${broken} --reason "…"`);
      assert.doesNotMatch(v.report, new RegExp(`Downstream consumer \`${fine}\` failed`));
      assert.match(section(v.report, `# Downstream consumer ${broken} · `), /^## test: FAILED \(exit 1\)$/m);
      assert.match(section(v.report, `# Downstream consumer ${fine} · `), /^## test: ok$/m);
    }

    // No break: verify passes again.
    commit(p, wt, (d) => {
      for (const f of fs.readdirSync(path.join(d, 'core'))) if (f.startsWith('BREAK-')) fs.rmSync(path.join(d, 'core', f));
    }, 'fix');
    v = await verify(p, id);
    assert.equal(v.out.ok, true, v.report);
  });

  test('a break is reported against that consumer', async () => {
    const { p, id, wt } = await started();
    commit(p, wt, (d) => fs.writeFileSync(path.join(d, 'core', 'BREAK-app-b'), 'x\n'), 'break b');
    const v = await verify(p, id);
    assert.equal(v.out.ok, false);
    assert.equal(v.out.failure.name, 'test');
    assert.deepEqual(v.out.downstream.find((d: any) => !d.ok), { repo: 'app-b', ok: false, failure: 'test' });
    assert.match(v.report, /^# Downstream consumer app-b · [0-9a-f]{12}$/m);
    assert.match(v.report, /^Downstream consumer `app-b` failed `test`: fix the library on this job/m);
    // The stored run keeps its shape: repos records, no downstream field.
    const job = JSON.parse(fs.readFileSync(p.jobFile(id), 'utf8'));
    const run = job.verifyRuns.at(-1);
    assert.equal('downstream' in run, false);
    assert.deepEqual(run.repos.map((r: any) => [r.repo, r.ok, r.failure]), [['app-a', true, null], ['app-b', false, 'test']]);
    assert.equal(run.failure, 'test');
    // V3 names it.
    await p.f('job', 'set', id, '--stage', 'verify');
    const s = await p.f('job', 'step', id);
    assert.equal(s.rule, 'V3');
    assert.equal(s.why, 'verify failed: downstream consumer app-b failed test');
  });

  test('a verify-only repo a human added is not named a downstream consumer', async () => {
    const { p, id, wt } = await started({ downstream: false });
    commit(p, wt, (d) => fs.writeFileSync(path.join(d, 'core', 'core.txt'), 'core v2\n'), 'feat: core v2');
    const v = await verify(p, id);
    assert.equal(v.out.ok, true, v.report);
    assert.equal('downstream' in v.out, false);
    assert.match(v.report, /^# Repo app-a · /m);
    assert.doesNotMatch(v.report, /Downstream consumer/);
  });

  test('a downstream consumer without an active link fails verify', async () => {
    const { p, id, wt } = await started();
    // app-a's link now points at a directory the root worktree lacks: inactive, so it would test the released library.
    p.config((c) => {
      const a = c.components.find((x: any) => x.repo === 'app-a');
      a.dependsOn[0].link.path = 'no-such-dir';
    });
    commit(p, wt, (d) => fs.writeFileSync(path.join(d, 'core', 'core.txt'), 'core v2\n'), 'feat: core v2');
    const v = await verify(p, id);
    assert.equal(v.out.ok, false);
    assert.deepEqual(v.out.downstream, [{ repo: 'app-a', ok: false, failure: 'links' }, { repo: 'app-b', ok: true, failure: null }]);
    const a = section(v.report, '# Downstream consumer app-a · ');
    assert.match(a, /^## links: FAILED$/m);
    assert.match(a, /^- cmake:core from core: no-such-dir does not exist in repo core's worktree$/m);
    assert.doesNotMatch(a, /^## test:/m, 'no configured step ran');
    assert.match(a, /^## secrets: /m, 'the secret scan still ran');
    assert.match(v.report, /^Downstream consumer `app-a` failed `links`: /m);
    assert.equal(fs.readdirSync(path.join(p.root, '.forge', 'jobs', id, 'logs')).some((f) => f.includes('app-a-test')), false, 'no app-a test log');
  });
});
