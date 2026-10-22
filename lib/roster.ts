// The agent roster: every role's prompt, the model it runs on, and a content hash of the
// prompt plus the repo's addendum for that role. Hashes let eval runs and retros attribute a
// change in behaviour to a change in instructions; lib/provenance.ts computes them, so the roster
// and every agent-start event never disagree.
import fs from 'node:fs';
import path from 'node:path';
import { modelFor, resolveEffort, validModel } from './config.ts';
import { learningSummary } from './learnings.ts';
import { paths, exists, PLUGIN_ROOT } from './paths.ts';
import { frontmatter, lensChecklist, promptHash } from './provenance.ts';
import type { Config, PanelEntry, Roster, RosterModelBy } from './types.ts';
import { readText } from './util.ts';

export { verifierDigest } from './provenance.ts';

/** The builder's overrides as resolveModel reads them: an invalid value shows as null, as it resolves. */
export function builderModelBy(config: Config): RosterModelBy {
  const by: Record<string, unknown> | null | undefined = config.runtime?.modelByComplexity;
  const at = (k: string) => (by && typeof by === 'object' && !Array.isArray(by) ? validModel(by[k]) : null);
  return { low: at('low'), medium: at('medium'), high: at('high'), rework: validModel(config.runtime?.reworkModel) };
}

export function roster(root: string, config: Config): Roster {
  const p = paths(root);
  const learnings = readText(path.join(p.notes, 'learnings.md'));
  const agentsDir = path.join(PLUGIN_ROOT, 'agents');
  const agents = fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const role = f.replace(/\.md$/, '');
      const { meta } = frontmatter(readText(path.join(agentsDir, f)));
      const addendumFile = path.join(p.notes, `${role}.md`);
      // No job: what a spawn gets before a job's own effort or complexity applies.
      const effort = resolveEffort(config, null, role);
      return {
        role,
        description: meta.description ?? '',
        model: config.runtime.models[role] ?? meta.model ?? 'inherit',
        // Null only for a file name that is no role (agentRoles' rule); the roster still lists it.
        promptHash: promptHash(root, config, role) ?? '',
        addendum: exists(addendumFile) ? path.relative(root, addendumFile) : null,
        effort: effort.level,
        effortSource: effort.source,
        ...(role === 'builder' ? { modelBy: builderModelBy(config) } : {}),
      };
    });
  const reviewers = (config.review.panel ?? []).map((r: PanelEntry) => {
    const { file, hash } = lensChecklist(root, config, r.name);
    const effort = resolveEffort(config, null, `reviewer:${r.name}`);
    return {
      name: r.name,
      model: r.model ?? modelFor(config, 'reviewer'),
      always: Boolean(r.always),
      when: r.when ?? null,
      checklist: file ? (file.startsWith(root) ? path.relative(root, file) : `plugin:reviewers/${path.basename(file)}`) : null,
      checklistHash: hash,
      effort: effort.level,
      effortSource: effort.source,
    };
  });
  const { enabled, builder, overlap, warnings } = modelOverlap(config);
  const summary = learningSummary(learnings);
  return {
    agents,
    reviewers,
    learnings: learnings ? path.relative(root, path.join(p.notes, 'learnings.md')) : null,
    learningCount: summary.count,
    oldestReviewBy: summary.oldestReviewBy,
    diversity: { enabled, builder, overlap },
    warnings,
  };
}

/**
 * A model's family: same-family models share training and therefore blind spots, which is
 * what diversity guards against; version suffixes don't change that.
 */
export function modelFamily(config: Config, model: string): string {
  let m = String(model ?? 'inherit');
  if (m.toLowerCase() === 'inherit') m = String(config.runtime?.models?.orchestrator ?? 'inherit');
  const fam = m.match(/(opus|sonnet|haiku|fable)/i);
  return fam ? fam[1].toLowerCase() : m.toLowerCase();
}

/**
 * Which gatekeepers (approver, then panel lenses in order) share the builder's model family.
 * Pure: config in, report out. Warnings only when `runtime.diversity` asks for them.
 */
export function modelOverlap(config: Config): { enabled: boolean; builder: string; overlap: { role: string; model: string }[]; warnings: string[] } {
  const enabled = config.runtime?.diversity === true;
  const builder = modelFor(config, 'builder');
  const family = modelFamily(config, builder);
  const candidates = [
    { role: 'approver', model: modelFor(config, 'approver') },
    ...(config.review?.panel ?? []).map((r: PanelEntry) => ({ role: `reviewer:${r.name}`, model: r.model ?? modelFor(config, 'reviewer') })),
  ];
  const overlap = candidates.filter((c) => modelFamily(config, c.model) === family);
  const warnings = enabled
    ? overlap.map((o) => `${o.role} runs on ${o.model}, the same model family as the builder (${builder}); runtime.diversity asks for a different one`)
    : [];
  return { enabled, builder, overlap, warnings };
}
