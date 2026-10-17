// This repo's `owner/repo`, read offline: lib/issue-ref.ts needs it to tell this repo's issues from
// foreign ones on every job read and link, so it must never wait on `gh` or the network.
// lib/pr.ts keeps its gh-backed repoSlug for the operations that call gh anyway.
import { run } from './util.ts';
import type { Config } from './types.ts';

/** One `owner` or `name` segment of a GitHub `owner/name`. */
export const SEG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const fromRemote = new Map<string, string | null>();

const cleanSlug = (owner: string, repo: string): string | null => {
  const name = repo.replace(/\.git$/, '');
  return SEG.test(owner) && SEG.test(name) && !name.includes('..') ? `${owner}/${name}` : null;
};

/** `owner/repo` from an https, ssh or scp-style remote url on `host`, else null. */
export function slugFromRemote(url: string, host: string): string | null {
  const u = url.trim();
  const h = host.toLowerCase();
  const scp = /^[A-Za-z0-9._-]+@([^:/\s]+):([^/\s]+)\/([^/\s]+?)\/?$/.exec(u);
  if (scp) return scp[1].toLowerCase() === h ? cleanSlug(scp[2], scp[3]) : null;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return null;
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol) || parsed.hostname.toLowerCase() !== h) return null;
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
  return parts.length === 2 ? cleanSlug(parts[0], parts[1]) : null;
}

/**
 * `tracker.github.repo`, else the `owner/repo` of `git remote get-url origin` on github.com (or
 * `$GH_HOST`), else null. The remote is read once per root for the process.
 */
export function localRepoSlug(root: string, config: Pick<Config, 'tracker'>): string | null {
  const configured = config.tracker?.github?.repo;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  if (!fromRemote.has(root)) {
    const r = run('git', ['remote', 'get-url', '--', 'origin'], { cwd: root, allowFail: true, timeoutMs: 5000 });
    fromRemote.set(root, r.ok ? slugFromRemote(r.stdout, process.env.GH_HOST || 'github.com') : null);
  }
  return fromRemote.get(root) ?? null;
}

/** The host foreign GitHub issue urls point at. */
export const githubHost = (): string => process.env.GH_HOST || 'github.com';
