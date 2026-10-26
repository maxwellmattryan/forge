// Filing an approved milestone draft: the pre-flight checks that run before any write, the exact text the
// secret scan and the tracker both see, and the filing record (`.forge/runtime/mandates/<id>/filing.json`),
// written before the first tracker call and after each, so a stopped filing resumes without filing
// anything twice. Ends by turning the goal mandate into a scoped mandate over the filed milestone.
// docs/architecture/foreman.md › Milestone approval and filing.
import path from 'node:path';
import { ForgeError } from '#core/errors.ts';
import { nativeRef } from '#core/job/issue-ref.ts';
import { isForemanActor, logRepoEvent } from '#core/job/store.ts';
import { readRegular, writeJsonAtomic } from '#core/os/fs.ts';
import { isMap } from '#core/shape.ts';
import { oneLineTitle } from '#core/text.ts';
import { now } from '#core/utils.ts';
import { FILING_SCHEMA_VERSION, FILING_STEPS } from '#core/versions/filing.ts';
import { runSteps } from '#core/versions/steps.ts';
import { localRepoSlug } from '#integrations/git/repo-slug.ts';
import { refuseSecrets, textUnit } from '#engine/guard/secrets.ts';
import { SCOPE_MILESTONE_MAX, isReadable, mandateProblems, scopeEntryOk } from './contract.ts';
import { listMandates, mandateDir, writeMandate } from './store.ts';
import type { Config, EventActor, FilingView, Tracker, TrackerCtx, TrackerItem } from '#core/types.ts';
import type { Draft, DraftIssue, Filing, Mandate } from './types.ts';

const FILING_MAX_BYTES = 256 * 1024;
const ERROR_MAX = 300;
const DIGEST = /^[0-9a-f]{64}$/;
/** Tracker statuses an existing or adopted item may not have: it is no longer open. */
const CLOSED = new Set(['done', 'dropped', 'closed']);

/** A mandate's filing.json. */
export const filingFile = (root: string, id: string): string => path.join(mandateDir(root, id), 'filing.json');

const isOpen = (item: Pick<TrackerItem, 'status'>): boolean => !CLOSED.has(String(item.status ?? '').toLowerCase());
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

/**
 * A mandate's filing record, null when there is none, or `{problem}` when it can't be read safely: a
 * link, not a regular file, over 256 KiB, not JSON, a newer schemaVersion, or a shape that doesn't fit.
 * Nothing files again from an unreadable record: a person checks the tracker.
 */
export function readFiling(root: string, id: string): Filing | { problem: string } | null {
  const bytes = readRegular(filingFile(root, id), FILING_MAX_BYTES);
  if (typeof bytes === 'string') return bytes === 'unreadable (ENOENT)' ? null : { problem: bytes };
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { problem: 'not JSON' };
  }
  if (!isMap(raw)) return { problem: 'not a JSON object' };
  const v = raw.schemaVersion;
  if (!Number.isInteger(v) || (v as number) < 1) return { problem: 'schemaVersion must be a positive integer' };
  if ((v as number) > FILING_SCHEMA_VERSION) return { problem: `written by a newer Forge (schemaVersion ${v}); update the plugin` };
  const f = runSteps(FILING_STEPS, raw, v as number) as Record<string, any>;
  const ms = f.milestone;
  const issuesOk =
    isMap(f.issues) &&
    Object.values(f.issues).every((x) => isMap(x) && isStrOrNull(x.ref) && isStrOrNull(x.url) && ['created', 'reused', 'amended'].includes(x.action as string) && isStr(x.startedAt));
  const ok =
    f.mandate === id &&
    isStr(f.request) &&
    isStr(f.digest) &&
    DIGEST.test(f.digest) &&
    isStr(f.tracker) &&
    isStr(f.approvedAt) &&
    isMap(f.actor) &&
    isStrOrNull(f.note) &&
    isMap(ms) &&
    isStr(ms.title) &&
    isStrOrNull(ms.ref) &&
    isStrOrNull(ms.url) &&
    isStrOrNull(ms.startedAt) &&
    issuesOk &&
    isStrOrNull(f.error) &&
    isStrOrNull(f.completedAt);
  if (!ok) return { problem: 'its shape is not a filing record' };
  return { ...(f as Filing), schemaVersion: FILING_SCHEMA_VERSION };
}

