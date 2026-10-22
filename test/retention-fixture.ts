// Shared by test/retention*.test.ts: the scratch repo, seeded jobs and a tree listing.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoTemplate } from './helpers.ts';
import { defaults } from '../lib/core/config/load.ts';
import { createJob, updateJob } from '../lib/core/job/store.ts';
import type { Job, LoadedJob } from '../lib/core/types.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
export const DAY = 86_400_000;

export const repo = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

export const ago = (days: number, at = Date.now()) => new Date(at - days * DAY).toISOString();

/** A job in `state` (done by default) that finished `days` ago, with `patch` applied. */
export function seedJob(root: string, title: string, opts: { state?: string; stage?: string; days?: number; kind?: string; patch?: (j: LoadedJob) => void } = {}): string {
  const id = createJob(root, defaults(), { title, kind: opts.kind }).id;
  const state = opts.state ?? 'done';
  updateJob(root, id, (j) => {
    j.state = state as Job['state'];
    j.stage = (opts.stage ?? (state === 'done' ? 'done' : 'build')) as Job['stage'];
    if (state === 'done' || state === 'cancelled') j.finishedAt = ago(opts.days ?? 3);
    opts.patch?.(j);
  });
  return id;
}

/** Every path under `dir` with its type and size (lstat), sorted: equal listings mean nothing was written. */
export function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      const rel = path.relative(dir, p);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        out.push(`${rel}/`);
        walk(p);
      } else out.push(`${rel} ${st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : 'other'} ${st.size}`);
    }
  };
  walk(dir);
  return out;
}

