// A station terminal's life (SessionLog, EnvironmentLog, the status bar's lamps): the pilot lamp and when a
// line counts as live output. Heat is activity: these say when something works, waits or rests. Pure and DOM-free.
import { asking, obj, type SessionInput } from '../sessions/daemon.ts';
import { SETTLE_MS } from '../ui/motion.ts';

/** working breathes; waiting is dimmed heat; you is the ringed ember; done is ok; idle is dark; fault is bad. */
export type LampState = 'working' | 'waiting' | 'you' | 'done' | 'idle' | 'fault';

/** The lamps that mean the station is live: the screen glows. */
export const LIVE_LAMPS: ReadonlySet<LampState> = new Set<LampState>(['working', 'waiting', 'you']);

/** How long after a live line the station counts as streaming. */
export const STREAM_MS = 2000;
/** How long a tool or subagent call that arrived live keeps its gutter strike. */
export const STRIKE_MS = 1500;

export type LampInput =
  /** A daemon session; `waiting` is the log's open tool or subagent call. */
  | { kind: 'session'; session: SessionInput; waiting: boolean; streaming: boolean }
  /** A stream with no session behind it: a transcript or an environment log. */
  | { kind: 'stream'; ended: boolean; waiting: boolean; streaming: boolean };

/**
 * The pilot lamp, first match wins. A session: a permission prompt is you; busy is waiting on an open tool call, else
 * working; kept by its job's agents is waiting; running and between turns (the pill's ok idle: no slot wait, hold or
 * error) is done; anything else (no session, stopped, standby, held, waiting for a slot, error) is idle. A stream: ended
 * is done, then waiting, then streaming is working, else idle.
 */
export function lampState(input: LampInput): LampState {
  if (input.kind === 'stream') {
    if (input.ended) return 'done';
    if (input.waiting) return 'waiting';
    return input.streaming ? 'working' : 'idle';
  }
  const s = obj(input.session);
  if (asking(s)) return 'you';
  if (s.status === 'busy') return input.waiting ? 'waiting' : 'working';
  if (s.kept === 'agents') return 'waiting';
  if (s.running === true && s.status === 'idle' && !s.waiting && !s.held && !s.lastError) return 'done';
  return 'idle';
}

/** Whether output is streaming: a live line arrived within STREAM_MS. */
export const streaming = (lastLiveAt: number | null, now: number): boolean => lastLiveAt !== null && now - lastLiveAt < STREAM_MS;

/** Whether a call that arrived at `arrivedAt` still shows its strike. */
export const struck = (arrivedAt: number | null | undefined, now: number): boolean => typeof arrivedAt === 'number' && now - arrivedAt < STRIKE_MS;

/** Whether a line seen at `now` is live output rather than the backlog a stream (re)open replays. */
export const isLiveLine = (openedAt: number | null, now: number): boolean => openedAt !== null && now - openedAt >= SETTLE_MS;
