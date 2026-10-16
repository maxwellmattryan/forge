// `forge doctor`: is this machine and repo ready for Forge, and with --bundle, a redacted support
// bundle (lib/bundle.ts) a user can attach to a bug report. The manifest goes to stderr before the
// file is written, so the user sees what it holds.
import fs from 'node:fs';
import path from 'node:path';
import { buildBundle, bundleFileName } from '../bundle.ts';
import { doctor } from '../doctor.ts';
import { validJobId } from '../requests.ts';
import { ForgeError } from '../util.ts';
import { zip } from '../zip.ts';
import { str } from './args.ts';
import type { BundleEntry, BundleResult, CliContext, Dispatched, HelpGroup } from '../types.ts';

const DOCTOR: HelpGroup = {
  name: 'doctor',
  summary: 'check this repo and machine for Forge',
  commands: [
    {
      command: 'doctor',
      args: '[<job>] [--bundle] [--out <dir>] [--include-text]',
      summary: 'check this repo and machine for Forge (tools, config, job files) and print what is wrong, indented; --bundle writes a redacted support bundle for a bug report',
      flags: [
        ['--bundle [<job>]', "write forge-support-<date>.zip: doctor, versions, redacted config, and the job's (default: every active job's) events, step, verify and daemon logs, with paths, logins, emails and likely secrets redacted; the manifest prints to stderr first"],
        ['--out <dir>', 'an existing directory to write the bundle to (default: the current directory)'],
        ['--include-text', "add the job dir's markdown and the branch diff, still redacted (left out by default)"],
      ],
      exits: [[1, 'bundle: an invalid or unknown job, a bad --out, a write failure, or a daemon session']],
      docs: ['Support bundle', 'docs/CLI.md#support-bundle'],
      readme: true,
    },
  ],
};

export const HELP: HelpGroup[] = [DOCTOR];

const MAX_SUFFIX = 100;

/** B under 1 KiB, then KiB and MiB with one decimal. */
export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

/** The manifest lines stderr gets before the write. */
export function manifestText(entries: BundleEntry[], r: Pick<BundleResult, 'skipped' | 'redactions' | 'includeText'>): string {
  const total = entries.reduce((n, e) => n + e.bytes, 0);
  const w = Math.max(...entries.map((e) => e.name.length));
  const lines = [`Support bundle: ${entries.length} files, ${humanSize(total)} before compression`];
  for (const e of entries) lines.push(`  ${e.name.padEnd(w + 2)}${humanSize(e.bytes).padStart(10)}`);
  if (r.skipped.length) lines.push(`Skipped: ${r.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}`);
  const c = r.redactions;
  lines.push(`Redacted: ${c.secrets} secrets, ${c.paths} paths, ${c.emails} emails, ${c.logins} logins`);
  if (!r.includeText) lines.push('Agent text and diffs left out; --include-text adds them.');
  return lines.join('\n') + '\n';
}

/** `-2`, `-3`… before `.zip`. */
const suffixed = (name: string, i: number): string => (i === 1 ? name : name.replace(/\.zip$/, `-${i}.zip`));

export async function doctorCmd(ctx: CliContext, pos: string[], flags: Record<string, any>): Promise<Dispatched> {
  const { root, config, initialized } = ctx;
  if (!flags.bundle) return { data: await doctor(root, config, initialized), exitCode: 0, pretty: true };
  // A reporting action for a human: a session must not use it to write files outside .forge/.
  if (process.env.FORGE_DAEMON === '1') throw new ForgeError('forge doctor --bundle is for a human; run it in your own terminal');
  if (Array.isArray(flags.bundle)) throw new ForgeError('--bundle given more than once', 'usage');
  const job: string | undefined = typeof flags.bundle === 'string' ? flags.bundle : pos[0];
  if (job !== undefined && !validJobId(job)) throw new ForgeError(`invalid job id ${JSON.stringify(String(job).slice(0, 80))}`);
  const outDir = path.resolve(str(flags.out, '--out') ?? '.');
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(outDir);
  } catch {}
  if (!st?.isDirectory()) throw new ForgeError(`--out ${outDir} is not an existing directory`);

  const includeText = flags['include-text'] === true;
  const date = new Date();
  const { entries, manifest } = await buildBundle(root, config, initialized, { job, includeText });
  const buf = zip(entries, date);
  const listed = entries.map((e) => ({ name: e.name, bytes: e.data.length }));
  process.stderr.write(manifestText(listed, { ...manifest, includeText }));

  const base = bundleFileName(date);
  for (let i = 1; i <= MAX_SUFFIX; i++) {
    const file = path.join(outDir, suffixed(base, i));
    if (fs.existsSync(file) || isLink(file)) continue;
    process.stderr.write(`Writing ${file}\n`);
    try {
      // O_EXCL: a file (or a link) planted at the name is never followed or overwritten.
      fs.writeFileSync(file, buf, { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw new ForgeError(`could not write ${file}: ${(e as Error).message}`);
    }
    const result: BundleResult = {
      file,
      bytes: buf.length,
      entries: manifest.entries,
      skipped: manifest.skipped,
      redactions: manifest.redactions,
      includeText,
      jobs: manifest.jobs,
    };
    return { data: result, exitCode: 0 };
  }
  throw new ForgeError(`could not write ${base}: ${MAX_SUFFIX} bundles from today are already in ${outDir}`);
}

function isLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}
