// `forge notify test|send`: a sample notification to every configured target, and the detached
// sender lib/office/notify.ts queueNotify spawns. Delivery itself lives in lib/office/notify.ts.
import { contextFor, deliver, isNotifyEvent, isReasonCode, notifyConfigured } from '../../office/notify.ts';
import { NOTIFY_EVENTS } from '../../core/job/schema.ts';
import type { CliContext, Dispatched, HelpGroup, NotifyEvent } from '../../core/types.ts';
import { ForgeError } from '../../core/errors.ts';
import { list, usageError } from './args.ts';

const NOTIFY: HelpGroup = {
  name: 'notify',
  summary: 'push gate, PR, failure and budget notifications to webhooks and a command',
  commands: [
    {
      command: 'notify test',
      args: '[--event <name>]',
      summary:
        'send one sample notification (job null, title "Forge test notification") to every valid notify.webhooks entry regardless of its events, and run notify.command if set; prints {event, results: [{target, host, format, ok, status, error, attempts}]} and records nothing',
      flags: [['--event <name>', `the sample's event (default gate): ${NOTIFY_EVENTS.join(', ')}`]],
      exits: [[1, 'a target failed, or notify has no webhooks or command']],
      docs: ['Notifications', 'docs/CONFIG.md#notifications'],
      readme: true,
    },
    {
      command: 'notify send',
      args: '--events <e1[,e2]> [--job <id>] --reason <code>',
      summary:
        "internal: what a state change spawns, detached. Delivers to the targets that subscribe to the first matching event, reading the job's title, stage and PR url itself, and records notified or notify-failed per target on the job (else in .forge/runtime/notify.jsonl)",
      flags: [
        ['--events <e1[,e2]>', 'the events, most specific first'],
        ['--job <id>', 'the job it is about (none for a pool-wide daemon stop)'],
        ['--reason <code>', 'the reason code, mapped to a fixed English string'],
      ],
      exits: [[1, 'a target failed, or no such job']],
    },
  ],
};

export const HELP: HelpGroup[] = [NOTIFY];

const NOTHING = 'notify has no webhooks or command; see docs/CONFIG.md "Notifications"';

function eventArg(v: unknown, flag: string): NotifyEvent {
  if (!isNotifyEvent(v)) throw new ForgeError(`${flag} must be one of ${NOTIFY_EVENTS.join(', ')} (got ${JSON.stringify(String(v)).slice(0, 60)})`, 'usage', 'forge help notify');
  return v;
}

export async function notifyCmd(ctx: CliContext, sub: string | undefined, rest: string[], flags: Record<string, any>): Promise<Dispatched> {
  const { root, config } = ctx;
  if (sub === 'test') {
    if (rest.length) throw usageError(NOTIFY, 'test');
    const event = flags.event === undefined ? 'gate' : eventArg(flags.event, '--event');
    if (!notifyConfigured(config)) throw new ForgeError(NOTHING, 'failed');
    const results = await deliver(root, config, [event], { job: null, title: 'Forge test notification', stage: null, prUrl: null, reason: 'test' }, { test: true });
    const rows = results.map(({ event: _e, ...r }) => r);
    return { data: { event, results: rows }, exitCode: results.every((r) => r.ok) ? 0 : 1 };
  }
  if (sub === 'send') {
    if (rest.length) throw usageError(NOTIFY, 'send');
    const events = list(flags.events);
    if (!events.length) throw usageError(NOTIFY, 'send');
    const checked = events.map((e) => eventArg(e, '--events'));
    if (!isReasonCode(flags.reason) || flags.reason === 'test') throw new ForgeError(`--reason ${JSON.stringify(String(flags.reason)).slice(0, 60)} is not a notification reason code`, 'usage', 'forge help notify send');
    const job = flags.job === undefined ? null : String(flags.job);
    // contextFor loads the job (its title, stage and PR url), so a missing one fails here.
    const nctx = contextFor(root, job, flags.reason);
    const results = await deliver(root, config, checked, nctx);
    return { data: { events: checked, results: results.map(({ event, target, ok, error, attempts }) => ({ event, target, ok, ...(error ? { error } : {}), attempts })) }, exitCode: results.every((r) => r.ok) ? 0 : 1 };
  }
  throw usageError(NOTIFY);
}
