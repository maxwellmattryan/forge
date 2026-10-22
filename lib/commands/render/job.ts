// `forge job list|show|step|claim|note` in human mode.
import { isMap } from '../../shape.ts';
import { blocks, fields, has, hang, line, list, mark, marked, paint, ports, section, short, stateSeg, table, txt } from './kit.ts';
import type { Paint, Renderer, Val } from './kit.ts';
import type { StepAction, StepSpawn } from '../../types.ts';

export const jobList: Renderer = (d, o) => {
  if (!Array.isArray(d) || !d.every((r) => has(r, 'id', 'title', 'stage', 'state', 'waitingOn', 'round', 'pr', 'owner', 'effort'))) return null;
  if (!d.length) return o.all ? 'no jobs' : 'no active jobs';
  const p = paint(o.color);
  const rows = d.map((j): Val[] => [txt(j.id), txt(j.stage), [stateSeg(j.state, j.waitingOn, p)], j.round ? `r${txt(j.round)}` : '-', j.pr ? `#${txt(j.pr)}` : '-', short(j.owner, 8), txt(j.effort), txt(j.title)]);
  return table(['id', 'stage', 'state', 'round', 'pr', 'owner', 'effort', 'title'], rows, p);
};

const verdicts = (v: unknown): string => (isMap(v) && Object.keys(v).length ? Object.entries(v).map(([k, x]) => `${txt(k)} ${txt(x)}`).join(', ') : '-');

function verified(v: unknown, p: Paint): Val {
  if (!has(v, 'ok', 'round', 'attempt')) return null;
  return [mark(v.ok === true, p), { text: ` round ${txt(v.round)} attempt ${txt(v.attempt)} ${short(v.sha, 7)}` }];
}

function prSection(pr: unknown, p: Paint): string | null {
  if (!has(pr, 'number')) return section('PR', ['none'], p);
  return section('PR', [line([{ text: `#${txt(pr.number)} ${txt(pr.state)} ${txt(pr.url)}` }]), ...fields([['checks', pr.checks], ['behind', pr.behindBy], ['conflicts', pr.conflicts], ['threads', pr.unresolvedThreads]], p)], p);
}

export const jobShow: Renderer = (d, o) => {
  if (!has(d, 'id', 'title', 'progress')) return null;
  const p = paint(o.color);
  const j = d as Record<string, any>;
  const total = Number(j.progress?.total) || 0;
  return blocks(
    line([{ text: txt(j.id) }, { text: '  ' }, { text: txt(j.title) }]),
    section('Stage', fields([['stage', j.stage], ['state', [stateSeg(j.state, j.waitingOn, p)]], ['reason', j.reason], ['kind', j.kind], ['effort', j.effort], ['owner', j.owner]], p), p),
    section('Rounds', fields([['round', `${txt(j.round)} of ${txt(j.maxRounds)}`], ['reviewers', list(j.reviewers)], ['verdicts', verdicts(j.lastVerdicts)], ['verified', verified(j.verified, p)], ['decision', j.decision]], p), p),
    prSection(j.pr, p),
    section('Tasks', [total ? `${txt(j.progress.done)}/${total} done` : 'none'], p),
    section('Paths', fields([['worktree', j.worktree], ['branch', j.branch], ['base', j.base], ['ports', ports(j.ports)]], p), p),
    section('Usage', fields([['tokens', typeof j.tokens === 'number' ? j.tokens.toLocaleString('en-US') : null], ['cost', typeof j.estCostUsd === 'number' ? `$${j.estCostUsd}` : null]], p), p),
  );
};

const STEP_ACTIONS = ['spawn', 'run', 'wait', 'procedure', 'done'];

function stepFields(s: StepAction): [string, Val][] {
  switch (s.action) {
    case 'spawn': {
      const sp = s as StepSpawn;
      const more = Array.isArray(sp.spawns) && sp.spawns.length ? `+${sp.spawns.length} more lenses` : null;
      return [['agent', sp.agent], ['role', sp.lens ? `${txt(sp.role)}/${txt(sp.lens)}` : sp.role], ['model', sp.model], ['effort', sp.effort], ['round', sp.round], ['output', sp.output], ...(more ? ([['parallel', more]] as [string, Val][]) : [])];
    }
    case 'run':
      return [['command', `forge ${s.shell}`], ['why', s.why], ['tell', s.tell]];
    case 'wait':
      return [['waiting on', s.waitingOn], ['running', list(s.running)], ['tell', s.tell]];
    case 'procedure':
      return [['reference', s.reference], ['why', s.why]];
    case 'done':
      return [['state', s.state], ['tell', s.tell]];
  }
}

export const jobStep: Renderer = (d, o) => {
  if (!has(d, 'action', 'rule', 'id') || !STEP_ACTIONS.includes(String(d.action))) return null;
  const p = paint(o.color);
  const s = d as StepAction;
  return [`${txt(s.action)} · rule ${txt(s.rule)}`, ...fields(stepFields(s), p)].join('\n');
};

export const jobClaim: Renderer = (d, o) => {
  if (!has(d, 'id', 'lease') || !has(d.lease, 'driver', 'epoch', 'expiresAt')) return null;
  const p = paint(o.color);
  const out = [`claimed ${txt(d.id)} for session ${short(d.lease.driver, 8)} at epoch ${txt(d.lease.epoch)}, lease until ${txt(d.lease.expiresAt)}`];
  if (Array.isArray(d.dependenciesOverridden) && d.dependenciesOverridden.length) out.push(`overrode dependencies: ${list(d.dependenciesOverridden)}`);
  if (has(d.repoBudget, 'reason')) out.push(marked('warn', [{ text: `repo budget: ${hang(String(d.repoBudget.reason ?? '-'), 2)}` }], p));
  return out.join('\n');
};

export const jobNote: Renderer = (d) => (has(d, 'ok') && d.ok === true && Object.keys(d).length === 1 ? 'note added' : null);
