// The clean pass: when every lens passed and nothing can escalate, Forge records the APPROVE and renders decision.md and
// pr.md itself instead of running the approver (approver.skipWhenClean, rule DC13, `forge job decision --clean`). Pure:
// no fs, no git, so step and the CLI check the same facts.
import { autoMerge } from '#core/config/load.ts';
import { isLens } from '#core/job/lens.ts';
import { visibleText } from '#core/text.ts';
import type { StepInput } from '../types.ts';
import { HEADING, buildAcTable, unfenced } from '../acs.ts';
import { after, afterIdx, agent, isPrRework, lastIdx, stageOf, waitedSince } from '../step/facts.ts';
import type { Facts } from '../step/facts.ts';
import { lastVerdict, roundLenses } from '../step/panel.ts';

/** A lens that passed, and the round its latest PASS came from. */
export interface CleanLens {
  lens: string;
  round: number;
}

/** cleanPass's answer: the passing panel, or the first check that failed in fixed words (lens names only). */
export type CleanPass = { ok: true; lenses: CleanLens[] } | { ok: false; why: string };

const no = (why: string): CleanPass => ({ ok: false, why });

/**
 * Every lens of the full panel passed: the round's verdicts (read from the review files and as recorded) are complete,
 * non-empty and PASS, and each lens a narrowed round didn't re-run has PASS as its latest earlier verdict.
 */
function passedPanel(x: StepInput): CleanLens[] | string {
  const v = x.verdicts.round;
  const names = v ? Object.keys(v.reviewers) : [];
  if (!v || !v.complete || !names.length) return 'the round has no complete verdicts';
  const round = x.job.round;
  const recorded = x.job.verdicts[String(round)] ?? {};
  const didNot = (lens: string) => `lens ${isLens(lens) ? lens : 'unknown'} did not pass`;
  const out: CleanLens[] = [];
  for (const lens of names) {
    if (v.reviewers[lens]?.verdict !== 'PASS' || recorded[lens] !== 'PASS') return didNot(lens);
    out.push({ lens, round });
  }
  for (const lens of roundLenses(x.job, x.config)) {
    if (names.includes(lens)) continue;
    const last = lastVerdict(x.job.verdicts, lens, round);
    if (last?.verdict !== 'PASS') return didNot(lens);
    out.push({ lens, round: last.round });
  }
  return out;
}

/**
 * The clean pass, checks 1–13 of docs/CONFIG.md "Clean pass" in order. Every check fails closed: a gate event's
 * reasons that aren't an empty list, an unknown instruction diff (null), a missing review or decide entry.
 * No decision since the review (check 14) is DC13's own, since the CLI answers that case as idempotent.
 */
export function cleanPass(x: StepInput, f: Facts): CleanPass {
  const j = x.job;
  if (x.config.approver?.skipWhenClean !== true) return no('approver.skipWhenClean is off');
  if (j.stage !== 'decide' || j.state !== 'running') return no('the job is not running in decide');
  if (j.kind === 'eval') return no('an eval job');
  if (autoMerge(x.config)) return no('auto-merge is on');
  if (isPrRework(x)) return no('the PR is open');
  // Only `true` binds HEAD to a reviewed head: null (no `verdicts` event for the round) binds nothing, so the approver reads it.
  if (x.reviewCurrent === false) return no('a commit after review');
  if (x.reviewCurrent !== true) return no('the reviewed head is not bound');
  const lenses = passedPanel(x);
  if (typeof lenses === 'string') return no(lenses);
  // The CLI's record of how the whole panel ended: a lens dropped from job.reviewers since can't hide behind passedPanel.
  if (x.panelOutcome !== 'PASS') return no('the panel did not end PASS');
  // Raw `gate` events, not a reader that skips what it can't parse: anything but [] keeps the approver.
  const reviewed = f.reviewedAt;
  const entry = f.stageEntry?.i ?? null;
  const gates = x.events.flatMap((e, i) => (e.type === 'gate' && afterIdx(i, reviewed) ? [{ e, i }] : []));
  if (entry === null || !gates.some((g) => g.i > entry)) return no('no gate check since the review');
  if (gates.some((g) => !Array.isArray(g.e.reasons) || g.e.reasons.length !== 0)) return no('the gate check found escalation reasons');
  const flag = j.protectedPaths;
  if (flag != null && !(Array.isArray(flag.hits) && flag.hits.length === 0 && flag.more === 0)) return no('protected paths are touched');
  if (x.files.runbook) return no('runbook.md exists');
  const a = x.acs;
  if (!(a.total > 0 && a.covered === a.total && !a.unmapped.length && !a.failing.length)) return no('acceptance criteria are not all proven');
  if (!Array.isArray(x.instructionsChanged) || x.instructionsChanged.length !== 0) return no('instruction files changed');
  if (x.recall?.required === true) return no('a recall eval is required');
  if (reviewed === null) return no('no review recorded');
  if (waitedSince(x, reviewed)) return no('the job waited since the review');
  if (after(agent(x, 'approver')?.startedAt, x.events[reviewed].ts)) return no('the approver ran since the review');
  return { ok: true, lenses };
}

