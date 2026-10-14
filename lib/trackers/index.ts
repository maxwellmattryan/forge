import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { daemonTrust } from '../config.ts';
import { paths, exists } from '../paths.ts';
import { ForgeError } from '../util.ts';
import local from './local.ts';
import github from './github.ts';
import type { Config, Tracker } from '../types.ts';

// The tracker contract (Tracker, TrackerCtx and TrackerItem) lives in lib/types.ts. Every adapter, built-in
// or a repo's own `.forge/trackers/<name>.mjs` or `.ts`, default-exports one. docs/TRACKERS.md has the details.

const none: Tracker = {
  name: 'none',
  list: () => [],
  search: () => [],
  get: () => null,
  claim: () => ({ ok: true }),
  update: () => {},
  comment: () => {},
  create: () => {
    throw new ForgeError('tracker.kind is "none"; nothing to create issues in');
  },
  close: () => {},
};

export async function loadTracker(root: string, config: Config): Promise<Tracker> {
  const kind = config.tracker.kind;
  if (kind === 'local') return local;
  if (kind === 'github') return github;
  if (kind === 'none') return none;
  const dir = paths(root).trackers;
  const mjs = path.join(dir, `${kind}.mjs`);
  const ts = path.join(dir, `${kind}.ts`);
  // .mjs first: a repo that already has <kind>.mjs loads exactly what it loaded before .ts adapters existed.
  const file = exists(mjs) ? mjs : exists(ts) ? ts : null;
  if (!file) throw new ForgeError(`unknown tracker "${kind}" (no built-in and no ${mjs})`);
  // Seconds may pass between the CLI's trust check and this import: check the module again.
  const trust = daemonTrust(root);
  if (trust.problem) throw new ForgeError(trust.problem);
  const mod: any = await import(pathToFileURL(file).href);
  const t = mod.default;
  for (const m of ['list', 'get', 'claim', 'update', 'comment', 'create', 'close'])
    if (typeof t?.[m] !== 'function') throw new ForgeError(`custom tracker ${file} is missing ${m}()`);
  return t;
}

export { statusKey, STATUS_KEYS } from './status.ts';
