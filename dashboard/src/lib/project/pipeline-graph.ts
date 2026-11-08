// The Pipeline's graph layout (issue #714): one plate per open mandate, its plan's issues laid out by dependency depth
// with each live job on its issue, then the jobs in no mandate as dependsOn chains and lone nodes. Each node's mark,
// state line, stage track, filter match and place, each edge's style, and the merges that heat an edge. Plain TS, no
// DOM access, so node:test can pin it. Job, plan and mandate text is job, tracker or owner text: it renders as text.
import type { MandatePlanResponse, MandateRow, Stage, UnreadableMandateRow } from '../core/types.ts';
import { STAGE_LABEL } from '../core/labels.ts';
import { cardModel, cardRef, filterJobs, issueLabel, STEPPER_STAGES, type StageStep } from '../jobs/board.ts';
import { isDependencyPark, stateText, stateTone, type JobLike, type Tone } from '../jobs/state.ts';
import { layoutPlan, refOrder, type PlanSize } from './plan-layout.ts';

export type GraphMark = 'merged' | 'running' | 'held' | 'waiting' | 'ready' | 'planned' | 'cancelled';
/** A node's state line; the component maps each kind to its `pipeline.graph.state.*` text. */
export type GraphLine =
  | { kind: 'merged' | 'cancelled' | 'running' | 'ready' | 'planned' }
  | { kind: 'stage'; stage: string; state: string | null }
  | { kind: 'waits'; ref: string; more: number };

