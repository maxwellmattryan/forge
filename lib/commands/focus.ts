// `forge focus`: which job the human is QA-ing in its worktree. A pointer plus the configured
// `checkout` steps (lib/checkout.ts), then the focused job's backing services; it starts and stops
// no background process (lib/focus.ts, lib/focus-actions.ts).
import { currentFocus, focusJob } from '../focus-actions.ts';
import type { Config, EnvironmentUpResult, FocusResponse, HelpGroup } from '../types.ts';
import { ForgeError } from '../util.ts';

const FOCUS: HelpGroup = {
  name: 'focus',
  summary: 'the job you are QA-ing by hand',
  commands: [
    {
      command: 'focus',
      args: '[<id>] [--clear]',
      summary:
        "print the focused job ({focus: {id, title, since} | null}), focus an active job, or clear focus; a pointer in .forge/runtime/focus.json that a job lets go of when it finishes. Moving it undoes the previous job's configured checkout steps and runs the new job's; a failing step rolls back and keeps the previous focus. With backing services configured, it then starts the focused job's environment (no background process) and adds environment: {ok, error?}; a failed start keeps the focus",
      flags: [['--clear', 'clear focus (succeeds when nothing is focused)']],
      exits: [[1, 'no such job, a daemon session set or cleared it, or a checkout step failed (focus unchanged)']],
      readme: true,
    },
  ],
};

export const HELP: HelpGroup[] = [FOCUS];

// Focus belongs to the human at the keyboard: a session misled by request text must not move it.
const FOCUS_DAEMON_REFUSAL = 'forge focus <id>|--clear moves the focus of the human at the keyboard, which a daemon session may not do; a human sets it from the dashboard or their own terminal';

const usage = (why: string) => new ForgeError(`${why}; usage: forge focus ${FOCUS.commands[0].args}`, 'usage', 'forge help focus');

export async function focusCmd(
  root: string,
  config: Config,
  pos: string[],
  flags: Record<string, any>,
): Promise<{ focus: FocusResponse['focus'] } | (FocusResponse & { environment?: { ok: boolean; error?: string } })> {
  if (pos.length > 1) throw usage(`unexpected argument ${JSON.stringify(pos[1]).slice(0, 60)}`);
  if (flags.clear !== undefined && flags.clear !== true) throw usage('--clear takes no value');
  const clear = flags.clear === true;
  const id = pos[0];
  if (id !== undefined && clear) throw usage('give a job id or --clear, not both');
  if (id === undefined && !clear) return { focus: currentFocus(root) };
  if (process.env.FORGE_DAEMON === '1') throw new ForgeError(FOCUS_DAEMON_REFUSAL);
  let env: EnvironmentUpResult | null = null;
  const out = await focusJob(root, clear ? null : id, 'cli', undefined, { config, onEnvironment: (r) => (env = r) });
  // CLI output only: POST /api/focus keeps its shape.
  const e = env as EnvironmentUpResult | null;
  return e ? { ...out, environment: { ok: e.ok, ...(e.error ? { error: e.error } : {}) } } : out;
}