/** The record as the CLI and the API show it, issues in draft order (from the draft when it can be read). */
export function filingView(rec: Filing, draft: Pick<Draft, 'issues'> | null): FilingView {
  const keys = draft ? draft.issues.map((i) => i.key) : Object.keys(rec.issues);
  const actionOf = (key: string) => {
    const it = draft?.issues.find((i) => i.key === key);
    return it?.existing ? (it.existing.action === 'reuse' ? 'reused' : 'amended') : 'created';
  };
  return {
    milestone: { title: rec.milestone.title, ref: rec.milestone.ref, url: rec.milestone.url },
    issues: keys.map((key) => {
      const r = rec.issues[key];
      return { key, ref: r?.ref ?? null, url: r?.url ?? null, action: r?.action ?? actionOf(key) };
    }),
    digest: rec.digest,
    error: rec.error,
    approvedAt: rec.approvedAt,
    completedAt: rec.completedAt,
  };
}

/** The draft's issues in filing order: by wave, then as the draft lists them. */
const filingOrder = (draft: Pick<Draft, 'issues'>): { it: DraftIssue; i: number }[] =>
  draft.issues.map((it, i) => ({ it, i })).sort((a, b) => a.it.wave - b.it.wave || a.i - b.i);

const maxWave = (draft: Pick<Draft, 'issues'>): number => Math.max(...draft.issues.map((i) => i.wave));

/** How a ref reads in an issue body: `#<n>` on GitHub, as the tracker returned it elsewhere. */
function shownRef(config: Config, slug: string | null, ref: string): string {
  if (config.tracker.kind !== 'github') return ref;
  return `#${nativeRef({ tracker: 'github', ref }, 'github', slug) ?? ref}`;
}

// GitHub links `@name`, and notifies that person, when a letter or digit follows the @ and no ASCII
// letter, digit or _ comes before it. A zero-width joiner after the @ breaks the link in any Markdown
// or HTML context, renders as nothing, and is not hidden text to visibleText, so a filed issue reads
// back clean. Linear: no quantifier here can match the same characters as another.
const MENTION = /(?<![A-Za-z0-9_])@(?=[A-Za-z0-9])/g;
const ZWJ = String.fromCharCode(0x200d);
// A backtick fence's info string may hold no backtick (CommonMark), so "```a`b" opens nothing.
const FENCE_OPEN = /^(`{3,}(?=[^`]*$)|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HTML_LINE = /^ {0,3}</;

/**
 * Drafter text as a GitHub body: every `@name` gets a zero-width joiner after its @, so filing pings no
 * one, except inside a fenced code block, where GitHub links nothing and a code sample keeps its bytes.
 * Only a fence opened at column 0 counts (one in a list or a quote may end with its container), and none
 * at all when a line may start an HTML block, inside which a fence is plain text: when in doubt, quieted.
 */
export function quietMentions(text: string): string {
  const lines = text.split('\n');
  const html = lines.some((l) => HTML_LINE.test(l));
  let fence: string | null = null;
  return lines
    .map((l) => {
      if (fence !== null) {
        const c = FENCE_CLOSE.exec(l);
        if (c && c[1][0] === fence[0] && c[1].length >= fence.length) fence = null;
        return l;
      }
      const o = html ? null : FENCE_OPEN.exec(l);
      if (o) {
        fence = o[1];
        return l;
      }
      return l.replace(MENTION, `@${ZWJ}`);
    })
    .join('\n');
}

/** Text as it goes out on tracker `kind`: mentions quieted on GitHub, as written elsewhere. */
const outgoing = (kind: string, text: string): string => (kind === 'github' ? quietMentions(text) : text);

