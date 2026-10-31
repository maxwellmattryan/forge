// The hand-written human-mode renderers, keyed by command path (docs/CLI.md "Output mode").
// out() in lib/cli/commands/args.ts looks the call's key up here; a missing key, or a renderer that
// returns null for a shape it doesn't know, falls back to the generic render() in ../render.ts.
// Renderer modules import only ../render.ts, ./kit.ts and types (plus statsSections), never
// args.ts or cli.ts, because args.ts imports this file.
import { backingStatus } from './backing.ts';
import { configGet, configShow, configValidate } from './config.ts';
import { doctor } from './doctor.ts';
import { jobClaim, jobList, jobNote, jobShow, jobStep } from './job.ts';
import { overlap } from './overlap.ts';
import { prMerge, prOpen, prSync } from './pr.ts';
import { requests, stats, status } from './status.ts';
import { sync } from './sync.ts';
import { update } from './update.ts';
import { verify } from './verify.ts';
import { version } from './version.ts';
import { worktreeCreate, worktreeRemove } from './worktree.ts';
import type { Renderer } from './kit.ts';

export type { Renderer, RenderOpts } from './kit.ts';

export const RENDERERS: Readonly<Record<string, Renderer>> = Object.freeze({
  version,
  update,
  status,
  stats,
  doctor,
  sync,
  verify,
  overlap,
  'requests list': requests,
  'job list': jobList,
  'job show': jobShow,
  'job step': jobStep,
  'job claim': jobClaim,
  'job note': jobNote,
  'config show': configShow,
  'config get': configGet,
  'config validate': configValidate,
  'pr open': prOpen,
  'pr sync': prSync,
  'pr merge': prMerge,
  'worktree create': worktreeCreate,
  'worktree remove': worktreeRemove,
  'backing status': backingStatus,
});

/** Commands whose key is their first word, whatever follows it (`verify <id>`). */
const ONE_WORD = new Set(['version', 'update', 'status', 'stats', 'doctor', 'sync', 'verify', 'overlap']);
/** The subcommand a group runs when none is given. */
const DEFAULT_SUB: Readonly<Record<string, string>> = { config: 'show', requests: 'list' };

/** The registry key for a call's positionals, or undefined when no renderer is registered for it. */
export function renderKey(pos: readonly string[]): string | undefined {
  const [cmd, sub] = pos;
  if (cmd === undefined) return undefined;
  const key = ONE_WORD.has(cmd) ? cmd : `${cmd} ${sub ?? (Object.hasOwn(DEFAULT_SUB, cmd) ? DEFAULT_SUB[cmd] : '')}`.trimEnd();
  return Object.hasOwn(RENDERERS, key) ? key : undefined;
}
