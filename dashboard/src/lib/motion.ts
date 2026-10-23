// The dashboard's one door to Svelte transitions: the durations style.css's --motion-* tokens name, a reduced-motion
// guard that zeroes every transition, and the settle rule that keeps a page load, a reconnect or a stream (re)open from
// animating. Components import their transitions from here, never from svelte/transition. DOM-free at import.
import { fade as svelteFade, fly, scale, type TransitionConfig } from 'svelte/transition';

/** The --motion-* tokens in ms: exits take quick, entries base, and nothing that gates a control takes longer than slow. */
export const MOTION = { quick: 90, base: 140, slow: 200 } as const;

/** --ease-enter (ease-out cubic) and --ease-exit (ease-in cubic). */
export const easeEnter = (t: number): number => 1 - (1 - t) ** 3;
export const easeExit = (t: number): number => t ** 3;

/** How long after the first data, a reconnect or a stream (re)open nothing heats, glows or enters. */
export const SETTLE_MS = 1000;

/** Whether the user asked for reduced motion, read on every call so a change in the OS applies at once. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Whether a change seen at `now` is real: false until the first data (`ready` null), and within SETTLE_MS of it (a
 * reconnect moves it) or of any open mark (a stream's dial or reopen; null marks are ignored).
 */
export function settled(now: number, ready: number | null, ...opens: (number | null)[]): boolean {
  if (ready === null || now - ready < SETTLE_MS) return false;
  return opens.every((o) => o === null || now - o >= SETTLE_MS);
}

/** A Svelte transition function, as `in:`, `out:` and `transition:` take it. */
export type Transition<P = any> = (node: Element, params: P, options: { direction: 'in' | 'out' | 'both' }) => TransitionConfig | (() => TransitionConfig);

/** `fn`, except that it runs for 0ms without being called while `instant()` is true (by default: reduced motion). */
export function motion<P>(fn: Transition<P>, instant: () => boolean = prefersReducedMotion): Transition<P> {
  return (node, params, options) => (instant() ? { duration: 0 } : fn(node, params, options));
}

/** `motion`, also instant until the dashboard has settled; `ready` is the caller's `() => S.readyAt`. */
export const gated = <P>(fn: Transition<P>, ready: () => number | null): Transition<P> => motion(fn, () => prefersReducedMotion() || !settled(Date.now(), ready()));

/** The params every entry defaults to; an exit passes EXIT (with `ready` when gated). */
export const ENTER = { duration: MOTION.base, easing: easeEnter };
export const EXIT = { duration: MOTION.quick, easing: easeExit };

/** A transition's params. With `ready` (`() => S.readyAt`) it is also gated: instant until the dashboard settles. */
export type MotionParams = { duration?: number; easing?: (t: number) => number; delay?: number; ready?: () => number | null } | undefined;

type Raw = Transition<MotionParams>;
const fadeRaw: Raw = (node, p) => svelteFade(node, { ...ENTER, ...p });
const riseRaw: Raw = (node, p) => fly(node, { y: 4, ...ENTER, ...p });
const popRaw: Raw = (node, p) => scale(node, { start: 0.98, ...ENTER, ...p });
const shutterRaw: Raw = (_node, p) => ({ ...ENTER, ...p, css: (t: number) => `clip-path: inset(0 0 ${(1 - t) * 100}% 0)` });

/** Wraps a raw transition: `motion` always, `gated` when the params carry `ready`. */
const wrap =
  (raw: Raw): Raw =>
  (node, p, options) =>
    (p?.ready ? gated(raw, p.ready) : motion(raw))(node, p, options);

/** A plain fade. */
export const fade = wrap(fadeRaw);
/** A 4px rise from below as it fades in (the status bar popover, the toast). */
export const rise = wrap(riseRaw);
/** A .98 to 1 scale as it fades in (Settings, the palette). */
export const pop = wrap(popRaw);
/** A clip from the top, as a shutter drops (a terminal's nameplate on a stage change). */
export const shutter = wrap(shutterRaw);