/**
 * A clean decision stands for this review: the last `decision` event since the review is a clean one, logged while
 * the job was in decide (a `forge job set` session can't plant one), and the key is still on.
 */
export function cleanDecidedSince(x: StepInput, f: Facts): boolean {
  if (x.config.approver?.skipWhenClean !== true || f.reviewedAt === null) return false;
  const i = lastIdx(x, (e) => e.type === 'decision');
  if (!afterIdx(i, f.reviewedAt) || x.events[i].clean !== true) return false;
  const t = x.events.findLastIndex((e, k) => k < i && e.type === 'transition');
  return t >= 0 && stageOf(x.events[t].to).stage === 'decide';
}

const byLens = (a: CleanLens, b: CleanLens) => (a.lens < b.lens ? -1 : a.lens > b.lens ? 1 : 0);

/** decision.md for a clean pass: the APPROVE parseDecision reads, never auto-merge eligible. */
export function renderCleanDecision(lenses: readonly CleanLens[], round: number): string {
  const panel = [...lenses].sort(byLens).map((l) => `${l.lens} PASS${l.round !== round ? ` (round ${l.round})` : ''}`);
  return ['APPROVE', '', 'Auto-merge eligible: no', `Panel: ${panel.join(', ')}`, 'Escalation reasons: none', 'Approver: skipped on a clean pass (approver.skipWhenClean)', ''].join('\n');
}

const SUMMARY_MAX = 1200;
const BULLET_MAX = 400;
const PROOF_MAX = 300;
const RESULT_MAX = 40;
const BULLETS_SHOWN = 30;
// NEL is not in \s.
const SPACES = /[\s\x85]+/gu;

/** `<` and `>` as entities, so copied text never forms an HTML tag (GitHub would let `<details>` fold the rest of the body). */
const noHtml = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Builder or spec text as one line of a PR body: what visibleText removes (HTML comments, Forge's markers among
 * them, and invisible characters) goes, line breaks and runs of space become one space, and it is cut to `max`
 * characters with `…`. `<` and `>` become entities after the cut, so `max` counts the source characters and a cut
 * never splits an entity. Inside a code span GitHub shows the entities as typed: the price of failing closed.
 */
