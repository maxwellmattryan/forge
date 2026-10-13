// @ts-check
// The agent roster: every role's prompt, the model it runs on, and a content hash of the
// prompt plus the repo's addendum for that role. Hashes let eval runs and retros attribute a
// change in behaviour to a change in instructions.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { modelFor, reviewerChecklist } from './config.mjs';
import { paths, exists, PLUGIN_ROOT } from './paths.mjs';
import { readText } from './util.mjs';

/** @param {string} text */
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  /** @type {Record<string, string>} */
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

/** @param {...string} parts */
const hash = (...parts) => crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 12);

/** @param {string} root @param {any} config */
export function roster(root, config) {
  const p = paths(root);
  const learnings = readText(path.join(p.notes, 'learnings.md'));
  const agentsDir = path.join(PLUGIN_ROOT, 'agents');
  const agents = fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const role = f.replace(/\.md$/, '');
      const { meta, body } = frontmatter(readText(path.join(agentsDir, f)));
      const addendumFile = path.join(p.notes, `${role}.md`);
      const addendum = readText(addendumFile);
      return {
        role,
        description: meta.description ?? '',
        model: config.runtime.models[role] ?? meta.model ?? 'inherit',
        promptHash: hash(body, addendum, learnings),
        addendum: exists(addendumFile) ? path.relative(root, addendumFile) : null,
      };
    });
  const reviewers = (config.review.panel ?? []).map((/** @type {any} */ r) => {
    const file = reviewerChecklist(root, r.name, r.checklist);
    return {
      name: r.name,
      model: r.model ?? modelFor(config, 'reviewer'),
      always: Boolean(r.always),
      when: r.when ?? null,
      checklist: file ? (file.startsWith(root) ? path.relative(root, file) : `plugin:reviewers/${path.basename(file)}`) : null,
      checklistHash: file ? hash(readText(file)) : null,
    };
  });
  const { enabled, builder, overlap, warnings } = modelOverlap(config);
  return {
    agents,
    reviewers,
    learnings: learnings ? path.relative(root, path.join(p.notes, 'learnings.md')) : null,
    diversity: { enabled, builder, overlap },
    warnings,
  };
}

/**
 * A model's family: same-family models share training and therefore blind spots, which is
 * what diversity guards against; version suffixes don't change that.
 * @param {any} config @param {string} model
 */
export function modelFamily(config, model) {
  let m = String(model ?? 'inherit');
  if (m.toLowerCase() === 'inherit') m = String(config.runtime?.models?.orchestrator ?? 'inherit');
  const fam = m.match(/(opus|sonnet|haiku|fable)/i);
  return fam ? fam[1].toLowerCase() : m.toLowerCase();
}

/**
 * Which gatekeepers (approver, then panel lenses in order) share the builder's model family.
 * Pure: config in, report out. Warnings only when `runtime.diversity` asks for them.
 * @param {any} config
 */
export function modelOverlap(config) {
  const enabled = config.runtime?.diversity === true;
  const builder = modelFor(config, 'builder');
  const family = modelFamily(config, builder);
  const candidates = [
    { role: 'approver', model: modelFor(config, 'approver') },
    ...(config.review?.panel ?? []).map((/** @type {any} */ r) => ({ role: `reviewer:${r.name}`, model: r.model ?? modelFor(config, 'reviewer') })),
  ];
  const overlap = candidates.filter((c) => modelFamily(config, c.model) === family);
  const warnings = enabled
    ? overlap.map((o) => `${o.role} runs on ${o.model}, the same model family as the builder (${builder}); runtime.diversity asks for a different one`)
    : [];
  return { enabled, builder, overlap, warnings };
}
