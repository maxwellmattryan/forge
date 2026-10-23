// `forge audit`: the audit trail across every job and the repo-level log, for a period.
import { auditAll, parseAuditDate, toCsv } from '#engine/ops/audit.ts';
import type { HelpGroup } from '../types.ts';
import type { RepoAudit } from '#engine/ops/types.ts';
import { ForgeError } from '#core/errors.ts';

const AUDIT: HelpGroup = {
  name: 'audit',
  summary: 'export the audit trail of every job for a period',
  commands: [
    {
      command: 'audit',
      args: '--since <date> [--until <date>] [--json|--csv]',
      summary:
        "every job's audit rows (forge job audit) and the repo-level ones such as config set (job null), with since <= ts < until, sorted by time then job; dates are YYYY-MM-DD (UTC midnight) or full ISO timestamps, and until defaults to now",
      flags: [
        ['--since <date>', 'the first instant included (required)'],
        ['--until <date>', 'the first instant excluded (default now)'],
        ['--json', 'the rows as JSON (the default)'],
        ['--csv', "the rows as RFC 4180 CSV with CRLF line ends, formula-like cells prefixed with '"],
      ],
      docs: ['Audit trail', 'docs/architecture/audit-trail.md'],
      readme: true,
    },
  ],
};

export const HELP: HelpGroup[] = [AUDIT];

const usage = (why: string) => new ForgeError(`${why}; usage: forge audit ${AUDIT.commands[0].args}`, 'usage', 'forge help audit');

export function auditCmd(root: string, pos: string[], flags: Record<string, any>): RepoAudit | string {
  if (pos.length) throw usage(`unexpected argument ${JSON.stringify(pos[0]).slice(0, 60)}`);
  if (flags.json && flags.csv) throw usage('--json and --csv are exclusive');
  if (flags.since === undefined || flags.since === true) throw usage('--since is required');
  const since = parseAuditDate(flags.since, '--since');
  const until = flags.until === undefined ? new Date().toISOString() : parseAuditDate(flags.until, '--until');
  if (Date.parse(until) <= Date.parse(since)) throw usage(`--until (${until}) must be after --since (${since})`);
  const { prs, ...audit } = auditAll(root, since, until);
  return flags.csv ? toCsv(audit.rows, (job) => (job ? (prs[job] ?? null) : null)) : audit;
}
