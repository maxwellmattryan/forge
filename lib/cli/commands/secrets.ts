// `forge secrets scan`: what the secret scanner (lib/secrets.ts) finds in a job's branch and PR
// text, or in the main checkout's tracked files. This module, not lib/secrets.ts, imports lib/pr.ts:
// pr.ts imports the scanner.
import { loadJob } from '../../core/job/store.ts';
import { exists } from '../../core/paths.ts';
import { prText } from '../../engine/pr/lifecycle.ts';
import { applyAllowlist, findingLine, scanBranch, scanPaths, scanUnits, textUnit } from '../../engine/guard/secrets.ts';
import { knownValues } from '../../engine/guard/known-secrets.ts';
import { checkSecret } from '../../engine/guard/secret-refs.ts';
import { secretSourceOf } from '../../core/config/validators/secret-refs.ts';
import { ForgeError } from '../../core/errors.ts';
import { list, usageError } from './args.ts';
import type { CliContext, Config, Dispatched, HelpGroup, SecretScan } from '../../core/types.ts';

const SECRETS: HelpGroup = {
  name: 'secrets',
  summary: 'scan for likely credentials before anything leaves the machine',
  commands: [
    {
      command: 'secrets scan',
      args: '[<id> | --paths <globs>]',
      summary:
        "report likely credentials, masked with their fingerprints: a job's commits, commit messages, net diff, staged changes and PR title and body, or the main checkout's tracked files matching the globs; prints text (--json for the full result)",
      flags: [['--paths <globs>', "scan the main checkout's tracked files matching these globs (comma-separated or repeated) instead of a job"]],
      exits: [
        [1, 'a finding, an incomplete scan, or no such job or worktree'],
        [5, 'git failed'],
      ],
      readme: true,
    },
    {
      command: 'secrets list',
      args: '',
      summary: 'the declared secret references (`secrets` in .forge/config.yml): each name and its source kind, resolving nothing',
      readme: true,
    },
    {
      command: 'secrets check',
      args: '[<name>...]',
      summary: 'resolve each named secret (every declared one by default) from its source and report ok or the error; never prints a value or its length',
      exits: [[1, 'a secret failed to resolve']],
      readme: true,
    },
  ],
};

export const HELP: HelpGroup[] = [SECRETS];

/** The text report: a summary line, one line per finding, then the allowed ones and allowlist problems. */
function report(scan: SecretScan, target: string): string {
  const lines = [`SECRETS: ${scan.findings.length} found, ${scan.allowed.length} allowed (${target})`];
  for (const f of scan.findings) lines.push(findingLine(f));
  for (const f of scan.allowed) lines.push(`allowed  ${findingLine(f)}  ${f.allowedBy}`);
  for (const p of scan.allowlist.problems) lines.push(`allowlist: ${p}`);
  return lines.join('\n');
}

const json = (scan: SecretScan, target: Record<string, unknown>) => ({
  target,
  count: scan.findings.length,
  allowed: scan.allowed.length,
  findings: scan.findings,
  allowedFindings: scan.allowed,
  scanned: scan.scanned,
  allowlist: { file: scan.allowlist.file, present: scan.allowlist.present, entries: scan.allowlist.entries, problems: scan.allowlist.problems },
});

/** `forge secrets list|check`: names and source kinds, plus ok or the error for check; never a value. */
function refs(root: string, config: Config, sub: 'list' | 'check', names: string[]): Dispatched {
  const declared = Object.entries(config.secrets ?? {}).map(([name, entry]) => ({ name, source: secretSourceOf(entry) ?? 'invalid' }));
  if (sub === 'list') {
    if (names.length) throw usageError(SECRETS, 'list');
    return { data: { secrets: declared }, exitCode: 0 };
  }
  const unknown = names.filter((n) => !declared.some((d) => d.name === n));
  if (unknown.length) throw new ForgeError(`not a declared secret: ${unknown.map((n) => JSON.stringify(n.slice(0, 80))).join(', ')}`, 'usage');
  const picked = names.length ? declared.filter((d) => names.includes(d.name)) : declared;
  const secrets = picked.map((d) => ({ ...d, ...checkSecret(root, config, d.name) }));
  return { data: { secrets }, exitCode: secrets.every((s) => s.ok) ? 0 : 1 };
}

export function secretsCmd(ctx: CliContext, sub: string | undefined, rest: string[], flags: Record<string, any>): Dispatched {
  const { root, config } = ctx;
  if (sub === 'list' || sub === 'check') return refs(root, config, sub, rest);
  if (sub !== 'scan') throw usageError(SECRETS);
  const globs = list(flags.paths);
  const id = rest[0];
  if ((id === undefined) === (flags.paths === undefined) || rest.length > 1 || (flags.paths !== undefined && !globs.length)) throw usageError(SECRETS, 'scan');
  let scan: SecretScan;
  let target: Record<string, unknown>;
  let summary: string;
  if (id !== undefined) {
    const job = loadJob(root, id);
    if (!job.worktree || !exists(job.worktree)) throw new ForgeError(`job ${job.id} has no worktree yet; run: forge worktree create ${job.id}`);
    scan = scanBranch(root, config, job, { staged: true });
    if (config.pr.enabled && !scan.error) {
      const text = prText(root, config, job);
      const units = [textUnit('(pr title)', text.title), textUnit('(pr body)', text.body)];
      // A token in the PR text that also sits in the branch is still reported here: it is another place.
      const more = applyAllowlist(scanUnits(units, { config, known: knownValues(root, job.id, config) }), scan.allowlist);
      scan = { ...scan, findings: [...scan.findings, ...more.findings], allowed: [...scan.allowed, ...more.allowed], scanned: { ...scan.scanned, texts: scan.scanned.texts + units.length } };
    }
    target = { job: job.id };
    summary = `${job.id}, base ${scan.base ?? 'unresolved'} @ ${scan.mergeBase ? scan.mergeBase.slice(0, 7) : '-'}, ${scan.scanned.commits} commit${scan.scanned.commits === 1 ? '' : 's'}`;
  } else {
    scan = scanPaths(root, config, globs);
    target = { paths: globs };
    summary = `paths ${globs.join(', ')}, ${scan.scanned.files} file${scan.scanned.files === 1 ? '' : 's'}`;
  }
  if (scan.error) throw new ForgeError(`secret scan incomplete: ${scan.error}`);
  return { data: flags.json ? json(scan, target) : report(scan, summary), exitCode: scan.findings.length ? 1 : 0 };
}
