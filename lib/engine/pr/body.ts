// The PR title and body Forge sends: summary, escalation approval, sibling links and issue lines.
import path from 'node:path';
import { isActive, isForemanActor, jobDir, listJobs, readEvents } from '#core/job/store.ts';
import { isSafeUrl, nativeRef, sameIssue } from '#core/job/issue-ref.ts';
import { localRepoSlug } from '#integrations/git/repo-slug.ts';
import { MARKER } from '#integrations/github/pull-requests.ts';
import { isLinkedJob } from '../project/repo-order.ts';
import { attributionForbidden, stripAttribution } from '../guard/attribution.ts';
import type { ActorSource, Config, Job, JobEvent } from '#core/types.ts';
import { readText } from '#core/os/fs.ts';
import { safeText } from '#core/text.ts';

// The sibling line's section: Forge rewrites only what sits between these, so a human's edits to
// the rest of a linked job's PR body survive every update.
export const SIBLINGS_START = '<!-- forge:siblings -->';
export const SIBLINGS_END = '<!-- /forge:siblings -->';

/**
 * The PR title and body exactly as `forge pr open` sends them, so the secret scan (and
 * `forge secrets scan`) reads the same text gh would receive.
 */
export function prText(root: string, config: Config, job: Job, title?: string): { title: string; body: string } {
  return { title: title ?? job.title, body: prBody(root, config, job) };
}

/** A person's approval of the job's latest escalation: escalationApproval. */
export interface EscalationApproval {
  reason: string;
  login: string | null;
  source: ActorSource;
  ts: string;
}

/**
 * The approval the PR body and the merge comment name: the first `approve` after the job's latest
 * park on `escalation`, when a person (not the foreman) gave it. Null otherwise.
 */
export function escalationApproval(events: JobEvent[]): EscalationApproval | null {
  const park = events.findLastIndex((e) => e.type === 'transition' && (e.to as { state?: unknown; waitingOn?: unknown } | null)?.state === 'waiting' && (e.to as { waitingOn?: unknown }).waitingOn === 'escalation');
  if (park < 0) return null;
  const approve = events.slice(park + 1).find((e) => e.type === 'human' && e.action === 'approve');
  if (!approve || isForemanActor(approve) || typeof approve.ts !== 'string') return null;
  const actor = approve.actor && typeof approve.actor === 'object' ? approve.actor : { login: null, source: 'unknown' as const };
  // One line: breaks become spaces before safeText drops the remaining control characters and backticks.
  const oneLine = String(events[park].reason ?? '').replace(/[\r\n\t\u2028\u2029]+/g, ' ');
  const reason = safeText(oneLine, 200).replace(/ {2,}/g, ' ').trim().replace(/[.\s]+$/, '') || 'no reason recorded';
  return { reason, login: actor.login, source: actor.source, ts: approve.ts };
}

/**
 * Sources whose login may be published. A `gh` login is already public on GitHub and `FORGE_ACTOR`
 * is a name someone chose to record; `dashboard`, `os` and `git` are a local account name or a raw
 * email address, which a public PR or issue must never carry.
 */
const PUBLIC_LOGIN_SOURCES: readonly ActorSource[] = ['gh', 'env'];

/**
 * `` `<login>` (<source>) on <YYYY-MM-DD> `` for a public source, else `a person (<source>) on <YYYY-MM-DD>`.
 * The login sits in a code span, so it can never mention anyone or carry markdown.
 */
export function approvedBy(a: EscalationApproval): string {
  const date = a.ts.slice(0, 10);
  const login = (a.login ?? '').replace(/`/g, '');
  if (!login || !PUBLIC_LOGIN_SOURCES.includes(a.source)) return `a person (${a.source}) on ${date}`;
  return `\`${login}\` (${a.source}) on ${date}`;
}

function prBody(root: string, config: Config, job: Job): string {
  const dir = jobDir(root, job.id);
  const custom = readText(path.join(dir, 'pr.md')).trim();
  const parts = [custom || `## Summary\n\n${firstParagraph(readText(path.join(dir, 'spec.md'))) || job.title}`];
  const approval = escalationApproval(readEvents(root, job.id));
  // The reason was written by an agent that read untrusted text, so it goes in a code span: no
  // mention, link, image or HTML in it renders on a public PR (safeText already removed backticks).
  if (approval) parts.push(`## Decision\n\nEscalated: \`${approval.reason}\`. Approved by ${approvedBy(approval)}.`);
  if (isLinkedJob(job)) parts.push(`${SIBLINGS_START}\n${SIBLINGS_END}`);
  const issueLines = issueReferences(root, config, job);
  if (issueLines.length) parts.push(issueLines.join('\n'));
  parts.push(MARKER);
  const body = parts.join('\n\n') + '\n';
  return attributionForbidden(config) ? stripAttribution(body) : body;
}

/**
 * One line per issue: `Closes #N` for this repo's GitHub issues, `Closes owner/repo#N` for another
 * repo's, `Refs` instead when another active job carries the issue (its PR must not close it under
 * that job) or pr.closeIssue is off, and `Source: <url>` for any other issue with a url. The refs come
 * from normalised job.json, so they match the stored grammar and carry no markdown.
 */
function issueReferences(root: string, config: Config, job: Job): string[] {
  const issues = Array.isArray(job.issues) ? job.issues : [];
  if (!issues.length) return [];
  const slug = localRepoSlug(root, config);
  const others = listJobs(root).filter((j) => j.id !== job.id && isActive(j));
  const lines: string[] = [];
  for (const i of issues) {
    if (i.tracker === 'github' && i.ref) {
      const native = nativeRef(i, 'github', slug);
      const shared = others.some((o) => o.issues.some((x) => sameIssue(x, i, slug)));
      lines.push(`${config.pr.closeIssue && !shared ? 'Closes' : 'Refs'} ${native ? `#${native}` : i.ref}`);
    } else if (isSafeUrl(i.url)) lines.push(`Source: ${i.url}`);
  }
  return lines;
}

function firstParagraph(md: string): string {
  return md.replace(/^#.*$/gm, '').trim().split(/\n\s*\n/)[0]?.trim() ?? '';
}

/**
 * A member PR's body: the summary, the (empty) siblings section linkSiblingPrs fills, then the marker.
 * No Closes or Refs lines.
 */
export function memberPrBody(root: string, config: Config, job: Job): string {
  const summary = `## Summary\n\n${firstParagraph(readText(path.join(jobDir(root, job.id), 'spec.md'))) || job.title}`;
  const body = [summary, `${SIBLINGS_START}\n${SIBLINGS_END}`, MARKER].join('\n\n') + '\n';
  return attributionForbidden(config) ? stripAttribution(body) : body;
}

/**
 * `body` with `line` between the first SIBLINGS_START and the next SIBLINGS_END, or null when either
 * marker is missing (a human removed them, so Forge no longer owns any part of the body).
 */
export function spliceSiblings(body: string, line: string): string | null {
  const s = body.indexOf(SIBLINGS_START);
  if (s < 0) return null;
  const from = s + SIBLINGS_START.length;
  const e = body.indexOf(SIBLINGS_END, from);
  if (e < 0) return null;
  return `${body.slice(0, from)}\n${line}\n${body.slice(e)}`;
}
