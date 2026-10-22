// `forge version [--json]`: routed before mainRoot(), so it needs no repo or .forge/. Its help
// entry is in CORE (lib/cli/commands/help.ts) with the other commands lib/cli/main.ts routes itself.
import { forgeVersion } from '../../engine/evals/run.ts';
import { versionInfo } from '../../engine/ops/version.ts';
import { out } from './args.ts';

export function versionCmd(flags: Record<string, any>): void {
  out(flags.json ? versionInfo() : { version: forgeVersion() }, flags);
}
