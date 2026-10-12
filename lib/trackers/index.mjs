// @ts-check
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { paths, exists } from '../paths.mjs';
import { ForgeError } from '../util.mjs';
import local from './local.mjs';
import github from './github.mjs';

/**
 * The tracker contract. Every adapter (built-in or a repo's own `.forge/trackers/<name>.mjs`)
 * default-exports an object with these synchronous methods. docs/TRACKERS.md has the details.
 *
 * @typedef {{ root:string, config:any }} TrackerCtx
 * @typedef {{ ref:string, title:string, url?:string|null, body?:string, labels?:string[], status?:string|null,
 *   priority?:string|null, assignees?:string[], claimedBy?:string|null }} TrackerItem
 * @typedef {{
 *   name: string,
 *   list: (ctx:TrackerCtx, opts:{ready?:boolean, limit?:number}) => TrackerItem[],
 *   get: (ctx:TrackerCtx, ref:string) => TrackerItem|null,
 *   claim: (ctx:TrackerCtx, ref:string, job:any) => {ok:boolean, reason?:string},
 *   update: (ctx:TrackerCtx, ref:string, job:any) => void,
 *   comment: (ctx:TrackerCtx, ref:string, body:string) => void,
 *   create: (ctx:TrackerCtx, item:{title:string, body?:string, labels?:string[], parentRef?:string|null}) => {ref:string, url?:string|null},
 *   close: (ctx:TrackerCtx, ref:string, opts?:{reason?:'completed'|'not-planned'}) => void,
 * }} Tracker
 */

const none = /** @type {Tracker} */ ({
  name: 'none',
  list: () => [],
  get: () => null,
  claim: () => ({ ok: true }),
  update: () => {},
  comment: () => {},
  create: () => {
    throw new ForgeError('tracker.kind is "none"; nothing to create issues in');
  },
  close: () => {},
});

/** @param {string} root @param {any} config @returns {Promise<Tracker>} */
export async function loadTracker(root, config) {
  const kind = config.tracker.kind;
  if (kind === 'local') return local;
  if (kind === 'github') return github;
  if (kind === 'none') return none;
  const file = path.join(paths(root).trackers, `${kind}.mjs`);
  if (!exists(file)) throw new ForgeError(`unknown tracker "${kind}" (no built-in and no ${file})`);
  const mod = await import(pathToFileURL(file).href);
  const t = mod.default;
  for (const m of ['list', 'get', 'claim', 'update', 'comment', 'create', 'close'])
    if (typeof t?.[m] !== 'function') throw new ForgeError(`custom tracker ${file} is missing ${m}()`);
  return t;
}

export { statusKey, STATUS_KEYS } from './status.mjs';