export interface GNode {
  /** Unique across the graph: `<mandate id or "loose">|<key>`. */
  id: string;
  /** The layout key: the plan's ref, or `\0job <id>` for a job no plan node holds. */
  key: string;
  /** The issue the node stands for, which its issue panel opens; null for a job with no issue. */
  ref: string | null;
  /** The short ref shown: `issueLabel(ref)`, or the job's card ref or id. */
  label: string;
  title: string;
  /** The live job's id (one in the state's jobs), which the drawer opens; null for none. */
  job: string | null;
  mark: GraphMark;
  /** The live job's `stateTone`, which colours a held node's dot; null with no live job. */
  tone: Tone | null;
  line: GraphLine;
  /** Drawn dashed: no live job, or a cancelled one. */
  dashed: boolean;
  /** The 9-segment stage track, only on a started node. */
  steps: StageStep[] | null;
  /** Kept by the filter; a node that is not is dimmed, never removed. */
  match: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface GEdge {
  id: string;
  /** Node ids: `from` must finish before `to`. */
  from: string;
  to: string;
  d: string;
  /** The upstream node is merged. */
  solid: boolean;
  /** Both ends are dimmed. */
  dim: boolean;
}
export interface Block {
  width: number;
  height: number;
  nodes: GNode[];
  edges: GEdge[];
}
export interface Plate {
  id: string;
  title: string;
  state: MandateRow['state'];
  merged: number;
  total: number;
  /** loading until the mandate's first plan result; error when it failed with no earlier plan. */
  status: 'loading' | 'ready' | 'error';
  /** The last plan fetch's error, kept beside an earlier plan too; null when it succeeded. */
  error: string | null;
  /** Up to 3 of the plan's problems, as their detail text. */
  problems: string[];
  moreProblems: number;
  block: Block;
}
export interface PipelineGraph {
  plates: Plate[];
  loose: { chains: Block[]; lone: Block[]; count: number };
}

/** The fields of a mandate row the graph reads. */
export type GraphMandate = Pick<MandateRow, 'id' | 'title' | 'status' | 'state'> | UnreadableMandateRow;
export interface GraphInput {
  jobs: readonly JobLike[];
  /** GET /api/mandates' rows, or null with no list (before the first load, or after a failed one with none earlier). */
  mandates: readonly GraphMandate[] | null;
  /** Each open mandate's last good GET /api/mandates/:id/plan, by mandate id. */
  plans: Readonly<Record<string, MandatePlanResponse>>;
  /** Each open mandate's last plan fetch error, by mandate id. */
  planErrors: Readonly<Record<string, string>>;
  filter: string;
  size: PlanSize;
}

const MAX_PROBLEMS = 3;
const JOB_KEY = '\0job ';
const LOOSE = 'loose';
const ALL_PAST: StageStep[] = STEPPER_STAGES.map((stage) => ({ stage, status: 'past', tone: 'gleam' }));

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const own = <T>(rec: Readonly<Record<string, T>>, k: string): T | undefined => (Object.hasOwn(rec, k) ? rec[k] : undefined);
const isUnreadable = (m: GraphMandate): m is UnreadableMandateRow => 'problem' in m;

/** The mandates that get a plate: readable rows not closed, in the list's (creation) order. */
export const openMandates = (rows: readonly GraphMandate[] | null): Pick<MandateRow, 'id' | 'title' | 'status' | 'state'>[] =>
  (rows ?? []).filter((m): m is Pick<MandateRow, 'id' | 'title' | 'status' | 'state'> => !isUnreadable(m) && m.status !== 'closed' && typeof m.id === 'string' && m.id !== '');

const deps = (j: JobLike): string[] => (Array.isArray(j.dependsOn) ? j.dependsOn.filter((d): d is string => typeof d === 'string' && d !== '') : []);
const primaryRef = (j: JobLike): string | null => {
  const first: unknown = Array.isArray(j.issues) ? j.issues[0] : null;
  const ref = first && typeof first === 'object' ? (first as { ref?: unknown }).ref : null;
  return typeof ref === 'string' && ref !== '' ? ref : null;
};
const created = (j: JobLike): number => {
  const ms = Date.parse(str(j.createdAt));
  return Number.isNaN(ms) ? Infinity : ms;
};
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Creation time (a missing or invalid one last), then id: an order that never moves with a job's state. */
const byCreation = (a: JobLike, b: JobLike): number => {
  const x = created(a);
  const y = created(b);
  return (x === y ? 0 : x < y ? -1 : 1) || byId(str(a.id), str(b.id));
};

/** One node before layout and marks: its key, wave, live job and the plan's view of it. */
interface Seed {
  key: string;
  wave: number | null;
  ref: string | null;
  label: string;
  title: string;
  job: JobLike | null;
  /** The plan node's state, for a node with no live job; null for a job-only node. */
  plan: string | null;
}

const jobSeed = (j: JobLike): Seed => {
  const id = str(j.id);
  return { key: JOB_KEY + id, wave: null, ref: primaryRef(j), label: cardRef(j) ?? id, title: str(j.title), job: j, plan: null };
};

/** Whether a node with a live job passes the filter, else the no-job rule by its mark. */
function matches(job: JobLike | null, mark: GraphMark, filter: string): boolean {
  if (job) return filterJobs([job], filter).length > 0;
  if (filter === 'done') return mark === 'merged';
  if (filter === 'waiting') return mark === 'waiting';
  if (filter === 'active') return mark !== 'merged';
  return true;
}

/**
 * Lays out one block: marks from the live jobs first, then the plan's own rule for the no-job nodes over those
 * marks. `edges` are layout keys, `from` before `to`; the layout depends only on keys, waves and edges.
 */
function block(prefix: string, seeds: Seed[], keyEdges: { from: string; to: string }[], filter: string, size: PlanSize): Block {
  const seedOf = new Map(seeds.map((s) => [s.key, s]));
  const edges = keyEdges.filter((e) => e.from !== e.to && seedOf.has(e.from) && seedOf.has(e.to));
  const ups = new Map<string, string[]>(seeds.map((s) => [s.key, []]));
  const downs = new Map<string, number>(seeds.map((s) => [s.key, 0]));
  for (const e of edges) {
    const list = ups.get(e.to)!;
    if (!list.includes(e.from)) list.push(e.from);
    downs.set(e.from, downs.get(e.from)! + 1);
  }
  for (const list of ups.values()) list.sort(refOrder);

  const merged = new Set(seeds.filter((s) => (s.job ? s.job.state === 'done' : s.plan === 'merged')).map((s) => s.key));
  const open = (key: string): string[] => ups.get(key)!.filter((u) => !merged.has(u));
  const mark = new Map<string, GraphMark>();
  for (const s of seeds) {
    const j = s.job;
    if (merged.has(s.key)) mark.set(s.key, 'merged');
    else if (j) mark.set(s.key, j.state === 'cancelled' ? 'cancelled' : j.state === 'running' ? 'running' : isDependencyPark(j) && open(s.key).length ? 'waiting' : 'held');
    else if (s.plan === 'running') mark.set(s.key, 'running');
    else mark.set(s.key, open(s.key).length ? 'waiting' : ups.get(s.key)!.length || downs.get(s.key)! ? 'ready' : 'planned');
  }

  const layout = layoutPlan({ nodes: seeds.map((s) => ({ ref: s.key, wave: s.wave })), edges }, size);
  const id = (key: string): string => `${prefix}|${key}`;
  const nodes = layout.nodes.map((p): GNode => {
    const s = seedOf.get(p.ref)!;
    const j = s.job;
    const m = mark.get(s.key)!;
    let line: GraphLine;
    if (m === 'waiting') {
      const waits = open(s.key);
      line = { kind: 'waits', ref: seedOf.get(waits[0])!.label, more: waits.length - 1 };
    } else if (j && (m === 'running' || m === 'held')) {
      const stage = STAGE_LABEL[j.stage as Stage] ?? str(j.stage);
      line = { kind: 'stage', stage, state: m === 'held' ? stateText(j) : null };
    } else line = { kind: m as 'merged' | 'cancelled' | 'running' | 'ready' | 'planned' }; // held always has a job
    const live = j !== null && j.state !== 'cancelled';
    return {
      id: id(s.key),
      key: s.key,
      ref: s.ref,
      label: s.label,
      title: s.title || (j ? str(j.title) : '') || s.label,
      job: j ? str(j.id) : null,
      mark: m,
      tone: j ? stateTone(j) : null,
      line,
      dashed: !live,
      steps: live ? cardModel(j).steps : m === 'merged' ? ALL_PAST : null,
      match: matches(j, m, filter),
      x: p.x,
      y: p.y,
      w: p.w,
      h: p.h,
    };
  });
  const nodeOf = new Map(nodes.map((n) => [n.key, n]));
  return {
    width: layout.width,
    height: layout.height,
    nodes,
    edges: layout.edges.map((e): GEdge => {
      const a = nodeOf.get(e.from)!;
      const b = nodeOf.get(e.to)!;
      return { id: `${prefix}|${JSON.stringify([e.from, e.to])}`, from: a.id, to: b.id, d: e.d, solid: a.mark === 'merged', dim: !a.match && !b.match };
    }),
  };
}

/** The dependsOn links among `members` as layout-key edges, dependency first; `keep` picks which to draw. */
function jobEdges(members: JobLike[], keyOf: Map<string, string>, keep: (from: string, to: string) => boolean): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const j of members) {
    const to = keyOf.get(str(j.id));
    if (to === undefined) continue;
    for (const d of deps(j)) {
      const from = keyOf.get(d);
      if (from !== undefined && keep(from, to)) out.push({ from, to });
    }
  }
  return out;
}

