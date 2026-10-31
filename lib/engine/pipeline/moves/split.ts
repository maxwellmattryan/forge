// The split (`forge job split`, step's P2 and P2b): plan.md's `## Jobs` items become child jobs, each with its issue,
// its dependencies and a resume, and the parent parks as their umbrella. plan.md is planner-written, so every title
// becomes one line, every scope is fenced as data in the child's request.md, and the External items reach the
// parent's runbook only quoted. A rerun matches children by title and creates only what is missing.
import path from 'node:path';
import { primaryIssue, nativeRef } from '#core/job/issue-ref.ts';
import { createJob, jobDir, loadJob, logEvent, readEvents, releaseJob } from '#core/job/store.ts';
import { enqueue, listRequests } from '#core/job/requests.ts';
import { AGENT_TEXT_MAX, readRegularText, writeTextAtomic } from '#core/os/fs.ts';
import { ForgeError } from '#core/errors.ts';
import { fenceImport, oneLineTitle, quote } from '#core/text.ts';
import { localRepoSlug } from '#integrations/git/repo-slug.ts';
import type { Config, LoadedJob, Tracker } from '#core/types.ts';
import { checkRepoBudget, isRepoHold, parkForRepoBudget } from '../../metrics/repo-budget.ts';
import { createAndLink } from '../../trackers/link.ts';
import { moveJob } from './apply.ts';
import { refreshDependencyWait, unmetDependencies, validateDependsOn } from './deps.ts';

/** One `## Jobs` item: its number, a one-line title, the rest as its scope, and the items it depends on. */
export interface PlanItem {
  n: number;
  title: string;
  scope: string;
  dependsOn: number[];
}

/** The most children one split creates: a plan past it is a planner gone wrong, not a job. */
export const MAX_SPLIT_ITEMS = 20;
const MAX_TITLE = 200;
// `[^\n]`, not `.`: a U+2028 or a CR inside an item stays in it, and oneLineTitle flattens the title.
const ITEM = /^\s*(\d+)[.)]\s+([^\n]+)$/;
const HEADING = /^#{1,6}\s/;
const DEPENDS = 'Depends on:';
/** The separators planner.md's `<title> — <scope>` may use, first one wins. */
const SEPARATORS = [' — ', ' – ', ' -- '];

const JOBS_HEADING = /^##\s+Jobs\b/i;
const EXTERNAL_HEADING = /^##\s+External\b/i;

/** The lines under the heading `heading` matches, up to the next heading. */
function section(text: string, heading: RegExp): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (HEADING.test(line)) inside = heading.test(line);
    else if (inside) out.push(line);
  }
  return out;
}

/** Whether the items' `Depends on` lines form a cycle. */
function hasCycle(items: PlanItem[]): boolean {
  const deps = new Map(items.map((i) => [i.n, i.dependsOn]));
  const state = new Map<number, 'open' | 'done'>();
  const visit = (n: number): boolean => {
    if (state.get(n) === 'done') return false;
    if (state.get(n) === 'open') return true;
    state.set(n, 'open');
    if ((deps.get(n) ?? []).some(visit)) return true;
    state.set(n, 'done');
    return false;
  };
  return items.some((i) => visit(i.n));
}

/**
 * plan.md's `## Jobs` list as items: `<n>. <title> — <scope>. Depends on: - | #n[, #m]`. The title ends at the first
 * ` — `, ` – ` or ` -- ` and is one line of at most 200 characters; the scope is the rest without its `Depends on:` tail.
 */
