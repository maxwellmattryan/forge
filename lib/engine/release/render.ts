// `release.md`, the human-readable plan with its checks and rollback. Text from config and manifests
// stays in fences or is cut to safe text.

import { shellWord } from '../project/member-repos.ts';
import type { Config } from '#core/types.ts';
import { fenced, safeText } from '#core/text.ts';
import { type CheckKind, type ReleasePlan, type ReleaseRepo, type ReleaseSelection, type ReleaseStep, repoBase, repoRemote } from './plan.ts';

const CHECK_TEXT: Record<CheckKind, (r: ReleaseRepo, base: string, remote: string) => string> = {
  ready: (_r, base, remote) => `the clone is on ${base} with nothing uncommitted, and HEAD equals ${remote}/${base} after a fetch.`,
  clean: () => '`git status` shows nothing uncommitted.',
  tagged: () => 'HEAD carries at least one tag.',
  'tag-pushed': (_r, base, remote) => `HEAD carries a tag, and ${remote} has ${base} at HEAD and every tag at HEAD.`,
  'remote-tagged': (_r, base, remote) => `after a fetch, ${remote}/${base} carries a tag.`,
  'at-remote': (_r, base, remote) => `HEAD equals ${remote}/${base}.`,
  registry: (r) =>
    r.package?.ecosystem === 'cargo'
      ? `\`cargo search ${r.package.name}\` lists the version in Cargo.toml.`
      : `\`npm view ${r.package?.name ?? '<name>'}@<version> version\` prints the version in package.json.`,
  'pr-merged': (r) => `the release script's \`--check merged ${r.bump?.to ?? '<version>'}\` finds the release PR from release/v${r.bump?.to ?? '<version>'} into main merged.`,
};

/** A script repo's version bump and notes file, for its section. Script output goes through safeText. */
function bumpLines(r: ReleaseRepo): string[] {
  const b = r.bump;
  if (!b) return [];
  const reasons = b.reasons.map((x) => safeText(x, 500)).join('; ');
  const chosen = b.bump === b.inferred ? `${b.bump} (inferred)` : `${b.bump} (inferred ${b.inferred})`;
  return [
    `Version: ${safeText(b.from, 40)} → ${safeText(b.to, 40)} · bump ${chosen}${reasons ? `: ${reasons}` : ''}`,
    `Notes: \`${safeText(b.notes, 500)}\`. Edit the drafted CHANGELOG section there before you run; a re-plan of the same version keeps your edits, and \`forge release plan --bump patch|minor|major\` drafts another version.`,
  ];
}

/** A step's command as one line: the argv as shell words, the tag command as written, or the manual instruction. */
export function stepCommand(s: ReleaseStep): string {
  if (s.manual !== null) return s.manual;
  if (s.shell !== null) return s.shell;
  return (s.argv ?? []).map((w) => shellWord(w, /^[A-Za-z0-9._/:@=+-]+$/)).join(' ');
}

/** A mandate plan's pinned heads: `at (root) <sha12>, api <sha12>`. */
const HEADS_TEXT = (heads: Record<string, string> | undefined): string =>
  heads && Object.keys(heads).length ? ` at ${Object.entries(heads).map(([label, sha]) => `${label} ${sha.slice(0, 12)}`).join(', ')}` : '';

const SELECTION_TEXT = (s: ReleaseSelection): string =>
  s.kind === 'job' ? `job ${s.job}` : s.kind === 'since' ? `since ${s.tag}${s.mandate ? ` for mandate ${s.mandate}${HEADS_TEXT(s.heads)}` : ''}` : 'every repo';

/** release.md: the human plan with its rollback. Text from config and manifests stays in fences or is cut to safe text. */
export function renderReleaseMd(plan: ReleasePlan, config: Config): string {
  const remote = repoRemote(config);
  const out: string[] = ['# Release plan', ''];
  out.push(`Selection: ${SELECTION_TEXT(plan.selection)} · planned ${plan.createdAt} · plan ${plan.hash.slice(0, 12)}`);
  out.push(`Order: ${plan.order.length ? plan.order.join(', ') : 'nothing to release'} (dependencies first)${plan.relaxed ? ' · runtime edges ignored: they formed a cycle' : ''}`);
  out.push('');
  out.push('Preview it with `forge release run --dry-run`, and run it with `forge release run`. It stops at the first failed check and, run again, resumes there. Steps marked **publish** ask before they run unless the repo sets `release.publish: allow`.');
  plan.repos.forEach((r, i) => {
    const base = repoBase(config, r.repo);
    out.push('', `## ${i + 1}. ${r.label} (${r.mechanism} → ${r.registry ?? 'no registry'})`);
    out.push(`Directory: \`${safeText(r.dir, 500)}\` · version ${r.version ?? 'unknown'} · cadence ${r.cadence ?? 'undeclared'}`);
    out.push(...bumpLines(r));
    if (r.cadence === 'on-merge' || r.cadence === 'scheduled') out.push(`> Cadence ${r.cadence} usually releases from CI; steps CI already did are skipped by their checks.`);
    out.push('');
    r.steps.forEach((s, j) => {
      out.push(`${j + 1}. \`${s.id}\`${s.publish ? ' · **publish**' : ''} — ${s.title}`);
      if (s.argv || s.shell !== null || s.manual !== null) out.push(...fenced(stepCommand(s), 'sh').split('\n').map((l) => `   ${l}`));
      out.push(`   Check: ${s.check ? CHECK_TEXT[s.check](r, base, remote) : 'the exit code.'}`);
      if (s.note) out.push(`   ${s.note}`);
    });
  });
  if (plan.skipped.length) {
    out.push('', '## Not released');
    for (const s of plan.skipped) out.push(`- \`${s.label}\`: ${safeText(s.reason, 400)}`);
  }
  out.push('', '## Rollback', 'Forge never runs these. Undo in this order, last released first; `forge release status` shows the tags and versions each step recorded.');
  for (const r of [...plan.repos].reverse()) {
    out.push(`### ${r.label}`);
    if (!r.rollback.length) out.push('- nothing outward-facing to undo');
    for (const line of r.rollback) out.push(`- ${line}`);
  }
  return out.join('\n') + '\n';
}
