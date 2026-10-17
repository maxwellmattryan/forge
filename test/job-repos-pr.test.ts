// Job repos and PRs: one PR per non-verify-only job repo, on scratch repos with bare remotes and a
// fake `gh` that answers per `-R` slug. No real GitHub repo is touched.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { twoRepo } from './job-repos-fixture.ts';
import type { TwoRepo } from './job-repos-fixture.ts';
import { loadConfig } from '../lib/config.ts';
import { loadJob } from '../lib/jobs.ts';
import { memberPrBody, prText } from '../lib/pr.ts';
import { token } from './secret-fixtures.ts';

// Per slug `o/<name>`: <name>.pr holds the PR's head branch once created; <name>.state, .url and
// .cross override what gh reports; <name>.fail makes `pr create` fail.
const FAKE_GH = `#!/bin/sh
d="$FAKE_GH_DIR"
echo "$*" >> "$d/calls.log"
slug=""; head=""; open=""; prev=""
for a in "$@"; do
  [ "$prev" = "-R" ] && slug="$a"
  [ "$prev" = "--head" ] && head="$a"
  [ "$prev" = "--state" ] && [ "$a" = "open" ] && open=1
  prev="$a"
done
name="\${slug#*/}"
num() { if [ "$name" = lib ]; then echo 7; else echo 11; fi; }
url() { if [ -f "$d/$name.url" ]; then cat "$d/$name.url"; else echo "https://github.com/$slug/pull/$(num)"; fi; }
state() { if [ -f "$d/$name.state" ]; then cat "$d/$name.state"; else echo OPEN; fi; }
cross() { if [ -f "$d/$name.cross" ]; then echo true; else echo false; fi; }
merged() { if [ "$(state)" = MERGED ]; then echo '"2026-10-02T00:00:00Z"'; else echo null; fi; }
branch() { cat "$d/$name.pr" 2>/dev/null; }
case "$1 $2" in
  "pr create")
    if [ -f "$d/$name.fail" ]; then echo "create failed for $slug" >&2; exit 1; fi
    echo "$head" > "$d/$name.pr"
    url ;;
  "pr list")
    if { [ -f "$d/$name.pr" ] || [ -f "$d/$name.cross" ]; } && { [ -z "$open" ] || [ "$(state)" = OPEN ]; }; then
      printf '[{"number":%s,"url":"%s","state":"%s","isDraft":false,"isCrossRepository":%s,"headRefName":"%s","baseRefName":"main"}]' "$(num)" "$(url)" "$(state)" "$(cross)" "$head"
    else echo '[]'; fi ;;
  "pr view")
    printf '{"number":%s,"url":"%s","state":"%s","isDraft":false,"isCrossRepository":%s,"headRefOid":"%s","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"","statusCheckRollup":[],"mergedAt":%s,"closedAt":null,"headRefName":"%s","baseRefName":"main","title":"t","author":{"login":"x"}}' "$(num)" "$(url)" "$(state)" "$(cross)" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "$(merged)" "$(branch)" ;;
  "api graphql") echo '{"data":{"repository":{"pullRequest":{},"issue":null}}}' ;;
  "repo view") echo o/app ;;
  "pr merge") ;;
esac
`;

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

interface PrProject extends TwoRepo {
  env: NodeJS.ProcessEnv;
  gh: string;
  calls: () => string[];
  pr: (args: string[]) => Promise<{ status: number | null; stdout: string; stderr: string }>;
  heads: (bare: string) => string;
}