/** The milestone as filed on tracker `kind`: its title, and its exit criteria and mandate as the description. */
export function composeMilestone(id: string, draft: Pick<Draft, 'milestone'>, kind: string): { title: string; description: string } {
  return { title: draft.milestone.title, description: outgoing(kind, ['Exit criteria:', ...draft.milestone.exitCriteria.map((c) => `- ${c}`), '', `Mandate: ${id}`].join('\n')) };
}

/**
 * An issue as filed on tracker `kind`: its title and the LF-joined body (Why, What to do, Done, then the
 * stat, wave, dependencies, files and milestone lines). `refOf` gives each dependency's filed or existing ref.
 */
export function composeIssue(id: string, draft: Pick<Draft, 'milestone' | 'issues'>, it: DraftIssue, refOf: (key: string) => string, kind: string): { title: string; body: string } {
  const lines = ['## Why', it.why, '', '## What to do', it.whatToDo, '', '## Done', it.done, '', `Stat: ${it.stat}`, `Wave: ${it.wave} of ${maxWave(draft)}`];
  if (it.dependsOn.length) lines.push(`Depends on: ${it.dependsOn.map(refOf).join(', ')}`);
  lines.push(`Files: ${it.files.join(', ')}`, '', `Milestone: ${draft.milestone.title} (mandate ${id})`);
  return { title: it.title, body: outgoing(kind, lines.join('\n')) };
}

/** The comment an `amend` issue gets: the same body under one line naming the milestone. */
export function composeAmendment(id: string, draft: Pick<Draft, 'milestone' | 'issues'>, it: DraftIssue, refOf: (key: string) => string, kind: string): string {
  return outgoing(kind, `Amended for milestone ${draft.milestone.title} (mandate ${id}):\n\n${composeIssue(id, draft, it, refOf, kind).body}`);
}

/** The record's ref for each key as an issue body shows it; before filing, a key without one shows as itself. */
function refsOf(config: Config, slug: string | null, rec: Filing | null) {
  return (key: string): string => {
    const ref = rec?.issues[key]?.ref;
    return ref ? shownRef(config, slug, ref) : key;
  };
}

const slugFor = (root: string, config: Config): string | null => (config.tracker.kind === 'github' ? localRepoSlug(root, config) : null);

/** The converted mandate filing ends with: scoped to the filed milestone, filed now. */
const converted = (m: Mandate, title: string, at: string): Mandate => ({ ...m, scope: { milestones: [title], labels: [], issues: [] }, filedAt: at, updatedAt: at });

/**
 * Every check before anything is written, each a ForgeError (exit 1) with the tracker, the mandate and
 * its dir left as they were: the tracker can create milestones (and add to one, for `existing`), the
 * milestone title is a valid scope milestone with no leading, trailing or repeated whitespace (the
 * backlog's headings and the trackers' milestone lists compare it as one trimmed line), the converted
 * mandate passes the contract, no open milestone or item already has the title (first attempt only: on
 * a retry they may be this filing's own), each existing ref is an open item of this repo's tracker, and
 * one secret scan over every outgoing string. On a retry, the record's tracker and digest must match.
 * No refusal quotes the draft: an assistant foreman acks with it.
 */
