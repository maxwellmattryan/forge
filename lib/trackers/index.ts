import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { daemonTrust } from '../config.ts';
import { paths, exists } from '../paths.ts';
import { refuseSecrets, textUnit } from '../secrets.ts';
import { ForgeError } from '../util.ts';
import local from './local.ts';
import github from './github.ts';
import type { Config, Job, TextUnit, Tracker, TrackerCtx } from '../types.ts';

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

/**
 * An adapter whose writes are scanned for likely credentials first, so every caller (forge tracker
 * comment|create, job link --create, the split procedure, Forge's own mirrors) gets the same refusal.
 * Built with Object.create so prototype methods and `this.update` inside `claim` keep working. The
 * built-in update and claim send only a status key; a custom adapter's receive the whole job, so its
 * title and reason are scanned too.
 */
export function guardTracker(adapter: Tracker, opts: { custom: boolean }): Tracker {
  const g: Tracker = Object.create(adapter);
  const refuse = (ctx: TrackerCtx, what: string, units: TextUnit[]) => refuseSecrets(ctx.root, ctx.config, units, { what });
  g.comment = function (ctx, ref, body) {
    refuse(ctx, 'the tracker comment', [textUnit('(tracker comment)', String(body ?? ''))]);
    return adapter.comment.call(this, ctx, ref, body);
  };
  g.create = function (ctx, item) {
    refuse(ctx, 'the issue title or body', [textUnit('(issue title)', String(item?.title ?? '')), textUnit('(issue body)', String(item?.body ?? ''))]);
    return adapter.create.call(this, ctx, item);
  };
  if (opts.custom) {
    const jobUnits = (job: Job) => [textUnit('(job title)', String(job?.title ?? '')), textUnit('(job reason)', String(job?.reason ?? ''))];
    g.update = function (ctx, ref, job) {
      refuse(ctx, "the job's title or reason", jobUnits(job));
      return adapter.update.call(this, ctx, ref, job);
    };
    g.claim = function (ctx, ref, job) {
      refuse(ctx, "the job's title or reason", jobUnits(job));
      return adapter.claim.call(this, ctx, ref, job);
    };
  }
  return g;
}

export async function loadTracker(root: string, config: Config): Promise<Tracker> {
  const kind = config.tracker.kind;
  if (kind === 'local') return guardTracker(local, { custom: false });
  if (kind === 'github') return guardTracker(github, { custom: false });
  if (kind === 'none') return guardTracker(none, { custom: false });
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
  return guardTracker(t, { custom: true });
}

export { statusKey, STATUS_KEYS } from './status.ts';
