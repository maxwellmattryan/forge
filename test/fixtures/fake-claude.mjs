// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, used by the
// daemon tests. Knobs (environment):
//   FAKE_CLAUDE_LOG           append {pid, argv, scope} at start and {pid, stdin} per input line
//   FAKE_CLAUDE_DELAY_MS      delay before each `result` (default 0)
//   FAKE_CLAUDE_DELAY_SCOPE   apply that delay only in this FORGE_DAEMON_SCOPE
//   FAKE_CLAUDE_MISSING       with --resume: an error `result` on stdout, "No conversation found…" on stderr, exit 1
//   FAKE_CLAUDE_EXIT          exit at once with this code, writing nothing
//   FAKE_CLAUDE_EXIT_SCOPE    exit at once (code FAKE_CLAUDE_EXIT, else 1) only in this FORGE_DAEMON_SCOPE
//   FAKE_CLAUDE_RESULT_ERROR  end every turn with an is_error result carrying this text (an expired login, say)
//   FAKE_CLAUDE_SUBAGENT      per turn: an Agent call to forge:builder, two child lines, its result and a costed result
//   FAKE_CLAUDE_IGNORE_TERM   ignore SIGTERM (only SIGKILL stops it)
//   FAKE_CLAUDE_IGNORE_EOF    keep running after stdin ends
//   FAKE_CLAUDE_ASK           per turn: a can_use_tool control_request for this Bash command, held until its control_response;
//                             the result then says what the answer was
//   FAKE_CLAUDE_REFUSE_MODE   answer a set_permission_mode to this mode with an error, as claude does for a mode it can't enter
// Like claude 2.1.299: init reports --permission-mode (manual read as default), and a set_permission_mode control_request is
// answered with a control_response, then a system/status event carrying the new mode.
import fs from 'node:fs';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const flag = (/** @type {string} */ name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const env = process.env;
const log = (/** @type {any} */ rec) => {
  if (env.FAKE_CLAUDE_LOG) fs.appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, ...rec }) + '\n');
};
const scope = env.FORGE_DAEMON_SCOPE ?? null;
log({ argv, scope });

const resume = flag('--resume');
const session = resume ?? flag('--session-id') ?? 'no-session';
if (env.FAKE_CLAUDE_IGNORE_TERM) process.on('SIGTERM', () => {});
// Exits use exitCode, never process.exit(): stdout to a pipe is asynchronous on macOS, so an
// explicit exit could drop the last line.
if (env.FAKE_CLAUDE_EXIT_SCOPE) {
  if (env.FAKE_CLAUDE_EXIT_SCOPE === scope) process.exitCode = Number(env.FAKE_CLAUDE_EXIT ?? 1);
  else serve();
} else if (env.FAKE_CLAUDE_EXIT) process.exitCode = Number(env.FAKE_CLAUDE_EXIT);
else if (resume && env.FAKE_CLAUDE_MISSING) {
  // What claude 2.1 does (recorded in docs/ARCHITECTURE.md "Daemon"): one error result, then exit 1.
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id: resume }) + '\n');
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  process.exitCode = 1;
} else serve();

function serve() {
  const delay = !env.FAKE_CLAUDE_DELAY_SCOPE || env.FAKE_CLAUDE_DELAY_SCOPE === scope ? Number(env.FAKE_CLAUDE_DELAY_MS ?? 0) : 0;
  let turn = 0;
  const out = (/** @type {any} */ ev) => process.stdout.write(JSON.stringify(ev) + '\n');
  let first = true;
  const asked = flag('--permission-mode');
  let mode = asked === null || asked === 'manual' ? 'default' : asked;
  /** control_request ids waiting for an answer, and what to do with it. */
  const pending = new Map();
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    log({ stdin: line });
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg?.type === 'control_response' && pending.has(msg.response?.request_id)) {
      const done = pending.get(msg.response.request_id);
      pending.delete(msg.response.request_id);
      return done(msg.response.response?.behavior ?? 'error');
    }
    if (msg?.type === 'control_request' && msg.request?.subtype === 'set_permission_mode') {
      const next = msg.request.mode;
      if (next === env.FAKE_CLAUDE_REFUSE_MODE)
        return out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `Cannot set permission mode to ${next}` } });
      mode = next;
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { mode } } });
      return out({ type: 'system', subtype: 'status', status: null, permissionMode: mode, session_id: session });
    }
    if (msg?.type !== 'user') return;
    if (first) out({ type: 'system', subtype: 'init', session_id: session, permissionMode: mode });
    first = false;
    out({ type: 'assistant', session_id: session, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
    turn++;
    if (env.FAKE_CLAUDE_SUBAGENT) subagent(out, session, turn);
    const cost = env.FAKE_CLAUDE_SUBAGENT ? { total_cost_usd: 0.25, num_turns: 3, duration_ms: 1200 } : {};
    const failed = env.FAKE_CLAUDE_RESULT_ERROR ? { is_error: true, result: env.FAKE_CLAUDE_RESULT_ERROR } : { is_error: false };
    const finish = (/** @type {string | null} */ answer) =>
      setTimeout(() => out({ type: 'result', subtype: 'success', session_id: session, ...cost, ...failed, ...(answer ? { result: `permission: ${answer}` } : {}) }), delay);
    if (!env.FAKE_CLAUDE_ASK) return finish(null);
    const requestId = `ask-${turn}`;
    pending.set(requestId, finish);
    out({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: env.FAKE_CLAUDE_ASK, description: 'Copy the fonts into the worktree' },
        description: 'Copy the fonts into the worktree',
        agent_id: 'a1b2c3',
        permission_suggestions: [
          { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: env.FAKE_CLAUDE_ASK }], behavior: 'allow', destination: 'localSettings' },
          { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        ],
        tool_use_id: `toolu_ask_${turn}`,
      },
    });
  });
  // Without IGNORE_EOF the process ends on its own once stdin closes and pending results are out.
  if (env.FAKE_CLAUDE_IGNORE_EOF) setInterval(() => {}, 1 << 30);
}

/** What a real orchestrator turn looks like when it spawns a builder: the shape the session log groups. */
function subagent(/** @type {(ev: any) => void} */ out, /** @type {string} */ session, /** @type {number} */ turn) {
  const id = `toolu_agent_${turn}`;
  out({
    type: 'assistant',
    session_id: session,
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'forge:builder', description: 'Build round 1', prompt: 'Implement the spec.' } }] },
  });
  out({ type: 'assistant', session_id: session, parent_tool_use_id: id, message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_child_${turn}`, name: 'Bash', input: { command: 'forge run job test' } }] } });
  out({ type: 'user', session_id: session, parent_tool_use_id: id, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_child_${turn}`, content: 'tests pass' }] } });
  out({ type: 'user', session_id: session, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'BUILD: done · 1 commit' }] } });
}
