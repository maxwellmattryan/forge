// `forge update [--check] [--keep-dash]`: routed before mainRoot(), so it needs no repo or .forge/.
import { updateForge } from '../update.ts';
import { out } from './args.ts';
import type { HelpGroup } from '../types.ts';

export const HELP: HelpGroup[] = [
  {
    name: 'update',
    summary: 'update this Forge install (Claude Code plugin or git clone)',
    commands: [
      {
        command: 'update',
        args: '[--check] [--keep-dash]',
        summary: "update this Forge install (plugin or clone) and restart this repo's dashboard on the new code",
        flags: [
          ['--check', 'print the install, the commands an update would run and anything blocking it, changing nothing'],
          ['--keep-dash', "don't restart the dashboard"],
        ],
        exits: [
          [1, 'the install is unknown or blocked (a clone with local changes, no upstream, a detached HEAD), a daemon session asked, or it runs on native Windows'],
          [5, 'a step it ran (claude or git) failed'],
        ],
        docs: ['Updating', 'README.md#updating'],
        readme: true,
      },
    ],
  },
];

export async function updateCmd(flags: Record<string, any>): Promise<void> {
  // updateForge refuses daemon sessions itself, before it detects the install or spawns anything.
  const r = await updateForge({ check: Boolean(flags.check), keepDash: Boolean(flags['keep-dash']) });
  out(r, flags);
  if ('blocked' in r && r.blocked) process.exitCode = 1;
}
