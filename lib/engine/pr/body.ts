// The PR title and body Forge sends: summary, the gate section (why the merge waits on a person, or
// the escalation approval), sibling links and issue lines.
import path from 'node:path';
import { isActive, isForemanActor, jobDir, listJobs, readEvents } from '#core/job/store.ts';
import { isSafeUrl, nativeRef, sameIssue } from '#core/job/issue-ref.ts';
import { localRepoSlug } from '#integrations/git/repo-slug.ts';
import { MARKER } from '#integrations/github/pull-requests.ts';
import { isLinkedJob } from '../project/repo-order.ts';
import { attributionForbidden, stripAttribution } from '../guard/attribution.ts';
import { sections } from '../pipeline/moves/foreman-gates.ts';
import type { MergeGate } from '../pipeline/step/stages/pr.ts';
import type { ActorSource, Config, Job, JobEvent } from '#core/types.ts';
import { readRegularText, readText } from '#core/os/fs.ts';
import { safeText } from '#core/text.ts';

// The sibling line's section: Forge rewrites only what sits between these, so a human's edits to
// the rest of a linked job's PR body survive every update.
export const SIBLINGS_START = '<!-- forge:siblings -->';
export const SIBLINGS_END = '<!-- /forge:siblings -->';
// The gate section, the same way: `forge pr gate` rewrites only what sits between these.
export const GATE_START = '<!-- forge:gate -->';
export const GATE_END = '<!-- /forge:gate -->';

/** decision.md and runbook.md are read only up to this, as regular files (never through a link). */
const MAX_GATE_FILE = 256 * 1024;
/** Each quoted block in the gate section is cut here. */
const MAX_BLOCK = 4000;
/** Control characters a text block drops: all but tab and newline, and the Unicode line and paragraph separators. */
const BLOCK_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u{2028}\u{2029}]/gu;
/** Line breaks a one-line reason folds into spaces. */
const BREAKS = /[\r\n\t\u{2028}\u{2029}]+/gu;
/**
 * Every Forge section marker opens with `<!--`. Text an agent wrote goes between the gate markers with
 * that opener broken, so it can never carry a marker that `spliceSection` would take for the section's end.
 */
const noMarker = (s: string): string => s.replace(/<!--/g, '<!- -');

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
  const oneLine = String(events[park].reason ?? '').replace(BREAKS, ' ');
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

/**
 * The escalation approval line, or ''. The reason was written by an agent that read untrusted text, so
 * it goes in a code span: no mention, link, image or HTML in it renders on a public PR (safeText
 * already removed backticks).
 */
function approvalLine(events: JobEvent[]): string {
  const approval = escalationApproval(events);
  return approval ? `## Decision\n\nEscalated: \`${approval.reason}\`. Approved by ${approvedBy(approval)}.` : '';
}

/** A gate section in its markers: `text` on lines of its own, or nothing between them. */
const gateBlock = (text: string): string => (text ? `${GATE_START}\n${noMarker(text)}\n${GATE_END}` : `${GATE_START}\n${GATE_END}`);

function prBody(root: string, config: Config, job: Job): string {
  const dir = jobDir(root, job.id);
  const custom = readText(path.join(dir, 'pr.md')).trim();
  const parts = [custom || `## Summary\n\n${firstParagraph(readText(path.join(dir, 'spec.md'))) || job.title}`];
  // Always present, so `forge pr gate` can fill it later; the approval line lives inside it, never twice.
  parts.push(gateBlock(approvalLine(readEvents(root, job.id))));
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
 * `body` with `text` between `start` and `end`, or null unless the body holds each marker exactly once,
 * `start` first (a human removed them, or text copied a marker, so Forge no longer owns that part of
 * the body: a second marker would make the section's end a guess).
 */
export function spliceSection(body: string, start: string, end: string, text: string): string | null {
  const once = (marker: string): number => (body.indexOf(marker) === body.lastIndexOf(marker) ? body.indexOf(marker) : -1);
  const s = once(start);
  const e = once(end);
  if (s < 0 || e < s + start.length) return null;
  return `${body.slice(0, s + start.length)}\n${text ? `${text}\n` : ''}${body.slice(e)}`;
}

/** spliceSection over the siblings markers. */
export const spliceSiblings = (body: string, line: string): string | null => spliceSection(body, SIBLINGS_START, SIBLINGS_END, line);

/**
 * Agent-written text as a fenced text block on a public PR: control characters dropped, every run of
 * three or more backticks broken so the fence can't close early (nothing after it renders as markdown,
 * a mention or HTML), and cut at MAX_BLOCK. A section marker in it is broken by gateSection (noMarker).
 */
function textBlock(raw: string): string {
  let t = raw.replace(/\r\n?/g, '\n').replace(BLOCK_CONTROL, '').replace(/`{3,}/g, "'''").trim();
  if (t.length > MAX_BLOCK) t = `${t.slice(0, MAX_BLOCK)}\n… (truncated)`;
  return `\`\`\`text\n${t || '(empty)'}\n\`\`\``;
}

/** The body of a job-dir file's `## <title>` section, read as a regular file; '' when there is none. */
function fileSection(root: string, id: string, file: string, title: string): string {
  const text = readRegularText(path.join(jobDir(root, id), file), MAX_GATE_FILE);
  return text === null ? '' : sections(text, [title]).join('\n').trim();
}

/**
 * What `forge pr gate` puts between the gate markers. With an open merge gate: why the merge waits
 * (the reason in a code span), decision.md's `## For the human` for an escalation and runbook.md's
 * `## Steps` for a runbook, each as a text block, and who decides. Without one: the escalation
 * approval line, or nothing.
 */
export function gateSection(root: string, config: Config, job: Pick<Job, 'id'>, gate: MergeGate | null, events: JobEvent[]): string {
  let text = approvalLine(events);
  if (gate) {
    const parts = ['## Waiting on a decision before merge', `\`${safeText(gate.reason.replace(BREAKS, ' '), 200)}\``];
    if (gate.rule === 'PR15') parts.push('### For the human', textBlock(fileSection(root, job.id, 'decision.md', 'For the human')));
    if (gate.rule === 'PR16') parts.push('### Before merge', textBlock(fileSection(root, job.id, 'runbook.md', 'Steps')));
    parts.push('A person approves this gate in Forge before the PR can merge.');
    text = parts.join('\n\n');
  }
  return noMarker(attributionForbidden(config) ? stripAttribution(text) : text);
}
