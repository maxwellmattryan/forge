// Who did a human action. Best effort and unauthenticated: every source below is whatever the
// environment says, so the actor is a record for auditors, never a grant of authority. It is
// resolved lazily, at most once per process, and only on a path that writes a human-action event,
// so a CLI call that writes none never spawns gh or git.
import os from 'node:os';
import path from 'node:path';
import { paths } from '#core/paths.ts';
import { sanitizeLogin } from '#core/job/schema.ts';
import type { EventActor } from '#core/types.ts';
import { gh } from './gh.ts';
import { git } from '../git/runner.ts';
import { hasBinary } from '#core/os/process.ts';
import { readJson, writeJsonAtomic } from '#core/os/fs.ts';

/** How long a gh login stays cached in .forge/runtime/actor.json. */
export const ACTOR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ACTOR_GH_TIMEOUT_MS = 5000;

export interface ActorDeps {
  env: NodeJS.ProcessEnv;
  /** `gh api user --jq .login`, or null when gh is missing, logged out, slow or silent. */
  gh: () => string | null;
  gitEmail: () => string | null;
  osUser: () => string | null;
  /** actor.json; null turns the cache off. */
  cacheFile: string | null;
  now: () => number;
}

interface CacheEntry {
  login: string;
  at: number;
}

function readCache(file: string | null): Record<string, CacheEntry> {
  if (!file) return {};
  try {
    const raw = readJson(file, {});
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    // An unreadable or hand-broken cache counts as empty; it only ever saves a gh call.
    return {};
  }
}

function ghLogin(deps: ActorDeps): string {
  // GH_HOST only keys the cache; it never reaches gh's argv.
  const host = deps.env.GH_HOST || 'github.com';
  const cache = readCache(deps.cacheFile);
  const hit = Object.prototype.hasOwnProperty.call(cache, host) ? cache[host] : undefined;
  const age = hit && typeof hit.at === 'number' ? deps.now() - hit.at : Infinity;
  if (hit && age >= 0 && age < ACTOR_CACHE_TTL_MS) {
    const login = sanitizeLogin(hit.login);
    if (login) return login;
  }
  const login = sanitizeLogin(deps.gh());
  // A failure is not cached, so the next human action tries gh again.
  if (login && deps.cacheFile) {
    try {
      writeJsonAtomic(deps.cacheFile, { ...cache, [host]: { login, at: deps.now() } });
    } catch {
      // The cache is an optimisation; a read-only runtime dir must not fail the human action.
    }
  }
  return login;
}

/** The resolution order: daemon session > FORGE_ACTOR > gh > git email > OS user > unknown. */
export function resolveActor(deps: ActorDeps): EventActor {
  // A daemon session acts on requests a person queued from the dashboard, run as the OS user that
  // started `forge dash`; FORGE_ACTOR is ignored there on purpose.
  if (deps.env.FORGE_DAEMON === '1') return { login: sanitizeLogin(deps.osUser()) || null, source: 'dashboard' };
  const env = sanitizeLogin(deps.env.FORGE_ACTOR);
  if (env) return { login: env, source: 'env' };
  const gh = ghLogin(deps);
  if (gh) return { login: gh, source: 'gh' };
  const git = sanitizeLogin(deps.gitEmail());
  if (git) return { login: git, source: 'git' };
  const user = sanitizeLogin(deps.osUser());
  if (user) return { login: user, source: 'os' };
  return { login: null, source: 'unknown' };
}

function osUserName(): string | null {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}

function realDeps(root: string): ActorDeps {
  return {
    env: process.env,
    gh: () => {
      if (!hasBinary('gh')) return null;
      const r = gh(root, ['api', 'user', '--jq', '.login'], { allowFail: true, timeoutMs: ACTOR_GH_TIMEOUT_MS });
      return r.ok ? r.stdout.trim() : null;
    },
    gitEmail: () => {
      const r = git(root, ['config', 'user.email'], { allowFail: true });
      return r.ok ? r.stdout.trim() : null;
    },
    osUser: osUserName,
    cacheFile: path.join(paths(root).runtime, 'actor.json'),
    now: Date.now,
  };
}

let memo: EventActor | undefined;

/** This process's actor, resolved on first use. */
export function currentActor(root: string): EventActor {
  memo ??= resolveActor(realDeps(root));
  return memo;
}

/** The person behind a dashboard action: the OS user running `forge dash`. */
export function dashboardActor(): EventActor {
  return { login: sanitizeLogin(osUserName()) || null, source: 'dashboard' };
}

/** What `forge job human --actor foreman` records. */
export const FOREMAN_ACTOR: EventActor = Object.freeze({ login: null, source: 'foreman' });