async function project(): Promise<PrProject> {
  const p = await twoRepo();
  cleanups.push(p.cleanup);
  const gh = path.join(p.parent, 'gh');
  fs.mkdirSync(path.join(gh, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(gh, 'bin', 'gh'), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(gh, 'calls.log'), '');
  const env = { PATH: `${path.join(gh, 'bin')}${path.delimiter}${process.env.PATH}`, FAKE_GH_DIR: gh };
  return {
    ...p,
    env,
    gh,
    calls: () => fs.readFileSync(path.join(gh, 'calls.log'), 'utf8').split('\n').filter(Boolean),
    pr: (args) => p.raw(['pr', ...args], env),
    heads: (bare) => p.git(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').trim(),
  };
}

/** A job with member lib, both repos committed and verified. */
async function ready(p: PrProject, opts: { verifyOnly?: boolean; libCommit?: boolean; libFiles?: Record<string, string> } = {}) {
  const j = await p.f('job', 'new', '--title', `Two repo change ${Math.random().toString(36).slice(2, 8)}`);
  await p.f('job', 'repo', 'add', ...(opts.verifyOnly ? ['--verify-only'] : []), j.id, 'lib');
  await p.f('worktree', 'create', j.id);
  const rootWt = path.join(p.parent, 'app.worktrees', j.id);
  const libWt = path.join(p.parent, 'lib.worktrees', j.id);
  p.commit(rootWt, { 'app.txt': 'app\n' }, 'feat: app');
  if (!opts.verifyOnly && opts.libCommit !== false) p.commit(libWt, opts.libFiles ?? { 'lib.txt': 'lib\n' }, 'feat: lib');
  await p.f('job', 'round', j.id);
  return { id: j.id as string, rootWt, libWt, branch: `forge/${j.id}` };
}

describe('job repos: pull requests', { concurrency: 4 }, () => {
  test('pr open opens one PR per non-verify-only repo', async () => {
    const p = await project();
    const j = await ready(p);
    await p.f('verify', j.id);
    const libHead = p.git(j.libWt, 'rev-parse', 'HEAD').trim();
    const r = await p.pr(['open', j.id]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual([out.number, out.created], [11, true]);
    assert.deepEqual(out.repos, [{ repo: 'lib', number: 7, url: 'https://github.com/o/lib/pull/7', created: true }]);
    const creates = p.calls().filter((c) => c.startsWith('pr create'));
    assert.equal(creates.length, 2);
    assert.match(creates[0], new RegExp(`^pr create -R o/lib --base main --head ${j.branch} --title `), 'the member PR comes first');
    assert.match(creates[1], /^pr create -R o\/app /);
    assert.ok(p.heads(p.libBare).split('\n').includes(j.branch), 'the member branch was pushed');
    assert.ok(p.heads(p.rootBare).split('\n').includes(j.branch));
    const job = loadJob(p.root, j.id);
    const pr = job.repos[1].pr!;
    assert.deepEqual([pr.number, pr.url, pr.state, pr.pushedSha], [7, 'https://github.com/o/lib/pull/7', 'OPEN', libHead]);
    // The root body is the single-repo body: no member links.
    const config = loadConfig(p.root).config;
    const rootBody = fs.readFileSync(path.join(p.root, '.forge', 'jobs', j.id, 'pr-body.md'), 'utf8');
    assert.equal(rootBody, prText(p.root, config, { ...job, repos: job.repos.slice(0, 1) }).body);
    assert.ok(!rootBody.includes('o/lib') && !rootBody.includes('/pull/'));
    const memberBody = fs.readFileSync(path.join(p.root, '.forge', 'jobs', j.id, 'pr-body-lib.md'), 'utf8');
    assert.equal(memberBody, memberPrBody(p.root, config, job));
    assert.doesNotMatch(memberBody, /Closes|Refs|\/pull\//);
    assert.deepEqual(p.events(j.id).filter((e) => e.type === 'repo-pr-opened').map((e) => [e.repo, e.number]), [['lib', 7]]);
    assert.deepEqual(p.events(j.id).filter((e) => e.type === 'pr-opened').map((e) => e.number), [11], 'pr-opened is the root only');

    const again = await p.pr(['open', j.id]);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(JSON.parse(again.stdout).repos, [{ repo: 'lib', number: 7, url: 'https://github.com/o/lib/pull/7', created: false }]);
    assert.equal(p.calls().filter((c) => c.startsWith('pr create')).length, 2, 'a rerun creates no PR');
    assert.deepEqual(p.events(j.id).filter((e) => e.type === 'repo-pr-updated').map((e) => e.repo), ['lib']);

    const v = await ready(p, { verifyOnly: true });
    await p.f('verify', v.id);
    const before = p.calls().length;
    const vr = await p.pr(['open', v.id]);
    assert.equal(vr.status, 0, vr.stderr);
    assert.deepEqual(JSON.parse(vr.stdout).repos, [], 'a verify-only member gets no PR');
    assert.ok(!p.calls().slice(before).some((c) => c.includes('-R o/lib')));
    assert.ok(!p.heads(p.libBare).split('\n').includes(v.branch), 'and no push');
  });

  test('pr open checks every repo before anything is pushed', async () => {
    const p = await project();
    const noLibCommit = await ready(p, { libCommit: false });
    await p.f('verify', noLibCommit.id);
    let r = await p.pr(['open', noLibCommit.id]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /repo lib has no commits ahead of main; remove it \(forge job repo remove\) or re-add it with --verify-only/);

    const key = token.github('member-pr');
    const secret = await ready(p, { libFiles: { 'k.ts': `export const k = '${key}';\n` } });
    r = await p.raw(['pr', 'open', secret.id, '--force', '--json'], p.env);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(JSON.parse(r.stdout).error.code, 'secret_found');
    assert.match(JSON.parse(r.stdout).error.message, /the commits of repo lib/);

    const noSlug = await ready(p);
    await p.f('verify', noSlug.id);
    p.config((c) => delete c.repos[0].tracker);
    r = await p.pr(['open', noSlug.id]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /cannot determine the GitHub repository of repo lib; set repos\[\]\.tracker\.repo/);

    assert.equal(p.heads(p.libBare), 'main', 'no member branch was pushed');
    assert.equal(p.heads(p.rootBare), 'main', 'no root branch was pushed');
    assert.ok(!p.calls().some((c) => c.startsWith('pr create')));
  });

  test('pr open applies protected paths to every member branch before anything is pushed', async () => {
    const p = await project();
    const pushed = () => [p.heads(p.libBare), p.heads(p.rootBare)];
    // An escalate path committed by plain git in the member: no push and no PR in any repo until a
    // human approves at the PP1 park.
    const j = await ready(p, { libFiles: { 'lib.txt': 'lib\n', '.github/workflows/ci.yml': 'on: push\n' } });
    await p.f('verify', j.id);
    let r = await p.raw(['pr', 'open', j.id, '--json'], p.env);
    assert.equal(r.status, 1, r.stdout);
    let err = JSON.parse(r.stdout).error;
    assert.equal(err.code, 'protected_path');
    assert.equal(err.message, `protected paths need a human approval: 1 paths; /forge approve ${j.id}`);
    assert.deepEqual(pushed(), ['main', 'main'], 'nothing was pushed');
    assert.ok(!p.calls().some((c) => c.startsWith('pr ')), 'gh opened nothing');
    const flag = loadJob(p.root, j.id).protectedPaths!;
    assert.deepEqual([flag.gate, flag.hits.map((h) => h.path)], ['pr', ['lib:.github/workflows/ci.yml']]);
    await p.f('job', 'set', j.id, '--state', 'waiting', '--waiting-on', 'human', '--reason', 'protected paths: lib:.github/workflows/ci.yml');
    await p.f('job', 'human', j.id, 'approve');
    await p.f('job', 'set', j.id, '--state', 'running');
    r = await p.pr(['open', j.id]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).repos.map((x: any) => x.repo), ['lib']);
    assert.ok(p.heads(p.libBare).split('\n').includes(j.branch), 'approved: the member branch was pushed');

    // A refuse path in the member stops pr open, --force included, before any push.
    const k = await ready(p, { libFiles: { 'k.pem': 'x\n' } });
    r = await p.raw(['pr', 'open', k.id, '--force', '--json'], p.env);
    assert.equal(r.status, 1, r.stdout);
    err = JSON.parse(r.stdout).error;
    assert.equal(err.code, 'protected_path');
    assert.match(err.message, /^forge pr open refuses protected paths:\n  lib:k\.pem: rule 6/);
    assert.ok(!p.heads(p.libBare).split('\n').includes(k.branch));
    assert.ok(!p.heads(p.rootBare).split('\n').includes(k.branch));
  });

  test('a member PR failure names the repo and a rerun completes', async () => {
    const p = await project();
    const j = await ready(p);
    await p.f('verify', j.id);
    fs.writeFileSync(path.join(p.gh, 'lib.fail'), '');
    let r = await p.pr(['open', j.id]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /^forge: repo lib: /m);
    assert.deepEqual(p.events(j.id).filter((e) => e.type === 'pr-opened'), [], 'no root PR');
    assert.ok(!p.calls().some((c) => c.startsWith('pr create -R o/app')));
    assert.equal(loadJob(p.root, j.id).pr, null);
    fs.rmSync(path.join(p.gh, 'lib.fail'));
    r = await p.pr(['open', j.id]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual([out.number, out.created, out.repos[0].created], [11, true, true]);
    assert.equal(loadJob(p.root, j.id).repos[1].pr!.number, 7);
  });

  test('sync records member PR state and leaves the transition and merge root-only', async () => {
    const p = await project();
    const j = await ready(p);
    await p.f('verify', j.id);
    assert.equal((await p.pr(['open', j.id])).status, 0);
    await p.f('job', 'set', j.id, '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review');
    const sync = async () => {
      const r = await p.pr(['sync', j.id]);
      assert.equal(r.status, 0, r.stderr);
      return loadJob(p.root, j.id);
    };
    let job = await sync();
    let m = job.repos[1].pr!;
    assert.deepEqual([m.number, m.url, m.state, m.headOid, m.checks?.state, m.mergedAt], [7, 'https://github.com/o/lib/pull/7', 'OPEN', 'a'.repeat(40), 'none', null]);
    assert.ok(m.lastSyncedAt);
    fs.writeFileSync(path.join(p.gh, 'lib.state'), 'MERGED');
    job = await sync();
    m = job.repos[1].pr!;
    assert.deepEqual([m.state, m.mergedAt], ['MERGED', '2026-10-02T00:00:00Z']);
    assert.deepEqual([job.stage, job.state, job.waitingOn], ['pr', 'waiting', 'pr-review'], 'the root PR alone decides the transition');
    fs.writeFileSync(path.join(p.gh, 'lib.url'), 'http://github.com/o/lib/pull/7');
    job = await sync();
    assert.equal(job.repos[1].pr!.url, null, 'a url that is not https is not stored');

    // A cross-repository PR found by branch is refused, and never stops the root sync.
    const k = await ready(p);
    fs.rmSync(path.join(p.gh, 'lib.pr'), { force: true });
    fs.writeFileSync(path.join(p.gh, 'lib.cross'), '');
    fs.writeFileSync(path.join(p.gh, 'lib.state'), 'OPEN');
    fs.rmSync(path.join(p.gh, 'lib.url'));
    const r = await p.pr(['sync', k.id]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(loadJob(p.root, k.id).repos[1].pr, null);
    assert.deepEqual(p.events(k.id).filter((e) => e.type === 'repo-pr-sync-failed').map((e) => e.repo), ['lib']);
    assert.equal(loadJob(p.root, k.id).pr?.number, 11, 'the root PR still synced');

    const merge = await p.pr(['merge', j.id, '--now']);
    assert.equal(merge.status, 0, merge.stderr + merge.stdout);
    const merges = p.calls().filter((c) => c.startsWith('pr merge'));
    assert.equal(merges.length, 1);
    assert.match(merges[0], /-R o\/app/);
  });
});
