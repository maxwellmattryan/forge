// The tracker loader: picks the built-in or repo-local adapter the config names and wraps it in the
// secret checks every tracker write goes through.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { daemonTrust } from '../../core/config/load.ts';
import { paths, exists } from '../../core/paths.ts';
import { refuseSecrets, textUnit } from '../guard/secrets.ts';
import { ForgeError } from '../../core/errors.ts';
import local from '../../integrations/backlog/tracker.ts';
import github from '../../integrations/github/tracker.ts';
import type { Config, Job, TextUnit, Tracker, TrackerCtx } from '../../core/types.ts';

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
 * Built with Object.create so every other method is the adapter's own; the guarded ones call the
 * adapter with itself as the receiver, so a class instance with #private fields keeps working. The
 * built-in update and claim send only a status key; a custom adapter's receive the whole job, so its
 * title and reason are scanned too. A refused claim returns `{ok: false}` like any refused claim, so
 * callers cancel the job they just created instead of leaving it behind.
 */
function guardTracker(adapter: Tracker, opts: { custom: boolean }): Tracker {
  const g: Tracker = Object.create(adapter);
  const refuse = (ctx: TrackerCtx, what: string, units: TextUnit[]) => refuseSecrets(ctx.root, ctx.config, units, { what });
  g.comment = (ctx, ref, body) => {
    refuse(ctx, 'the tracker comment', [textUnit('(tracker comment)', String(body ?? ''))]);
    return adapter.comment(ctx, ref, body);
  };
  g.create = (ctx, item) => {
    refuse(ctx, 'the issue title or body', [textUnit('(issue title)', String(item?.title ?? '')), textUnit('(issue body)', String(item?.body ?? ''))]);
    return adapter.create(ctx, item);
  };
  if (opts.custom) {
    const jobUnits = (job: Job) => [textUnit('(job title)', String(job?.title ?? '')), textUnit('(job reason)', String(job?.reason ?? ''))];
    g.update = (ctx, ref, job) => {
      refuse(ctx, "the job's title or reason", jobUnits(job));
      return adapter.update(ctx, ref, job);
    };
    g.claim = (ctx, ref, job) => {
      try {
        refuse(ctx, "the job's title or reason", jobUnits(job));
      } catch (e) {
        if (e instanceof ForgeError && e.code === 'secret_found') return { ok: false, reason: e.message };
        throw e;
      }
      return adapter.claim(ctx, ref, job);
    };
  }
  return g;
}

/** A member repo's tracker (lib/member-trackers.ts): always the built-in GitHub adapter, guarded. */
export function memberTracker(): Tracker {
  return guardTracker(github, { custom: false });
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

export { statusKey, STATUS_KEYS } from '../../api/tracker.ts';