/** The whole graph: the open mandates' plates, then the jobs in no plate. */
export function pipelineGraph(input: GraphInput): PipelineGraph {
  const jobs = (Array.isArray(input.jobs) ? input.jobs : []).filter((j) => j && typeof j === 'object' && str(j.id) !== '');
  const live = new Map<string, JobLike>();
  for (const j of jobs) if (!live.has(str(j.id))) live.set(str(j.id), j);
  const claimed = new Set<string>();
  // No list (not loaded yet, or failed with none earlier) means no plate, so every job goes under No mandate.
  const mandates = openMandates(input.mandates);
  const plateIds = new Set(mandates.map((m) => m.id));

  const plates = mandates.map((m): Plate => {
    const plan = own(input.plans, m.id);
    const error = own(input.planErrors, m.id) ?? null;
    const status: Plate['status'] = plan ? 'ready' : error !== null ? 'error' : 'loading';
    const head = { id: m.id, title: str(m.title) || m.id, state: m.state, status, error };
    if (status === 'loading') return { ...head, merged: 0, total: 0, problems: [], moreProblems: 0, block: { width: 0, height: 0, nodes: [], edges: [] } };

    const seeds: Seed[] = [];
    const seen = new Set<string>();
    for (const n of plan && Array.isArray(plan.nodes) ? plan.nodes : []) {
      const ref = n && typeof n === 'object' ? str(n.ref) : '';
      if (!ref || seen.has(ref)) continue;
      seen.add(ref);
      const jid = str(n.job);
      const job = jid && live.has(jid) && !claimed.has(jid) ? live.get(jid)! : null;
      if (job) claimed.add(jid);
      const wave = typeof n.wave === 'number' && Number.isInteger(n.wave) && n.wave >= 0 ? n.wave : null;
      seeds.push({ key: ref, wave, ref, label: issueLabel(ref) ?? ref, title: str(n.title), job, plan: str(n.state) });
    }
    const mine = jobs.filter((j) => j.mandate === m.id && !claimed.has(str(j.id))).sort(byCreation);
    for (const j of mine) {
      const ref = primaryRef(j);
      const slot = ref === null ? undefined : seeds.find((s) => s.ref === ref && s.plan !== null && s.job === null);
      if (slot) slot.job = j;
      else seeds.push(jobSeed(j));
      claimed.add(str(j.id));
    }

    const keyOf = new Map<string, string>();
    for (const s of seeds) if (s.job) keyOf.set(str(s.job.id), s.key);
    const planEdges = (plan && Array.isArray(plan.edges) ? plan.edges : []).map((e) => ({ from: str(e?.from), to: str(e?.to) }));
    const members = seeds.flatMap((s) => (s.job ? [s.job] : []));
    const extra = (k: string): boolean => k.startsWith(JOB_KEY);
    const b = block(m.id, seeds, [...planEdges, ...jobEdges(members, keyOf, (f, t) => extra(f) || extra(t))], input.filter, input.size);
    const problems = (plan && Array.isArray(plan.problems) ? plan.problems : []).map((p) => str(p?.detail));
    return {
      ...head,
      merged: b.nodes.filter((n) => n.mark === 'merged').length,
      total: b.nodes.length,
      problems: problems.slice(0, MAX_PROBLEMS),
      moreProblems: Math.max(0, problems.length - MAX_PROBLEMS),
      block: b,
    };
  });

  // No mandate: every job no plate holds, whose mandate is none, closed, deleted, unreadable or unlisted.
  const rest = jobs.filter((j) => !claimed.has(str(j.id)) && !(typeof j.mandate === 'string' && plateIds.has(j.mandate)) && live.get(str(j.id)) === j);
  const restIds = new Set(rest.map((j) => str(j.id)));
  const links = new Map<string, Set<string>>(rest.map((j) => [str(j.id), new Set<string>()]));
  for (const j of rest)
    for (const d of deps(j))
      if (restIds.has(d) && d !== str(j.id)) {
        links.get(str(j.id))!.add(d);
        links.get(d)!.add(str(j.id));
      }
  const groups: JobLike[][] = [];
  const done = new Set<string>();
  for (const j of [...rest].sort(byCreation)) {
    if (done.has(str(j.id))) continue;
    const group: JobLike[] = [];
    const stack = [str(j.id)];
    done.add(str(j.id));
    while (stack.length) {
      const id = stack.pop()!;
      group.push(live.get(id)!);
      for (const n of links.get(id)!) if (!done.has(n)) (done.add(n), stack.push(n));
    }
    groups.push(group.sort(byCreation));
  }
  const looseBlock = (group: JobLike[]): Block => {
    const seeds = group.map(jobSeed);
    const keyOf = new Map(seeds.map((s) => [str(s.job!.id), s.key]));
    return block(LOOSE, seeds, jobEdges(group, keyOf, () => true), input.filter, input.size);
  };
  return {
    plates,
    loose: {
      chains: groups.filter((g) => g.length > 1).map(looseBlock),
      lone: groups.filter((g) => g.length === 1).map(looseBlock),
      count: rest.length,
    },
  };
}