export function preflight(root: string, config: Config, m: Mandate, draft: Draft, digest: string, tracker: Tracker, record: Filing | null): void {
  const ctx: TrackerCtx = { root, config };
  const refuse = (why: string): never => {
    throw new ForgeError(why, 1);
  };
  const name = oneLineTitle(String(tracker.name ?? config.tracker.kind)).slice(0, 60);
  if (record) {
    if (record.tracker !== tracker.name) refuse(`filing.json was started on tracker ${oneLineTitle(record.tracker).slice(0, 60)}, not ${name}; a person checks the tracker`);
    if (record.digest !== digest) refuse(`the draft changed after approval (filing.json has ${record.digest.slice(0, 12)}, draft.json is ${digest.slice(0, 12)}); a person checks the tracker`);
  }
  if (tracker.name === 'none' || typeof tracker.createMilestone !== 'function') refuse(`tracker ${name} can't create milestones, so a draft can't be filed there`);
  if (draft.issues.some((i) => i.existing) && typeof tracker.milestoneAdd !== 'function') refuse(`tracker ${name} can't add an existing issue to a milestone, so this draft can't be filed there`);
  const title = draft.milestone.title;
  if (!scopeEntryOk(title, SCOPE_MILESTONE_MAX)) refuse(`the milestone title must be 1-${SCOPE_MILESTONE_MAX} characters, not start with "-" and have no control or hidden characters; revise the draft`);
  if (oneLineTitle(title) !== title) refuse('the milestone title must have no leading, trailing or repeated whitespace; revise the draft');
  const all = listMandates(root);
  const problems = mandateProblems(config, converted(m, title, now()), all, m);
  if (problems.length) {
    const hint = problems.some((p) => p.startsWith('order listed')) ? `; forge mandate edit ${m.id} --order graph` : '';
    refuse(`the filed mandate would break the contract: ${problems.join('; ')}${hint}`);
  }
  if (!record) {
    if (typeof tracker.milestones === 'function' && tracker.milestones(ctx).some((x) => x.title === title)) refuse("an open milestone already has the draft's milestone title; revise the draft");
    const items = tracker.list(ctx, {});
    draft.issues.forEach((it, i) => {
      if (it.existing) return;
      const hit = items.find((x) => oneLineTitle(x.title) === oneLineTitle(it.title));
      if (hit) refuse(`issues[${i}]'s title matches ${oneLineTitle(String(hit.ref)).slice(0, 100)}; revise the draft to reuse it`);
    });
  }
  const slug = slugFor(root, config);
  draft.issues.forEach((it, i) => {
    if (!it.existing) return;
    const native = nativeRef({ tracker: config.tracker.kind, ref: it.existing.ref }, config.tracker.kind, slug);
    if (native === null) refuse(`issues[${i}].existing.ref is not an issue in this repo's tracker`);
    const item = tracker.get(ctx, native!);
    if (!item) refuse(`issues[${i}].existing.ref names no item in the tracker`);
    if (!isOpen(item!)) refuse(`issues[${i}].existing.ref is no longer open; revise the draft`);
  });
  const refOf = refsOf(config, slug, record);
  const kind = config.tracker.kind;
  const ms = composeMilestone(m.id, draft, kind);
  const units = [textUnit('(milestone title)', ms.title), textUnit('(milestone description)', ms.description)];
  draft.issues.forEach((it, i) => {
    if (it.existing?.action === 'amend') units.push(textUnit(`(issues[${i}] amendment)`, composeAmendment(m.id, draft, it, refOf, kind)));
    else if (!it.existing) {
      const c = composeIssue(m.id, draft, it, refOf, kind);
      units.push(textUnit(`(issues[${i}] title)`, c.title), textUnit(`(issues[${i}] body)`, c.body));
    }
  });
  refuseSecrets(root, config, units, { what: 'the milestone draft' });
}

/** Who approved and why: what the first attempt writes into a new record. */
export interface Approval {
  request: string;
  actor: EventActor;
  note: string | null;
}

/**
 * Files `draft` (parsed from the bytes `digest` hashes) after preflight passed: the approval record and
 * its audit event on a first attempt, then the milestone, then each issue in wave order (skipping keys
 * that already have a ref, adopting the one open item with an exact title for a key a stopped attempt
 * started), each with the record written before and after its tracker call, then the mandate converted
 * and the record completed. A tracker call that throws stores its error in the record and rethrows with
 * the tracker's own code, naming where filing stopped. The tracker's error may echo drafter text (a
 * title in gh's argv, the backlog's `no milestone "…"`), so a person's refusal carries it fenced and the
 * foreman's leaves it out: the person reads it in filing.json (`forge mandate draft show`, the dashboard).
 */
