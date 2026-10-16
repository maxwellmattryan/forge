// `forge focus`: which job the human is QA-ing in its worktree. A pointer only: setting it starts,
// stops and checks out nothing (lib/focus.ts, lib/focus-actions.ts).
import { currentFocus, focusJob } from '../focus-actions.ts';
import type { FocusResponse, HelpGroup } from '../types.ts';
import { ForgeError } from '../util.ts';

const FOCUS: HelpGroup = {
  name: 'focus',
  summary: 'the job you are QA-ing by hand',
  commands: [
    {
      command: 'focus',
      args: '[<id>] [--clear]',
      summary:
        "print the focused job ({focus: {id, title, since} | null}), focus an active job, or clear focus; a pointer in .forge/runtime/focus.json that starts, stops and checks out nothing, and that a job lets go of when it finishes",
      flags: [['--clear', 'clear focus (succeeds when nothing is focused)']],
      exits: [[1, 'no such job, or a daemon session set or cleared it']],
      readme: true,
    },
  ],
};

export const HELP: HelpGroup[] = [FOCUS];

// Focus belongs to the human at the keyboard: a session misled by request text must not move it.
const FOCUS_DAEMON_REFUSAL = 'forge focus <id>|--clear moves the focus of the human at the keyboard, which a daemon session may not do; a human sets it from the dashboard or their own terminal';

const usage = (why: string) => new ForgeError(`${why}; usage: forge focus ${FOCUS.commands[0].args}`, 'usage', 'forge help focus');

export function focusCmd(root: string, pos: string[], flags: Record<string, any>): { focus: FocusResponse['focus'] } | FocusResponse {
  if (pos.length > 1) throw usage(`unexpected argument ${JSON.stringify(pos[1]).slice(0, 60)}`);
  if (flags.clear !== undefined && flags.clear !== true) throw usage('--clear takes no value');
  const clear = flags.clear === true;
  const id = pos[0];
  if (id !== undefined && clear) throw usage('give a job id or --clear, not both');
  if (id === undefined && !clear) return { focus: currentFocus(root) };
  if (process.env.FORGE_DAEMON === '1') throw new ForgeError(FOCUS_DAEMON_REFUSAL);
  return focusJob(root, clear ? null : id, 'cli');
}
