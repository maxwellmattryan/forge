// `forge update [--check] [--keep-dash]`: routed before mainRoot(), so it needs no repo or .forge/.
import { updateForge } from '../update.ts';
import { out } from './args.ts';

export async function updateCmd(flags: Record<string, any>): Promise<void> {
  // updateForge refuses daemon sessions itself, before it detects the install or spawns anything.
  const r = await updateForge({ check: Boolean(flags.check), keepDash: Boolean(flags['keep-dash']) });
  out(r, flags);
  if ('blocked' in r && r.blocked) process.exitCode = 1;
}
