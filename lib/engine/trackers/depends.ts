// Issue dependencies: the `Depends on:` line an issue body names its dependencies with, one strict
// parser, and the dependency graph over a mandate's issues and the jobs on them: edges, cycle breaking
// and each issue's state. docs/architecture/foreman/mandates.md › Mandate plan.
import { checkIssueRef, primaryIssue, sameIssue } from '#core/job/issue-ref.ts';
import { oneLineTitle } from '#core/text.ts';
import type { IssueRefOpts } from '#core/job/issue-ref.ts';
import type { JobIssue, JobState, MandatePlanEdge, MandatePlanNode, MandatePlanProblem, MandatePlanResponse, MandatePlanState } from '#core/types.ts';

/** An issue's dependencies as its body names them: the stored refs, or why its line is refused. */
export type DependsOn = { refs: string[] } | { problem: string };

const PREFIX = 'Depends on:';
const LINE_MAX = 2000;
/** At most this many refs on one line. */
export const DEPENDS_MAX = 20;

/** Every problem parseDependsOn writes, so a stored one is re-checked against the same sentences. */
const PROBLEM = /^(?:its body has \d{1,9} Depends on: lines|its Depends on: line (?:is over 2000 characters|lists no issue|lists more than 20 issues)|entry \d{1,2} of its Depends on: line is (?:empty|not an issue ref))$/;

/** Whether `s` is one of parseDependsOn's own problem sentences. */
export const isDependsProblem = (s: unknown): s is string => typeof s === 'string' && PROBLEM.test(s);

/**
 * The refs a body's `Depends on:` line names, de-duplicated and in order; null when no line starts, at
 * column 0 and case-sensitively, with `Depends on:`. Refuses two such lines, a line over 2000 characters,
 * an empty list or entry, more than 20 entries, and any entry checkIssueRef refuses. Code fences are not
 * special. Problems are fixed sentences with numbers only: never the body's text.
 */
export function parseDependsOn(body: unknown, opts: IssueRefOpts): DependsOn | null {
  if (typeof body !== 'string') return null;
  const lines = body.split('\n').filter((l) => l.startsWith(PREFIX));
  if (!lines.length) return null;
  if (lines.length > 1) return { problem: `its body has ${lines.length} Depends on: lines` };
  const line = lines[0].endsWith('\r') ? lines[0].slice(0, -1) : lines[0];
  if (line.length > LINE_MAX) return { problem: `its Depends on: line is over ${LINE_MAX} characters` };
  const list = line.slice(PREFIX.length).trim();
  if (!list) return { problem: 'its Depends on: line lists no issue' };
  const entries = list.split(',');
  if (entries.length > DEPENDS_MAX) return { problem: `its Depends on: line lists more than ${DEPENDS_MAX} issues` };
  const refs: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i].trim();
    if (!entry) return { problem: `entry ${i + 1} of its Depends on: line is empty` };
    const r = checkIssueRef(entry, opts);
    if ('error' in r) return { problem: `entry ${i + 1} of its Depends on: line is not an issue ref` };
    if (!refs.some((x) => sameIssue({ tracker: opts.tracker, ref: x }, { tracker: opts.tracker, ref: r.ref }, opts.slug))) refs.push(r.ref);
  }
  return { refs };
}

const WAVE = /^wave-([1-9][0-9]{0,2})$/;

/** `n` of a `wave-<n>` label (1 to 999), the smallest when there are several; null for none. */
export function waveOf(labels: unknown): number | null {
  if (!Array.isArray(labels)) return null;
  let best: number | null = null;
  for (const l of labels) {
    const m = typeof l === 'string' ? WAVE.exec(l) : null;
    if (m && (best === null || Number(m[1]) < best)) best = Number(m[1]);
  }
  return best;
}

/** One scope issue of a plan (a ScopeItem fits it). */
export interface PlanIssue {
  ref: string;
  title: string;
  wave: number | null;
  depends: DependsOn | null;
}

/** One mandate job of a plan, from its CLI record. */
export interface PlanJob {
  id: string;
  title: string;
  issues: JobIssue[];
  state: JobState;
  dependsOn: string[];
  parent: string | null;
  createdAt: string | null;
}

interface Node {
  key: Pick<JobIssue, 'tracker' | 'ref'>;
  ref: string;
  title: string;
  wave: number | null;
  depends: DependsOn | null;
  job: PlanJob | null;
}

