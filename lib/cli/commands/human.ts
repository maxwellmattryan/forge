// A person at this terminal confirming a human-only operation: the CLI's half of the human channel;
// the dashboard's routes are the other (docs/architecture/daemon-security.md).
import readline from 'node:readline/promises';
import { currentActor } from '#integrations/github/actor.ts';
import { ForgeError } from '#core/errors.ts';
import type { HumanGrant } from '#core/types.ts';

/** The terminal confirmHuman asks: injected in tests, so no TTY is needed. */
export interface Terminal {
  /** stdin and stderr are both TTYs. */
  interactive: boolean;
  /** The line typed, or null when the input ended without one (Ctrl-D, Ctrl-C, stdin closing). */
  ask(prompt: string): Promise<string | null>;
}

/**
 * A terminal over `input` and `output`: this process's stdin and stderr, so stdout may be piped
 * (`forge pr merge <id> --now | jq`). Ctrl-D on an empty line, Ctrl-C or stdin closing ends the
 * readline interface with no answer, where `rl.question` alone rejects with an AbortError or never
 * settles (and the CLI would exit 0 having said nothing): that answers null.
 */
export function processTerminal(
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream & { isTTY?: boolean } = process.stderr,
): Terminal {
  return {
    interactive: input.isTTY === true && output.isTTY === true,
    ask(prompt: string): Promise<string | null> {
      const rl = readline.createInterface({ input, output });
      let answered = false;
      return new Promise<string | null>((resolve, reject) => {
        rl.once('close', () => {
          if (answered) return;
          output.write('\n'); // the refusal then starts on its own line, not after the prompt
          resolve(null);
        });
        rl.question(prompt).then((line) => {
          answered = true;
          resolve(line);
        }, reject);
      }).finally(() => rl.close());
    },
  };
}

/** A human-only operation as confirmHuman asks for it. */
export interface HumanOp {
  command: string;
  what: string;
  confirm: string;
  /**
   * The dashboard's control for it, as a noun phrase both refusals offer beside the terminal
   * ("Merge now in the dashboard"); absent when the dashboard has no route for it.
   */
  channel?: string;
}

/** `forge pr merge <id> --now`; `id` is one loadJob has validated. */
export function mergeNowOp(id: string): HumanOp {
  return {
    command: 'forge pr merge --now',
    what: `forge pr merge ${id} --now merges job ${id}'s PRs now, skipping merge.auto, the recorded approval, protected paths, the escalate floor and CI (never the merge order or a release gate). It is logged as a bypass with your name.`,
    confirm: id,
    channel: 'Merge now in the dashboard',
  };
}

/**
 * `forge job budget <id> --set|--ack`; `id` is one loadJob has validated. The --set values are argv
 * text, so the prompt names the flags, not the values. The dashboard's channel is POST /api/jobs/:id/budget.
 */
export function jobBudgetOp(id: string, change: { set: boolean; ack: boolean }): HumanOp {
  const parts = [change.set ? "raises or resets its limits (--set)" : null, change.ack ? 'acknowledges what it has spent past them, so it can go on (--ack)' : null].filter(Boolean);
  return {
    command: 'forge job budget --set|--ack',
    what: `forge job budget ${id} changes job ${id}'s spend limits: it ${parts.join(' and ')}. It is logged with your name.`,
    confirm: id,
    channel: "Approve & continue on the budget gate in the dashboard",
  };
}

/** `forge job unshelve <id>`; `id` is one loadJob has validated. The dashboard's channel is POST /api/shelf. */
export function unshelveOp(id: string): HumanOp {
  return {
    command: 'forge job unshelve',
    what: `forge job unshelve ${id} takes job ${id} off the shelf and puts it back where it was shelved, so it can spend again. It is logged with your name.`,
    confirm: id,
    channel: "Un-shelve in the dashboard's Shelved list",
  };
}

/** `forge budget ack --period P`; `period` is one validPeriod accepted. */
export function budgetAckOp(period: string): HumanOp {
  return {
    command: 'forge budget ack',
    what: `forge budget ack --period ${period} grants one more period's repo spend cap for ${period} and frees the jobs it held. It is logged with your name.`,
    confirm: period,
    channel: "Acknowledge in the dashboard's Needs you",
  };
}

/**
 * Asks the person at this terminal to type `op.confirm` back before a human-only operation, and
 * returns their grant. Refused in a daemon session, without a terminal on stdin and stderr (a
 * configured command's stdin is never one, so a piped answer is never read), and on any other answer,
 * no answer (Ctrl-D, Ctrl-C) included. Both refusals point to the terminal, and to `op.channel` only
 * when the operation has one.
 * A TTY alone is not enough: branch code can hand a nested call the person's own terminal, but it
 * can't type the id there. `what` and `confirm` reach a terminal, so they hold only ids Forge
 * validated, numbers and periods, never a title or other free text. No flag or env var skips this.
 */
export async function confirmHuman(
  root: string,
  op: HumanOp,
  term: Terminal = processTerminal(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<HumanGrant> {
  if (env.FORGE_DAEMON === '1')
    throw new ForgeError(`${op.command} is a human-only operation, which a daemon session never runs; a human runs it in their own terminal${op.channel ? ` or uses ${op.channel}` : ''}`, 'human_only');
  if (!term.interactive)
    throw new ForgeError(
      `${op.command} is a human-only operation: it needs a person at a terminal to confirm it, so an agent, a script or a configured command can't run it. Run it in your own terminal${op.channel ? `, or use ${op.channel}` : ''}`,
      'human_only',
    );
  const answer = await term.ask(`${op.what}\nType ${op.confirm} to confirm: `);
  if (answer === null || answer.trim() !== op.confirm) throw new ForgeError('not confirmed; nothing changed', 'failed');
  return { channel: 'terminal', actor: currentActor(root) };
}
