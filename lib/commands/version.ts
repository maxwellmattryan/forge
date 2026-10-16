// `forge version [--json]`: routed before mainRoot(), so it needs no repo or .forge/. Its help
// entry is in CORE (lib/commands/help.ts) with the other commands lib/cli.ts routes itself.
import { forgeVersion } from '../evals.ts';
import { versionInfo } from '../version.ts';
import { out } from './args.ts';

export function versionCmd(flags: Record<string, any>): void {
  out(flags.json ? versionInfo() : { version: forgeVersion() }, flags);
}
