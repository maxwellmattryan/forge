// Member repo trackers: the GitHub issue trackers of config `repos` entries, read and written beside
// the root's. Which repos qualify comes only from human-owned config (a `repos` entry whose tracker
// a human did not set to `kind: none`), never from a ref an agent typed: a ref is a member's only
// when its `owner/name` equals a configured member's slug. Every member runs the built-in GitHub
// adapter with a config derived from the root's, so the root's ready labels and label prefix apply
// and its GitHub Project never does.
import { splitQualified } from './core/job/issue-ref.ts';
import { SEG, githubHost, localRepoSlug, slugFromRemote } from './repo-slug.ts';
import type { Config } from './core/types.ts';

export interface MemberTracker {
  /** The config `repos` entry's name. */
  name: string;
  /** The member's GitHub `owner/name`, as configured or read from its remote. */
  slug: string;
}

const isSlug = (s: unknown): s is string => {
  if (typeof s !== 'string') return false;
  const parts = s.split('/');
  return parts.length === 2 && parts.every((p) => SEG.test(p) && !p.includes('..'));
};

/**
 * The members with a GitHub tracker, in config order: `tracker.repo`, else the slug of `remote`
 * on github.com (or $GH_HOST). A member with `kind: none`, no slug, the root's slug, or a slug an
 * earlier member already has is left out, silently.
 */
export function memberTrackers(root: string, config: Config): MemberTracker[] {
  const repos = Array.isArray(config.repos) ? config.repos : [];
  if (!repos.length) return [];
  const rootSlug = localRepoSlug(root, config)?.toLowerCase() ?? null;
  const seen = new Set<string>();
  const out: MemberTracker[] = [];
  for (const entry of repos) {
    if (!entry || typeof entry.name !== 'string') continue;
    const t = entry.tracker;
    if (t?.kind === 'none') continue;
    const configured = t?.kind === 'github' && typeof t.repo === 'string' && t.repo.trim() ? t.repo.trim() : null;
    const slug = configured ?? (typeof entry.remote === 'string' ? slugFromRemote(entry.remote, githubHost()) : null);
    if (!isSlug(slug)) continue;
    const key = slug.toLowerCase();
    if (key === rootSlug || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: entry.name, slug });
  }
  return out;
}

/** The member in `members` owning a qualified `owner/name#N` ref, with N, or null. */
export function matchMember(members: MemberTracker[], ref: unknown): (MemberTracker & { n: string }) | null {
  const q = typeof ref === 'string' ? splitQualified(ref) : null;
  if (!q || q.path.split('/').length !== 2) return null;
  const path = q.path.toLowerCase();
  const m = members.find((t) => t.slug.toLowerCase() === path);
  return m ? { ...m, n: q.n } : null;
}

/** The member tracker owning a qualified `owner/name#N` ref, with N, or null (never the root). */
export function memberForRef(root: string, config: Config, ref: string): (MemberTracker & { n: string }) | null {
  return matchMember(memberTrackers(root, config), ref);
}

/**
 * The root's config with its tracker swapped for the member's GitHub repo: label sync only (the
 * root's Project is never applied to a member's issue), the root's ready filters, claim, comment
 * and label settings otherwise.
 */
export function memberTrackerConfig(config: Config, slug: string): Config {
  const c = structuredClone(config);
  const g = c.tracker.github;
  c.tracker = {
    ...c.tracker,
    kind: 'github',
    github: {
      ...g,
      repo: slug,
      statusSync: g.statusSync === 'none' ? 'none' : 'labels',
      ready: { ...g.ready, projectStatus: null },
      // An empty config path is no project file (projectCoords reads it only when truthy).
      project: { ...g.project, config: '', owner: null, number: null },
    },
  };
  return c;
}

export const qualify = (slug: string, n: string | number): string => `${slug}#${n}`;