interface Edge {
  from: number;
  to: number;
  source: 'body' | 'job';
}

const KINDS: MandatePlanProblem['kind'][] = ['scope', 'malformed', 'outside', 'unknown', 'cycle'];
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** The issue number a ref ends with, for ordering; null for a ref with none. */
const numberOf = (ref: string): number | null => {
  const n = /(\d+)$/.exec(ref);
  return n ? Number(n[1]) : null;
};

const byNumber = (a: string, b: string): number => {
  const x = numberOf(a);
  const y = numberOf(b);
  if (x !== null && y !== null && x !== y) return x - y;
  if (x === null && y !== null) return 1;
  if (y === null && x !== null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
};

const createdMs = (j: PlanJob): number => {
  const ms = Date.parse(j.createdAt ?? '');
  return Number.isFinite(ms) ? ms : -Infinity;
};

/** Of several jobs on one issue: not cancelled, then top-level, then the latest created, then the id. */
function pickJob(jobs: PlanJob[], ids: Set<string>): PlanJob | null {
  const rank = (j: PlanJob): [number, number] => [j.state === 'cancelled' ? 1 : 0, j.parent !== null && ids.has(j.parent) ? 1 : 0];
  return (
    [...jobs].sort((a, b) => {
      const [ca, pa] = rank(a);
      const [cb, pb] = rank(b);
      return ca - cb || pa - pb || createdMs(b) - createdMs(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    })[0] ?? null
  );
}

/** The strongly connected components over `n` nodes (Tarjan's, iterative). */
function components(n: number, out: number[][]): number[][] {
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const on = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const comps: number[][] = [];
  let next = 0;
  for (let s = 0; s < n; s++) {
    if (index[s] !== -1) continue;
    index[s] = low[s] = next++;
    stack.push(s);
    on[s] = true;
    const work: [number, number][] = [[s, 0]];
    while (work.length) {
      const top = work[work.length - 1];
      const v = top[0];
      if (top[1] < out[v].length) {
        const w = out[v][top[1]++];
        if (index[w] === -1) {
          index[w] = low[w] = next++;
          stack.push(w);
          on[w] = true;
          work.push([w, 0]);
        } else if (on[w]) low[v] = Math.min(low[v], index[w]);
        continue;
      }
      work.pop();
      if (work.length) {
        const u = work[work.length - 1][0];
        low[u] = Math.min(low[u], low[v]);
      }
      if (low[v] !== index[v]) continue;
      const c: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        on[w] = false;
        c.push(w);
      } while (w !== v);
      comps.push(c);
    }
  }
  return comps;
}

/**
 * A mandate's plan graph. Nodes: the scope issues in order (the first of a ref wins), then each job's
 * primary issue no scope node matches, by number then ref. A job attaches to every node one of its issues
 * matches (pickJob chooses among several). Edges come from each scope issue's `Depends on:` line and from
 * each job's dependsOn; every edge inside a cycle is dropped and named in one `cycle` problem. Refs are
 * compared only through sameIssue.
 */
export function planGraph(o: { issues: PlanIssue[]; jobs: PlanJob[]; kind: string; slug: string | null }): Pick<MandatePlanResponse, 'nodes' | 'edges' | 'problems'> {
  const { kind, slug } = o;
  const nodes: Node[] = [];
  const find = (key: Pick<JobIssue, 'tracker' | 'ref'>): number => nodes.findIndex((n) => sameIssue(n.key, key, slug));
  for (const it of o.issues) {
    const key = { tracker: kind, ref: it.ref };
    if (find(key) === -1) nodes.push({ key, ref: it.ref, title: it.title, wave: it.wave, depends: it.depends, job: null });
  }
  const extra: Node[] = [];
  for (const j of o.jobs) {
    const p = primaryIssue(j);
    if (!p?.ref || find(p) !== -1 || extra.some((n) => sameIssue(n.key, p, slug))) continue;
    extra.push({ key: { tracker: p.tracker, ref: p.ref }, ref: p.ref, title: '', wave: null, depends: null, job: null });
  }
  nodes.push(...extra.sort((a, b) => byNumber(a.ref, b.ref)));

  // Attach jobs.
  const ids = new Set(o.jobs.map((j) => j.id));
  for (const n of nodes) {
    n.job = pickJob(
      o.jobs.filter((j) => j.issues.some((i) => i?.ref && sameIssue(i, n.key, slug))),
      ids,
    );
    if (!n.title && n.job) n.title = oneLineTitle(n.job.title);
  }

  const problems: { kind: MandatePlanProblem['kind']; at: number; ref: string | null; detail: string; edges: Edge[] }[] = [];
  const edges: Edge[] = [];
  const has = (from: number, to: number) => edges.some((e) => e.from === from && e.to === to);

  // Body edges.
  nodes.forEach((n, to) => {
    const d = n.depends;
    if (d === null) return;
    if ('problem' in d) {
      problems.push({ kind: 'malformed', at: to, ref: n.ref, detail: d.problem, edges: [] });
      return;
    }
    for (const ref of d.refs) {
      const from = find({ tracker: kind, ref });
      if (from === -1) problems.push({ kind: 'outside', at: to, ref: n.ref, detail: `depends on ${ref}, which is not in this plan`, edges: [] });
      else if (!has(from, to)) edges.push({ from, to, source: 'body' });
    }
  });

  // Job edges.
  const nodeOf = (j: PlanJob): number => {
    const p = primaryIssue(j);
    return p?.ref ? find(p) : -1;
  };
  for (const j of o.jobs) {
    const to = nodeOf(j);
    if (to === -1) continue;
    for (const dep of Array.isArray(j.dependsOn) ? j.dependsOn : []) {
      const named = typeof dep === 'string' && JOB_ID.test(dep) ? dep : null;
      const other = named === null ? undefined : o.jobs.find((x) => x.id === named);
      const from = other ? nodeOf(other) : -1;
      if (from === -1) {
        const why = other ? 'which carries no issue in this plan' : 'which is not a mandate job';
        problems.push({ kind: 'unknown', at: to, ref: nodes[to].ref, detail: `job ${j.id} depends on ${named ?? 'a job'}, ${why}`, edges: [] });
      } else if (from !== to && !has(from, to)) edges.push({ from, to, source: 'job' });
    }
  }

  // Cycles: every edge inside a strongly connected component (a self-loop too) is dropped.
  const out: number[][] = nodes.map(() => []);
  for (const e of edges) out[e.from].push(e.to);
  const comp = new Array<number>(nodes.length).fill(-1);
  const cyclic: number[][] = [];
  for (const c of components(nodes.length, out)) {
    if (c.length === 1 && !edges.some((e) => e.from === c[0] && e.to === c[0])) continue;
    for (const v of c) comp[v] = cyclic.length;
    cyclic.push(c);
  }
  const dropped: Edge[][] = cyclic.map(() => []);
  const kept: Edge[] = [];
  for (const e of edges) {
    if (comp[e.from] !== -1 && comp[e.from] === comp[e.to]) dropped[comp[e.from]].push(e);
    else kept.push(e);
  }
  const order = (a: Edge, b: Edge) => a.from - b.from || a.to - b.to;
  cyclic.forEach((c, i) => {
    const members = [...c].sort((a, b) => a - b);
    const refs = members.map((v) => nodes[v].ref).join(', ');
    const detail = members.length === 1 ? `${refs} depends on itself` : `${members.length} issues depend on each other in a cycle: ${refs}`;
    problems.push({ kind: 'cycle', at: members[0], ref: null, detail, edges: dropped[i].sort(order) });
  });

  // States: a job's own first, else from the upstream nodes.
  const ownState = (n: Node): MandatePlanState | null => (!n.job || n.job.state === 'cancelled' ? null : n.job.state === 'done' ? 'merged' : 'running');
  const own = nodes.map(ownState);
  const state = (v: number): MandatePlanState => {
    const s = own[v];
    if (s !== null) return s;
    const ups = kept.filter((e) => e.to === v);
    if (ups.length) return ups.every((e) => own[e.from] === 'merged') ? 'ready' : 'waiting';
    return kept.some((e) => e.from === v) ? 'ready' : 'planned';
  };

  const edgeOut = (e: Edge): MandatePlanEdge => ({ from: nodes[e.from].ref, to: nodes[e.to].ref, source: e.source });
  const planNodes: MandatePlanNode[] = nodes.map((n, v) => ({ ref: n.ref, title: n.title, wave: n.wave, job: n.job?.id ?? null, state: state(v) }));
  problems.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.at - b.at);
  return {
    nodes: planNodes,
    edges: kept.sort(order).map(edgeOut),
    problems: problems.map((p) => ({ kind: p.kind, ref: p.ref, detail: p.detail, edges: p.edges.map(edgeOut) })),
  };
}
