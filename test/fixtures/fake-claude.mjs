// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, used by the
// daemon tests. Knobs (environment):
//   FAKE_CLAUDE_LOG           append {pid, argv} at start and {pid, stdin} per input line
//   FAKE_CLAUDE_DELAY_MS      delay before each `result` (default 0)
//   FAKE_CLAUDE_MISSING       with --resume: print "No conversation found…" to stderr and exit 1
//   FAKE_CLAUDE_EXIT          exit at once with this code, writing nothing
//   FAKE_CLAUDE_IGNORE_TERM   ignore SIGTERM (only SIGKILL stops it)
//   FAKE_CLAUDE_IGNORE_EOF    keep running after stdin ends
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
log({ argv });

const resume = flag('--resume');
const session = resume ?? flag('--session-id') ?? 'no-session';
if (env.FAKE_CLAUDE_IGNORE_TERM) process.on('SIGTERM', () => {});
// Exits use exitCode, never process.exit(): stdout to a pipe is asynchronous on macOS, so an
// explicit exit could drop the last line.
if (env.FAKE_CLAUDE_EXIT) process.exitCode = Number(env.FAKE_CLAUDE_EXIT);
else if (resume && env.FAKE_CLAUDE_MISSING) {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  process.exitCode = 1;
} else serve();

function serve() {
  const delay = Number(env.FAKE_CLAUDE_DELAY_MS ?? 0);
  const out = (/** @type {any} */ ev) => process.stdout.write(JSON.stringify(ev) + '\n');
  let first = true;
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    log({ stdin: line });
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg?.type !== 'user') return;
    if (first) out({ type: 'system', subtype: 'init', session_id: session });
    first = false;
    out({ type: 'assistant', session_id: session, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
    setTimeout(() => out({ type: 'result', subtype: 'success', is_error: false, session_id: session }), delay);
  });
  // Without IGNORE_EOF the process ends on its own once stdin closes and pending results are out.
  if (env.FAKE_CLAUDE_IGNORE_EOF) setInterval(() => {}, 1 << 30);
}
