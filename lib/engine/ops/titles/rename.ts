// Renaming a job under the title schema (titles.job): from spec.md's heading at the spec gate, or to
// the approver's PR title. The id, slug and branch never change; a title that fails the schema renames nothing.
import path from 'node:path';
import { jobDir, loadJob, logEvent, updateJob } from '#core/job/store.ts';
import { readRegularText } from '#core/os/fs.ts';
import type { Config } from '#core/types.ts';
import { checkTitle } from './check.ts';

export type RetitleSource = 'spec' | 'pr';

/** pr.md and spec.md are read only up to this, as regular files: the title is their first line. */
const MAX_READ = 256 * 1024;
/** pr.md's title line: `Title: <title>`, the file's first non-empty line. */
const TITLE_LINE = /^Title:[ \t]*(.*)$/;

/** The first non-empty line of a job-dir file, or null when there is none or it isn't a regular file. */
function firstLine(root: string, id: string, file: string): { line: string; index: number } | null {
  const text = readRegularText(path.join(jobDir(root, id), file), MAX_READ);
  if (text === null) return null;
  const lines = text.split('\n');
  const index = lines.findIndex((l) => l.trim());
  return index < 0 ? null : { line: lines[index].trim(), index };
}

/** The title the approver wrote on pr.md's first line, raw; null when the line isn't there. */
export function writtenPrTitle(root: string, id: string): string | null {
  const first = firstLine(root, id, 'pr.md');
  const m = first && TITLE_LINE.exec(first.line);
  return m ? m[1] : null;
}

/** pr.md's text without its `Title:` line, for the PR body. */
export function withoutTitleLine(text: string): string {
  const lines = text.split('\n');
  const index = lines.findIndex((l) => l.trim());
  if (index < 0 || !TITLE_LINE.test(lines[index].trim())) return text;
  return lines.slice(index + 1).join('\n');
}

/** spec.md's `# <title>` heading, raw; null when the first line is not a level-one heading. */
export function specHeading(root: string, id: string): string | null {
  const first = firstLine(root, id, 'spec.md');
  const m = first && /^#[ \t]+(.+)$/.exec(first.line);
  return m ? m[1] : null;
}

/** Whether titles.job lets this source rename the job: the spec under schema or pr, the PR title under pr only. */
export function renamesFrom(config: Pick<Config, 'titles'>, from: RetitleSource): boolean {
  const mode = config.titles?.job ?? 'pr';
  return from === 'spec' ? mode === 'schema' || mode === 'pr' : mode === 'pr';
}

export interface RetitleResult {
  id: string;
  retitled: boolean;
  title: string;
  from: RetitleSource;
  /** Why nothing changed: titles.job, no title written, or the schema check's problem. */
  skipped?: string;
}

/**
 * Renames job `id` to the title its spec heading or pr.md holds, when titles.job allows that source
 * and the title passes the schema. Logs `retitled { from, to, source }`, or `retitle-refused
 * { source, problem }` for a written title that fails the check; logs nothing when titles.job or a
 * missing title leaves nothing to do, or the title is already the job's.
 */
export function retitleJob(root: string, config: Config, id: string, from: RetitleSource): RetitleResult {
  const job = loadJob(root, id);
  const out = (skipped: string): RetitleResult => ({ id, retitled: false, title: job.title, from, skipped });
  if (!renamesFrom(config, from)) return out(`titles.job is ${config.titles?.job ?? 'pr'}`);
  const written = from === 'spec' ? specHeading(root, id) : writtenPrTitle(root, id);
  if (written === null) return out(from === 'spec' ? 'spec.md has no # heading' : 'pr.md has no Title: line');
  const check = checkTitle(config, written);
  if (!check.ok) {
    const problem = check.problem ?? 'the title fails the title schema';
    logEvent(root, id, 'retitle-refused', { source: from, problem });
    return out(problem);
  }
  if (check.title === job.title) return { id, retitled: false, title: job.title, from };
  let before = job.title;
  updateJob(root, id, (j) => {
    before = j.title;
    j.title = check.title;
  });
  logEvent(root, id, 'retitled', { from: before, to: check.title, source: from });
  return { id, retitled: true, title: check.title, from };
}
