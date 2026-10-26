// fakeClaude: a ClaudeAdapter whose children are plain objects. A test drives a session by emitting
// ClaudeEvents (child.emit) and reads what the session asked of claude (turns, answers, modes,
// signals), so no test writes claude's stream-json; lib/integrations/claude/stream.test.ts covers that.
import { PERMISSION_MODES } from '#integrations/claude/argv.ts';
import { briefLine, chatMessageLine } from '#integrations/claude/stream.ts';
import type { ClaudeAdapter, ClaudeChild, ClaudeEvent } from '#integrations/claude/types.ts';
import type { DaemonPermissionMode, PermissionDecision } from '#core/types.ts';

export interface FakeClaudeChild extends ClaudeChild {
  readonly argv: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** env.FORGE_DAEMON_SCOPE */
  readonly scope: string | null;
  readonly maxLineBytes: number;
  readonly pid: number;
  /** Turns written. */
  turns: number;
  /** Owner messages written (writeMessage), in order. */
  messages: string[];
  /** Gate-run briefs written (writeBrief), in order. */
  briefs: string[];
  /** Verdict retries written (writeVerdictRetry). */
  verdictRetries: number;
  answers: { requestId: string; decision: PermissionDecision }[];
  /** Mode switches asked, with ids `fake-mode-<n>`. */
  modes: { requestId: string; mode: DaemonPermissionMode }[];
  signals: NodeJS.Signals[];
  inputEnded: boolean;
  paused: boolean;
  exited: boolean;
  /** Delivers one event to the session, synchronously. */
  emit(e: ClaudeEvent): void;
  /** Emits `exit` once and resolves `closed`. */
  exit(code: number | null, signal: NodeJS.Signals | null): void;
}

let nextPid = 4_100_001;

/** `exitOnSignal: false` keeps a signalled child running (one that ignores SIGTERM). */
export function fakeClaude(opts: { exitOnSignal?: boolean } = {}): { adapter: ClaudeAdapter; children: FakeClaudeChild[] } {
  const children: FakeClaudeChild[] = [];
  const adapter: ClaudeAdapter = {
    start(argv, o, onEvent) {
      const asked = new Set<string>();
      let done!: () => void;
      const closed = new Promise<void>((resolve) => (done = resolve));
      const c: FakeClaudeChild = {
        argv: [...argv],
        cwd: o.cwd,
        env: o.env,
        scope: o.env.FORGE_DAEMON_SCOPE ?? null,
        maxLineBytes: o.maxLineBytes,
        pid: nextPid++,
        turns: 0,
        messages: [],
        briefs: [],
        verdictRetries: 0,
        answers: [],
        modes: [],
        signals: [],
        inputEnded: false,
        paused: false,
        exited: false,
        closed,
        emit(e) {
          if (e.kind === 'permission-asked') asked.add(e.requestId);
          if (e.kind === 'permission-cancelled') asked.delete(e.requestId);
          onEvent(e);
        },
        exit(code, signal) {
          if (c.exited) return;
          c.exited = true;
          onEvent({ kind: 'exit', code, signal });
          done();
        },
        writeTurn() {
          c.turns++;
        },
        writeMessage(text) {
          // The real stream's own check (chatMessageLine), so a fake child refuses what a real one would.
          if (chatMessageLine(text) === null) return false;
          c.messages.push(text);
          return true;
        },
        writeBrief(text) {
          if (briefLine(text) === null) return false;
          c.briefs.push(text);
          return true;
        },
        writeVerdictRetry() {
          c.verdictRetries++;
        },
        answerPermission(requestId, decision) {
          if (!asked.delete(requestId)) return false;
          c.answers.push({ requestId, decision });
          return true;
        },
        setPermissionMode(mode) {
          if (!PERMISSION_MODES.includes(mode)) return null;
          const requestId = `fake-mode-${c.modes.length + 1}`;
          c.modes.push({ requestId, mode });
          return requestId;
        },
        endInput() {
          c.inputEnded = true;
        },
        signal(sig) {
          c.signals.push(sig);
          if (opts.exitOnSignal !== false) setTimeout(() => c.exit(null, sig), 5);
        },
        pause() {
          c.paused = true;
        },
        resume() {
          c.paused = false;
        },
      };
      children.push(c);
      return c;
    },
  };
  return { adapter, children };
}
