// What a human last approved for each project: the trustDigest of the files Forge trusts (config, notes,
// reviewers, CLAUDE.md, AGENTS.md…) when they pressed Start or ran `forge dash` in that repo. It is kept in
// `<FORGE_HOME>/trust/<rootLabel>` (0600, in the 0700 home), outside every session's write roots. A machine
// dashboard boots a project's pool only while its files still match, so a change nobody looked at (a
// session's, a pull's, one that stopped the daemon for a trust change) is never approved by a restart or by
// `forge dash` in another repo.
import fs from 'node:fs';
import path from 'node:path';
import { trustDigest } from '#core/config/trust.ts';
import { machinePaths } from '#core/paths.ts';
import { readRegularText, writeJsonPrivate } from '#core/os/fs.ts';
import { rootLabel } from '../environment/backing-names.ts';
import { ensureMachineDirs } from './machine-index.ts';

const RECORD_MAX_BYTES = 4096;

/** The approval record of the checkout at `root`: one file per root, named by the root's label. */
export function trustFile(home: string, root: string): string {
  return path.join(machinePaths(home).dir, 'trust', rootLabel(root));
}

/** Records the files `root` has now as approved. Only a human's act calls it: Start in the dashboard, or `forge dash` run in the repo. */
export function approveTrust(home: string, root: string): void {
  ensureMachineDirs(home);
  const file = trustFile(home, root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeJsonPrivate(file, { digest: trustDigest(root), approvedAt: new Date().toISOString() });
}

/** Whether the files `root` has now are exactly the ones a human last approved. No record, or one that doesn't read, is no. */
export function trustApproved(home: string, root: string): boolean {
  const text = readRegularText(trustFile(home, root), RECORD_MAX_BYTES);
  if (text === null) return false;
  try {
    const rec: unknown = JSON.parse(text);
    const digest = rec && typeof rec === 'object' ? (rec as { digest?: unknown }).digest : undefined;
    return typeof digest === 'string' && digest === trustDigest(root);
  } catch {
    return false;
  }
}
