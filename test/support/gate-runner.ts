// The Foreman's gate runner in-process over fakeClaude children: a runner with the trust and confine snapshot a
// pool start takes, the verdict a test answers a child with, and a config.yml edit made before that snapshot.
// Import it through test/helpers.ts like the other support helpers.
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from '#core/format/yaml.ts';
import { fakeClaude, type FakeClaudeChild } from './claude-adapter.ts';
import type { ClaudeEvent } from '#integrations/claude/types.ts';
import type { DaemonOptions, SessionContext } from '#office/session/contract.ts';
import type { GateRunner } from '#office/foreman/run.ts';

/** One runner over a scratch repo: its fake children, take() over the pending gate requests, and a wait for every run to end. */
export interface GateHarness {
  fake: ReturnType<typeof fakeClaude>;
  runner: GateRunner;
  take: () => void;
  settled: () => Promise<unknown>;
  /** What the runner asked the pool to stop for: `untrusted`, or a fatal message. */
  stops: string[];
}

/**
 * Loads the gate runner's modules and returns the harness factory. Loaded here, not at the top: test/helpers.ts
 * re-exports this module, and most test files never run a gate, so they shouldn't load the office's graph.
 */
export async function gateHarness(): Promise<(root: string, over?: DaemonOptions) => GateHarness> {
  const [{ trustDigest }, { listRequests }, { confineDigest }, { sessionOptions }, { createGateRunner }, { waitFor }] = await Promise.all([
    import('#core/config/load.ts'),
    import('#core/job/requests.ts'),
    import('#office/session/confine.ts'),
    import('#office/session/contract.ts'),
    import('#office/foreman/run.ts'),
    import('../helpers.ts'),
  ]);
  return (root, over = {}) => {
    const fake = fakeClaude();
    const o = sessionOptions({ claude: fake.adapter, graceMs: 20, retryMinMs: 1, retryMaxMs: 1, ...over, env: { ...process.env, FORGE_ROOT: root } });
    const config = () => o.readConfig(root).config;
    const trusted = trustDigest(root);
    const confined = confineDigest(root, config());
    const stops: string[] = [];
    const ctx: SessionContext = {
      trusted: () => trusted,
      confined: () => confined,
      poolWanted: () => true,
      config,
      untrusted: () => void stops.push('untrusted'),
      fatal: (m) => void stops.push(m),
      emit: () => {},
      onResult: () => {},
      onExit: () => {},
      poke: () => {},
      permissionMode: () => null,
      permissionModeRefused: () => {},
      effort: () => ({ level: null, source: 'none' }),
      model: () => null,
    };
    const runner = createGateRunner(root, { ctx, o });
    const take = () => runner.take(config(), listRequests(root, { status: 'pending' }).filter((r) => r.type === 'gate'));
    const settled = () => waitFor(() => runner.state().live === 0, { what: 'every gate run ended' });
    return { fake, runner, take, settled, stops };
  };
}

/** A costed turn's cumulative cost, on one model. */
export const gateCost = (usd: number) => ({ usd, models: { 'claude-sonnet-5-5': { usd, input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } });

/** Ends the child's turn with `text`, costed at `usd` when it is non-zero. */
export const gateAnswer = (c: FakeClaudeChild, text: string, usd = 0): void => c.emit({ kind: 'turn-ended', ok: true, text, cost: usd ? gateCost(usd) : null } as ClaudeEvent);

/** Edits config.yml before a harness takes its trust snapshot. */
export function editConfigFile(root: string, edit: (c: any) => void): void {
  const file = path.join(root, '.forge', 'config.yml');
  const c = yaml.parse(fs.readFileSync(file, 'utf8'));
  edit(c);
  fs.writeFileSync(file, yaml.stringify(c));
}