export function fileDraft(root: string, config: Config, m: Mandate, draft: Draft, digest: string, tracker: Tracker, approval: Approval, record: Filing | null): FilingView {
  const ctx: TrackerCtx = { root, config };
  const file = filingFile(root, m.id);
  const save = (r: Filing) => writeJsonAtomic(file, r, { root });
  const title = draft.milestone.title;
  const rec: Filing = record ?? {
    schemaVersion: FILING_SCHEMA_VERSION,
    mandate: m.id,
    request: approval.request,
    digest,
    tracker: tracker.name,
    approvedAt: now(),
    actor: approval.actor,
    note: approval.note,
    milestone: { title, ref: null, url: null, startedAt: null },
    issues: {},
    error: null,
    completedAt: null,
  };
  if (!record) {
    save(rec);
    logRepoEvent(root, 'mandate-draft-approved', { mandate: m.id, request: approval.request, digest, note: approval.note, actor: approval.actor });
  }
  const slug = slugFor(root, config);
  const refOf = refsOf(config, slug, rec);
  const kind = config.tracker.kind;
  let where = 'milestone';
  try {
    if (!rec.milestone.ref) {
      rec.milestone.startedAt = now();
      save(rec);
      const made = tracker.createMilestone!(ctx, composeMilestone(m.id, draft, kind));
      rec.milestone.ref = String(made.ref);
      rec.milestone.url = made.url ?? null;
      save(rec);
    }
    for (const { it, i } of filingOrder(draft)) {
      if (rec.issues[it.key]?.ref) continue;
      where = `issues[${i}]`;
      const started = rec.issues[it.key];
      const labels = [`wave-${it.wave}`];
      const action = it.existing ? (it.existing.action === 'reuse' ? 'reused' : 'amended') : 'created';
      rec.issues[it.key] = { ref: null, url: null, action, startedAt: now() };
      save(rec);
      let ref: string | null = null;
      let url: string | null = null;
      if (it.existing) {
        const native = nativeRef({ tracker: config.tracker.kind, ref: it.existing.ref }, config.tracker.kind, slug)!;
        tracker.milestoneAdd!(ctx, native, { milestone: title, labels });
        if (it.existing.action === 'amend') tracker.comment(ctx, native, composeAmendment(m.id, draft, it, refOf, kind));
        ref = it.existing.ref;
      } else {
        // A stopped attempt may have created it before recording the ref: adopt that item rather than file it twice.
        if (started) {
          const matches = tracker.list(ctx, {}).filter((x) => isOpen(x) && oneLineTitle(x.title) === oneLineTitle(it.title));
          if (matches.length > 1) throw new ForgeError(`${matches.length} items match its title; a person decides`, 1);
          if (matches.length === 1) {
            ref = String(matches[0].ref);
            url = matches[0].url ?? null;
          }
        }
        if (ref === null) {
          const c = composeIssue(m.id, draft, it, refOf, kind);
          const made = tracker.create(ctx, { title: c.title, body: c.body, labels, milestone: title });
          ref = String(made.ref);
          url = made.url ?? null;
        }
      }
      rec.issues[it.key] = { ...rec.issues[it.key], ref, url };
      save(rec);
    }
  } catch (e) {
    const message = oneLineTitle((e as Error)?.message ?? String(e)).slice(0, ERROR_MAX);
    rec.error = message;
    save(rec);
    const said = isForemanActor(approval) ? ' (its error is in filing.json, for a person)' : `: ${JSON.stringify(message)}`;
    throw new ForgeError(`filing stopped at ${where}${said}; run forge mandate draft approve ${m.id} again to finish`, e instanceof ForgeError ? e.code : 1);
  }
  writeMandate(root, (all) => {
    const cur = all.find((x) => x.id === m.id);
    if (!isReadable(cur)) throw new ForgeError(`mandate ${m.id} can't be read now; filing.json keeps what was filed`, 1);
    return { mandate: converted(cur, title, now()), action: 'filed' as const, actor: approval.actor };
  });
  rec.completedAt = now();
  rec.error = null;
  save(rec);
  return filingView(rec, draft);
}
