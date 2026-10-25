// The machine cap's slot gate: one per machine dashboard, shared by every project's pool. Each pool
// still caps its own job sessions at daemon.maxConcurrent; this caps them across projects, so the
// account's usage limits hold however many projects run. A free slot goes to the waiting job with
// the oldest pending request on the machine (request ids start with Date.now(), so they compare
// across projects). Inbox and office sessions never count. docs/architecture/daemon.md describes it.

/** An idle, unkept job session a member could stop to free its slot. */
export interface IdleSession {
  lastResultAt: string | null;
  stop(): void;
}

/** One project's pool as the gate sees it. */
export interface SlotMember {
  /** Running job sessions. */
  live(): number;
  maxConcurrent(): number;
  /**
   * The oldest pending request id among its waiting job sessions, only while the pool is wanted and
   * below its own maxConcurrent: a waiter the machine cap holds. Null otherwise.
   */
  oldestWaiting(): string | null;
  /** Its idle job sessions with no agents keeping them. */
  idle(): IdleSession[];
  /** Job sessions already stopping, whose slots are about to be free. */
  stopping(): number;
  poke(): void;
}

export interface MachineSlots {
  /** The machine cap: the settings value, else the highest member maxConcurrent, else 1. */
  cap(): number;
  /** Running job sessions across every member. */
  live(): number;
  /** Adds a member; the function returned removes it. */
  join(member: SlotMember): () => void;
  /** Whether `member` may spawn the job whose oldest pending request is `oldest`: a slot is free and no other member's held waiter is older. */
  mayTake(member: SlotMember, oldest: string): boolean;
  /** Stops up to `n` idle, unkept job sessions in other members, oldest result first, less the slots already free or being freed. */
  reclaim(member: SlotMember, n: number): number;
  /** A member's job session exited: every other member gets a tick, so a held waiter can take the slot. */
  freed(member: SlotMember): void;
}

const safe = (fn: () => void): void => {
  try {
    fn();
  } catch {
    // One member's failing tick never stops another's.
  }
};

/** The gate; `setting()` is the machine index's settings.maxConcurrent (null: unset), read at every call. */
export function createMachineSlots(setting: () => number | null): MachineSlots {
  const members = new Set<SlotMember>();
  const others = (m: SlotMember) => [...members].filter((x) => x !== m);
  const cap = (): number => {
    const s = setting();
    if (Number.isInteger(s) && (s as number) >= 1) return s as number;
    return Math.max(1, ...[...members].map((m) => m.maxConcurrent()));
  };
  const live = (): number => [...members].reduce((n, m) => n + m.live(), 0);
  return {
    cap,
    live,
    join(member) {
      members.add(member);
      return () => void members.delete(member);
    },
    mayTake(member, oldest) {
      if (live() >= cap()) return false;
      const older = others(member).filter((m) => {
        const o = m.oldestWaiting();
        return o !== null && o < oldest;
      });
      if (!older.length) return true;
      // The older waiter's pool may not tick for a poll interval: give it the slot now.
      setImmediate(() => older.forEach((m) => safe(() => m.poke())));
      return false;
    },
    reclaim(member, n) {
      const pending = Math.max(0, cap() - live()) + others(member).reduce((k, m) => k + m.stopping(), 0);
      const want = n - pending;
      if (want <= 0) return 0;
      const idle = others(member)
        .flatMap((m) => m.idle())
        .sort((a, b) => (a.lastResultAt ?? '').localeCompare(b.lastResultAt ?? ''))
        .slice(0, want);
      for (const s of idle) safe(() => s.stop());
      return idle.length;
    },
    freed(member) {
      for (const m of others(member)) safe(() => m.poke());
    },
  };
}