export function prText(s: string, max: number): string {
  const one = visibleText(String(s ?? '')).text.replace(SPACES, ' ').trim();
  if (one.length <= max) return noHtml(one);
  let cut = one.slice(0, Math.max(0, max - 1));
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${noHtml(cut)}…`;
}

/** A table cell: every `|` escaped once, whatever backslashes stood before it. A loop, not a regex, over outside text. */
function cell(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch === '|') out = `${out.replace(/\\+$/, '')}\\|`;
    else out += ch;
  }
  return out;
}

/**
 * The `Changes:` bullets of every level-2 `## Round <n>` section of build.md, in order, outside code fences: the
 * inline `Changes: x` text, then each `- ` or `* ` line, with lines indented 2+ spaces joined to the bullet before.
 * Blank lines are skipped, and any other line (a fence, a heading, `Phase → commit:`) ends the block.
 */
export function changeBullets(buildText: string): string[] {
  const out: string[] = [];
  let inRound = false;
  let inChanges = false;
  let bullet = false;
  for (const line of unfenced(String(buildText ?? ''))) {
    if (line === null) {
      inChanges = false;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      if (h[1].length <= 2) inRound = h[1].length === 2 && /^round\s+\d+\b/i.test(h[2]);
      inChanges = false;
      continue;
    }
    if (!inRound) continue;
    if (line.startsWith('Changes:')) {
      inChanges = true;
      const inline = line.slice('Changes:'.length).trim();
      bullet = Boolean(inline);
      if (inline) out.push(inline);
      continue;
    }
    if (!inChanges || !line.trim()) continue;
    const marker = /^ ?[-*]\s/.exec(line);
    if (marker && line.slice(marker[0].length).trim()) {
      out.push(line.slice(marker[0].length).trim());
      bullet = true;
    } else if (bullet && /^ {2}/.test(line)) out[out.length - 1] += ` ${line.trim()}`;
    else inChanges = false;
  }
  return out;
}

/** The first `# ` heading's text and the first paragraph of the first `## Goal` section, outside code fences. */
function specSummary(specText: string): { title: string | null; goal: string } {
  let title: string | null = null;
  let inGoal = false;
  const para: string[] = [];
  for (const line of unfenced(String(specText ?? ''))) {
    if (line === null) {
      if (para.length) break;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      if (h[1].length === 1 && title === null) title = h[2];
      if (inGoal) break;
      inGoal = h[1].length === 2 && /^goal\b/i.test(h[2]);
      continue;
    }
    if (!inGoal) continue;
    if (!line.trim()) {
      if (para.length) break;
      continue;
    }
    para.push(line);
  }
  return { title, goal: para.join(' ') };
}

/** pr.md for a clean pass: Summary, Changes, Acceptance criteria and Notes, every copied piece through prText. */
export function renderCleanPr(o: { specText: string; buildText: string; jobTitle: string; lenses: readonly CleanLens[] }): string {
  const s = specSummary(o.specText);
  let title = (s.title !== null ? prText(s.title, SUMMARY_MAX) : '') || prText(o.jobTitle, SUMMARY_MAX);
  while (title.endsWith('.')) title = title.slice(0, -1);
  const goal = prText(s.goal, Math.max(0, SUMMARY_MAX - title.length));
  const sections = [`## Summary\n**${title}.**${goal ? ` ${goal}` : ''}`];
  const bullets = changeBullets(o.buildText);
  if (bullets.length) {
    const shown = bullets.slice(0, BULLETS_SHOWN).map((b) => `- ${prText(b, BULLET_MAX)}`);
    if (bullets.length > BULLETS_SHOWN) shown.push(`- … and ${bullets.length - BULLETS_SHOWN} more`);
    sections.push(`## Changes\n${shown.join('\n')}`);
  }
  const t = buildAcTable(o.buildText);
  if (t.table && t.order.length) {
    const rows = t.order.map((id) => `| ${id} | ${cell(prText(t.rows[id].proof, PROOF_MAX))} | ${cell(prText(t.rows[id].result, RESULT_MAX))} |`);
    sections.push(['## Acceptance criteria', '| AC | Proof | Result |', '|---|---|---|', ...rows].join('\n'));
  }
  const panel = [...o.lenses].sort(byLens).map((l) => `${l.lens} PASS`).join(', ');
  sections.push(`## Notes\n- Forge approved this without the approver: every lens passed (${panel}) and no escalation reason applied (\`approver.skipWhenClean\`).`);
  return `${sections.join('\n\n')}\n`;
}
