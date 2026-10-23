// No secret gate prints a planted value: verify reports at most ten findings, and neither a value nor
// its body reaches the job's files, events or any CLI output. Kept through the test rewrite
// (docs/test-rewrite/README.md): the security posture AGENTS.md says to preserve. Every planted value
// is built at runtime (test/secret-fixtures.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, tempRepo } from '../../helpers.ts';
import { token } from '../../secret-fixtures.ts';


const commitAll = (cwd: string, msg: string) => {
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', msg], { cwd });
};
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

/** A scratch repo with Forge initialised (local tracker, no remote) and helpers for its jobs. */
async function scratch(extra: Record<string, unknown> = {}) {
  const repo = tempRepo();
  const name = path.basename(repo.dir);
  const answersFile = path.join(repo.dir, '..', `answers-${name}.json`);
  const outputs: string[] = [];
  const raw = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const r = await forgeAsync(repo.dir, args, env);
    outputs.push(r.stdout, r.stderr);
    return r;
  };
  const f = async (...args: string[]) => {
    const r = await raw(args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return r.stdout.trim();
    }
  };
  const configure = async (more: Record<string, unknown> = {}) => {
    fs.writeFileSync(answersFile, JSON.stringify({ commands: { test: 'echo TEST-RAN' }, verify: ['test'], worktrees: { root: `../${name}.wt` }, ...extra, ...more }));
    await f('init', 'write', '--answers', answersFile, '--force');
  };
  await configure();
  commitAll(repo.dir, 'forge init');
  /** A job whose branch commits `files` (path → text) in one commit with `msg`. */
  const job = async (files: Record<string, string>, msg = 'job work') => {
    const j = await f('job', 'new', '--title', `job ${Object.keys(files).join(' ')}`.slice(0, 60));
    const wt: string = (await f('worktree', 'create', j.id)).path;
    for (const [rel, text] of Object.entries(files)) write(wt, rel, text);
    if (Object.keys(files).length) commitAll(wt, msg);
    await f('job', 'round', j.id);
    return { id: j.id as string, wt, dir: path.join(repo.dir, '.forge', 'jobs', j.id) };
  };
  const verify = async (id: string) => {
    const r = await raw(['verify', id]);
    return { status: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
  };
  const events = (dir: string) => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  /** Everything a gate could have written for a job: its files, events and every CLI output so far. */
  const trail = (dir: string) => {
    const parts = [...outputs];
    for (const rel of fs.readdirSync(dir, { recursive: true }).map(String)) {
      const p = path.join(dir, rel);
      if (fs.statSync(p).isFile() && !/^(build|pr|tasks|notes)\.md$/.test(rel)) parts.push(fs.readFileSync(p, 'utf8'));
    }
    return parts.join('\n');
  };
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(path.join(repo.dir, '..', `${name}.wt`), { recursive: true, force: true });
    fs.rmSync(answersFile, { force: true });
  };
  return { job, verify, events, trail, cleanup };
}

test('no gate prints a planted value', async () => {
  const s = await scratch();
  try {
    const keys = Array.from({ length: 12 }, (_, i) => token.aws(`many${i}`));
    const j = await s.job({ 'keys.txt': keys.map((k, i) => `k${i} ${k}`).join('\n') + '\n' });
    const r = await s.verify(j.id);
    assert.equal(r.status, 1);
    assert.equal(r.out.secrets.count, 12);
    assert.equal(r.out.secrets.findings.length, 10);
    assert.equal(r.out.secrets.more, 2);
    const [ev] = s.events(j.dir).filter((e) => e.type === 'secret-found');
    assert.equal(ev.gate, 'verify');
    assert.equal(ev.blocked, true);
    assert.equal(ev.count, 12);
    assert.equal(ev.allowed, 0);
    assert.equal(ev.round, 1);
    assert.equal(ev.more, 2);
    assert.equal(ev.findings.length, 10);
    for (const f of ev.findings) assert.deepEqual(Object.keys(f).sort(), ['excerpt', 'fingerprint', 'kind', 'line', 'path']);
    const all = s.trail(j.dir);
    for (const k of keys) assert.ok(!all.includes(k) && !all.includes(k.slice(4)), 'neither the value nor its body');
  } finally {
    s.cleanup();
  }
});