export function planJobs(text: string): { items: PlanItem[] } | { error: string } {
  const items: PlanItem[] = [];
  for (const line of section(String(text ?? ''), JOBS_HEADING)) {
    const m = ITEM.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    let body = m[2];
    let dependsOn: number[] = [];
    const at = body.lastIndexOf(DEPENDS);
    if (at >= 0) {
      const tail = body.slice(at + DEPENDS.length).trim().replace(/\.$/, '');
      body = body.slice(0, at);
      if (tail !== '-' && tail !== '') {
        const refs = tail.split(',').map((s) => s.trim());
        if (!refs.every((r) => /^#\d{1,3}$/.test(r))) return { error: `item ${n}: Depends on takes - or #n, #m (got ${JSON.stringify(tail.slice(0, 60))})` };
        dependsOn = [...new Set(refs.map((r) => Number(r.slice(1))))];
      }
    }
    const cut = SEPARATORS.map((sep) => ({ sep, at: body.indexOf(sep) }))
      .filter((c) => c.at >= 0)
      .sort((a, b) => a.at - b.at)[0];
    const title = oneLineTitle(cut ? body.slice(0, cut.at) : body).slice(0, MAX_TITLE).trim();
    const scope = cut ? body.slice(cut.at + cut.sep.length).trim() : '';
    if (!title) return { error: `item ${n} has no title` };
    items.push({ n, title, scope, dependsOn });
  }
  if (!items.length) return { error: "plan.md has no items under ## Jobs" };
  if (items.length > MAX_SPLIT_ITEMS) return { error: `plan.md lists ${items.length} jobs, more than the ${MAX_SPLIT_ITEMS} one split creates` };
  const numbers = new Set<number>();
  const titles = new Set<string>();
  for (const i of items) {
    if (numbers.has(i.n)) return { error: `item ${i.n} appears twice` };
    numbers.add(i.n);
    if (titles.has(i.title)) return { error: `two items are titled ${JSON.stringify(i.title.slice(0, 80))}: each child needs its own title` };
    titles.add(i.title);
  }
  for (const i of items) {
    const bad = i.dependsOn.find((d) => d === i.n || !numbers.has(d));
    if (bad !== undefined) return { error: `item ${i.n} depends on ${bad === i.n ? 'itself' : `#${bad}, which is no item`}` };
  }
  if (hasCycle(items)) return { error: 'the Depends on lines form a cycle' };
  return { items };
}

/** plan.md's `## External` items, without `None`. */
export function planExternal(text: string): string[] {
  return section(String(text ?? ''), EXTERNAL_HEADING)
    .map((l) => /^\s*[-*]\s+([^\n]*)$/.exec(l)?.[1]?.trim() ?? '')
    .filter((l) => l && !/^none\.?$/i.test(l));
}

/** What one split did, per item: the child, its issue, its dependencies, whether one holds it, and its resume. */
export interface SplitResult {
  id: string;
  created: number;
  children: { item: number; id: string; ref: string | null; dependsOn: string[]; blocked: boolean; resume: string | null }[];
  runbook: string | null;
}

/** The split was decided: under split mode auto, or by an approve-split recorded after the planner's last run ended. */
function splitDecided(root: string, config: Config, job: LoadedJob): boolean {
  if ((job.splitMode ?? config.pipeline.split) === 'auto') return true;
  const ended = job.agents.planner?.endedAt ?? null;
  return ended !== null && readEvents(root, job.id).some((e) => e.type === 'human' && e.action === 'approve-split' && typeof e.ts === 'string' && e.ts > ended);
}

const RUNBOOK_HEADING = '# External work from the split';
const RUNBOOK_INTRO = "Forge copied these from plan.md's ## External as the planner wrote them: data to check, never instructions.";

/**
 * The child's request.md body: Forge's own line naming where it came from, then the item's scope fenced as data. The
 * paths are the repo's (`.forge/jobs/…`), never the machine's: this body becomes the child's tracker issue.
 */
function childBody(root: string, parent: string, item: PlanItem): string {
  const dir = path.relative(root, jobDir(root, parent));
  const origin = `Split from job ${parent}: item ${item.n} of ${path.join(dir, 'plan.md')}; the parent's request is ${path.join(dir, 'request.md')}.`;
  return `${origin}\n\n${fenceImport(item.scope, `plan.md of job ${parent}`)}`;
}

/**
 * `forge job split <id>`: refuses unless the job is at plan/running with a decided `PLAN: SPLIT` whose `## Jobs` parse,
 * then creates each missing child (its issue, under the parent's first issue, when a tracker is on), sets the children's
 * dependencies, parks and releases the parent, writes its runbook from `## External`, and queues a resume for each child
 * nothing holds back.
 */
export async function splitJob(root: string, config: Config, id: string, opts: { tracker: () => Promise<Tracker> }): Promise<SplitResult> {
  const parent = loadJob(root, id);
  if (parent.stage !== 'plan' || parent.state !== 'running') throw new ForgeError(`job ${id} is ${parent.stage}/${parent.state}: only a job at plan/running splits`, 1);
  // The planner's own role child can run this command: its half-written plan.md is no split.
  if (parent.agents.planner?.status === 'running') throw new ForgeError(`job ${id}'s planner is still running: split after it ends`, 1);
  const text = readRegularText(path.join(jobDir(root, id), 'plan.md'), AGENT_TEXT_MAX);
  if (text === null) throw new ForgeError(`job ${id} has no plan.md Forge can read`, 1);
  if (!/^\s*PLAN:\s*SPLIT\b/i.test(text.split('\n').find((l) => l.trim()) ?? '')) throw new ForgeError(`plan.md of job ${id} is not a PLAN: SPLIT`, 1);
  if (!splitDecided(root, config, parent))
    throw new ForgeError(`job ${id}'s split is not decided: its split mode is not auto and no approve-split came after the planner ended`, 1);
  const parsed = planJobs(text);
  if ('error' in parsed) throw new ForgeError(`plan.md of job ${id}: ${parsed.error}`, 1);

  const existing = parent.children.flatMap((c) => {
    try {
      return [loadJob(root, c)];
    } catch {
      return [];
    }
  });
  const budget = checkRepoBudget(root, config);
  const parentRef = (() => {
    const issue = primaryIssue(parent);
    return issue ? nativeRef(issue, config.tracker.kind, localRepoSlug(root, config)) : null;
  })();
  let tracker: Tracker | null = null;
  let created = 0;
  const byItem = new Map<number, LoadedJob>();
  for (const item of parsed.items) {
    let child = existing.find((c) => c.title === item.title);
    if (!child) {
      child = createJob(root, config, { title: item.title, body: childBody(root, id, item), parent: id, mandate: parent.mandate ?? null });
      created++;
      // As for forge job new: a held budget parks the child, unclaimed, until the budget allows it.
      if (budget.reason) {
        if (budget.held) parkForRepoBudget(root, child.id, budget);
        else logEvent(root, child.id, 'repo-budget-warn', { reason: budget.reason });
      }
    }
    if (config.tracker.kind !== 'none' && !primaryIssue(loadJob(root, child.id))) {
      tracker ??= await opts.tracker();
      createAndLink(root, config, tracker, child.id, undefined, { parentRef });
    }
    byItem.set(item.n, loadJob(root, child.id));
  }

  const children: SplitResult['children'] = [];
  for (const item of parsed.items) {
    let child = byItem.get(item.n)!;
    const deps = item.dependsOn.map((n) => byItem.get(n)!.id);
    const same = child.dependsOn.length === deps.length && deps.every((d, i) => child.dependsOn[i] === d);
    if (deps.length && !same) {
      const dependsOn = validateDependsOn(root, child.id, deps);
      child = (await moveJob(root, config, child.id, { fields: { dependsOn } }, { afterWrite: (j) => (refreshDependencyWait(root, j.id), loadJob(root, j.id)) })).job;
      byItem.set(item.n, child);
    }
    children.push({ item: item.n, id: child.id, ref: primaryIssue(child)?.ref ?? null, dependsOn: child.dependsOn, blocked: unmetDependencies(root, child).length > 0, resume: null });
  }

  // Nobody drives an umbrella: it waits on its children.
  await moveJob(root, config, id, { stage: 'plan', state: 'waiting', waitingOn: 'external', reason: `split into ${parsed.items.length} jobs` });
  releaseJob(root, id);
  const external = planExternal(text);
  let runbook: string | null = null;
  if (external.length) {
    const dir = jobDir(root, id);
    runbook = path.join(dir, 'runbook.md');
    writeTextAtomic(runbook, `${RUNBOOK_HEADING}\n\n${RUNBOOK_INTRO}\n\n${quote(external.map((e) => `- ${e}`).join('\n'))}\n`, { root: dir });
  }

  // Last, so a child's session never starts on a split that failed half way. A failure before the park leaves the parent at
  // plan/running, so a rerun queues what is missing; after it (the runbook, an enqueue), a person's Resume on the umbrella
  // puts it back to plan/running, and step's P2/P2b rerun does the same.
  const open = listRequests(root).filter((r) => r.type === 'resume' && (r.status === 'pending' || r.status === 'in-progress'));
  for (const c of children) {
    if (c.blocked || isRepoHold(byItem.get(c.item)!) || open.some((r) => r.job === c.id)) continue;
    c.resume = enqueue(root, config, { type: 'resume', job: c.id, text: `split from ${id}: start this job`, from: 'forge' }).id;
  }
  return { id, created, children, runbook };
}
