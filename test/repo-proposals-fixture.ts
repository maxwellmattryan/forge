// Shared by the repo proposal suites (issue #180): the scratch project and the snapshot and refusal
// helpers. Scratch repos only (job-repos-fixture.ts: root `app`, member `lib`).
import { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { twoRepo } from './job-repos-fixture.ts';
import type { TwoRepo } from './job-repos-fixture.ts';
import { TRUST_ENV, trustDigest } from '../lib/core/config/load.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

/** The two-repo project plus a `tools` repos entry with no clone, whose clone check always fails. */
export async function project(): Promise<TwoRepo> {
  const p = await twoRepo();
  cleanups.push(p.cleanup);
  p.config((c) => c.repos.push({ name: 'tools', remote: 'https://example.com/tools.git', defaultBranch: 'main' }));
  return p;
}

export const dir = (p: TwoRepo, id: string) => path.join(p.root, '.forge', 'jobs', id);
export const read = (p: TwoRepo, id: string, f: string) => (fs.existsSync(path.join(dir(p, id), f)) ? fs.readFileSync(path.join(dir(p, id), f), 'utf8') : null);
/** job.json, events.jsonl and both proposal files, to prove a refusal wrote nothing. */
export const snapshot = (p: TwoRepo, id: string) => ['job.json', 'events.jsonl', 'repo-proposals.md', 'repo-proposals.json'].map((f) => read(p, id, f));

export async function fails(p: TwoRepo, args: string[], re: RegExp, env: NodeJS.ProcessEnv = {}) {
  const r = await p.raw(args, env);
  assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr + r.stdout, re);
}

export const daemonEnv = (p: TwoRepo, scope: string) => ({ FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(p.root), FORGE_DAEMON_SCOPE: scope });
