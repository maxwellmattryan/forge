// The release scripts' one git runner: lib/git.ts's pins and clean env, so lib/ and scripts/ share
// one pin list. Each script keeps its own error handling around it.
import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';
import { gitEnv, pinArgs } from '../lib/integrations/git/runner.ts';

type GitSyncOpts = Omit<SpawnSyncOptions, 'env' | 'encoding'> & { env?: NodeJS.ProcessEnv };

export function gitSync(args: string[], opts: GitSyncOpts & { encoding: 'buffer' }): SpawnSyncReturns<Buffer>;
export function gitSync(args: string[], opts?: GitSyncOpts & { encoding?: 'utf8' }): SpawnSyncReturns<string>;
export function gitSync(args: string[], opts: GitSyncOpts & { encoding?: 'utf8' | 'buffer' } = {}): SpawnSyncReturns<string | Buffer> {
  return spawnSync('git', [...pinArgs(), ...args], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', ...opts, env: opts.env ?? gitEnv() });
}