/** How long a heat run lasts: style.css's --heat-cool. */
export const HEAT_COOL_MS = 1000;

const graphBlocks = (graph: PipelineGraph): Block[] => [...graph.plates.map((p) => p.block), ...graph.loose.chains, ...graph.loose.lone];

/** Every node's mark by node id, for the next render's `newlyMerged`. */
export function graphMarks(graph: PipelineGraph): Map<string, GraphMark> {
  const out = new Map<string, GraphMark>();
  for (const b of graphBlocks(graph)) for (const n of b.nodes) out.set(n.id, n.mark);
  return out;
}

/** The ids of the edges leaving any of `nodes`: the ones a merge heats. */
export function heatedEdges(graph: PipelineGraph, nodes: readonly string[]): string[] {
  const from = new Set(nodes);
  return graphBlocks(graph).flatMap((b) => b.edges.filter((e) => from.has(e.from)).map((e) => e.id));
}

/** The node ids that were present and not merged in `prev` and are merged in `next`; none on the first render. */
export function newlyMerged(prev: ReadonlyMap<string, GraphMark> | null, next: ReadonlyMap<string, GraphMark>): string[] {
  if (prev === null) return [];
  const out: string[] = [];
  for (const [id, mark] of next) if (mark === 'merged' && prev.has(id) && prev.get(id) !== 'merged') out.push(id);
  return out;
}
