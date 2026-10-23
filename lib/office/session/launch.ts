// The checks every spawn passes before claude starts, on the one read of `.forge/config.yml` that
// argv is then built from. A failure is reported through the pool (ctx.fatal or ctx.untrusted), which
// stops every session.
import fs from 'node:fs';
import { daemonProblems, trackerSymlinks, trustDigest } from '#core/config/load.ts';
import { paths } from '#core/paths.ts';
import type { SessionContext, SessionOptions } from './contract.ts';
import type { Config } from '#core/types.ts';

/** The config a spawn may start on and the digest it was trusted under, or null when a check refused it. */
export function checkLaunch(root: string, ctx: SessionContext, o: SessionOptions): { config: Config; trusted: string } | null {
  const links = trackerSymlinks(root);
  if (links.length) {
    ctx.fatal(`cannot start daemon: .forge/trackers/ contains symlinks (${links.join(', ')}), whose targets the daemon can't pin; replace them with files`);
    return null;
  }
  // Respawns (idle stop, resume failure, new work) happen without a human, so they reuse the
  // pool start's snapshot. config.yml is read once, hashed, and that same text is what argv is
  // built from: a file swapped and restored between two reads (by a job's background process,
  // say) can't slip in.
  let bytes: Buffer | null = null;
  try {
    bytes = fs.readFileSync(paths(root).config);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') bytes = Buffer.from(`!${(e as NodeJS.ErrnoException).code}`);
  }
  const trusted = ctx.trusted();
  if (!trusted || trustDigest(root, bytes) !== trusted) {
    ctx.untrusted();
    return null;
  }
  let c: Config;
  try {
    c = o.readConfig(root, { text: bytes === null ? null : bytes.toString('utf8') }).config;
  } catch (e) {
    ctx.fatal(`cannot start daemon: ${(e as Error).message}`);
    return null;
  }
  if (c.daemon?.enabled !== true) {
    ctx.fatal('daemon.enabled is false in .forge/config.yml');
    return null;
  }
  const problem = daemonProblems(c, root)[0];
  if (problem) {
    ctx.fatal(problem);
    return null;
  }
  return { config: c, trusted };
}
