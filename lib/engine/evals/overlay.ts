// Per-run config overlays for evals: `forge eval start --set key=value` records typed values on the
// run and on each eval job, and every command that acts on such a job reads its config through
// configForJob. .forge/config.yml is never written, so a variant needs no edit that trips the daemon
// trust check. The overlay changes which verify steps run, budgets, models and the review panel, so
// it is an allowlist checked when the run starts and again on every load: a hand-edited job.json
// fails closed instead of running whatever it names.
import { panelPathsProblems, pathsOnlyProblems, reviewerChecklist, validateConfig, verifyShapeProblems, verifySteps } from '#core/config/load.ts';
import { FIELDS, MODEL_RE, parseCliValue, stringProblem, validateFieldValue } from '#core/config/fields.ts';
import { EFFORTS } from '#core/job/schema.ts';
import type { Config, EvalOverlay, Job } from '#core/types.ts';
import { isMap, setPath, show } from '#core/shape.ts';
import { ForgeError } from '#core/errors.ts';
import * as yaml from '#core/format/yaml.ts';

export type { EvalOverlay };

/** Keys whose whole value the overlay replaces, parsed from a YAML or JSON flow list. */
const LIST_KEYS = ['verify', 'review.panel'];

// The orchestrator's model is read by no per-job session, so overlaying it would silently do nothing.
const FIELD_KEYS = FIELDS.filter(
  (f) =>
    f.editable &&
    f.key !== 'runtime.models.orchestrator' &&
    (f.key.startsWith('runtime.models.') ||
      f.key === 'runtime.effort' ||
      f.key.startsWith('runtime.efforts.') ||
      f.key.startsWith('runtime.effortByComplexity.') ||
      f.key.startsWith('runtime.modelByComplexity.') ||
      f.key === 'runtime.reworkModel' ||
      f.key === 'review.onRework' ||
      f.key.startsWith('pipeline.')),
).map((f) => f.key);

/** Exact keys only, so no `__proto__` or other segment can reach setPath. */
const ALLOWED = new Set([...FIELD_KEYS, ...LIST_KEYS]);

const ALLOWLIST = 'runtime.models.<role> (not orchestrator), runtime.effort, runtime.efforts.<role>, runtime.effortByComplexity.<level>, runtime.modelByComplexity.<level>, runtime.reworkModel, review.onRework, pipeline.*, review.panel or verify';
const PANEL_KEYS = new Set(['name', 'always', 'when', 'model', 'effort', 'needsApp', 'paths', 'pathsOnly', 'alwaysOnRework']);
// A lens name becomes a checklist file name, so it is one plain path segment.
const LENS_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// lib/core/format/yaml.ts reads a `__proto__:` key as the parsed map's prototype, which Object.keys never shows,
// so a map whose prototype isn't a plain one is refused rather than checked key by key.
const plainMap = (v: unknown): v is Record<string, any> => isMap(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));

function keyProblem(key: string): string | null {
  return ALLOWED.has(key) ? null : `${show(key, 80)} can't be overlaid; allowed: ${ALLOWLIST}`;
}

/** Parses `--set key=value` pairs into typed values; throws a ForgeError naming the first bad key. */
export function parseOverlay(root: string, config: Config, sets: string[]): EvalOverlay {
  const overlay: EvalOverlay = Object.create(null);
  for (const kv of sets) {
    const eq = kv.indexOf('=');
    if (eq < 1) throw new ForgeError(`--set expects key=value, got ${show(kv, 80)}`);
    const key = kv.slice(0, eq).trim();
    const raw = kv.slice(eq + 1).trim();
    const refused = keyProblem(key);
    if (refused) throw new ForgeError(`--set ${refused}`);
    if (Object.hasOwn(overlay, key)) throw new ForgeError(`--set ${key} is given more than once`);
    if (LIST_KEYS.includes(key)) {
      const bad = () => new ForgeError(`--set ${key} must be a list like [a, b] (got ${show(raw, 80)})`);
      if (!raw.startsWith('[')) throw bad();
      try {
        overlay[key] = yaml.parseScalar(raw, 0);
      } catch {
        throw bad();
      }
    } else {
      // keyProblem passed, so the field exists.
      overlay[key] = parseCliValue(FIELDS.find((f) => f.key === key)!, raw);
    }
  }
  const [problem] = overlayProblems(root, config, overlay);
  if (problem) throw new ForgeError(`--set ${problem}`);
  // A plain object again, so it serialises and compares like any other.
  return { ...overlay };
}

function panelProblems(root: string, panel: unknown): string[] {
  if (!Array.isArray(panel) || !panel.length) return [`review.panel overlay needs at least one reviewer (got ${show(panel, 80)})`];
  const problems: string[] = [];
  panel.forEach((r: unknown, i) => {
    const at = `review.panel entry ${i + 1}`;
    if (!plainMap(r)) return void problems.push(`${at} must be a map (got ${show(r, 80)})`);
    for (const k of Object.keys(r)) if (!PANEL_KEYS.has(k)) problems.push(`${at}: ${show(k, 80)} is not allowed in an overlay (allowed: ${[...PANEL_KEYS].join(', ')})`);
    if (typeof r.name !== 'string' || !LENS_NAME.test(r.name)) problems.push(`${at}: name must be a lens name (got ${show(r.name, 80)})`);
    else if (!reviewerChecklist(root, r.name)) problems.push(`${at}: reviewer "${r.name}" has no checklist (looked in .forge/reviewers/ and the plugin's reviewers/)`);
    for (const k of ['always', 'needsApp', 'alwaysOnRework'])
      if (r[k] !== undefined && typeof r[k] !== 'boolean') problems.push(`${at}: ${k} must be true or false (got ${show(r[k], 80)})`);
    if (r.when !== undefined) {
      if (typeof r.when !== 'string') problems.push(`${at}: when must be text (got ${show(r.when, 80)})`);
      else {
        const p = stringProblem({ key: 'review.panel' }, r.when, `${at}: when`);
        if (p) problems.push(p);
      }
    }
    if (r.model !== undefined && (typeof r.model !== 'string' || r.model.length > 200 || !MODEL_RE.test(r.model)))
      problems.push(`${at}: model must be a model alias or id: letters, digits and . _ : - [ ] (got ${show(r.model, 80)})`);
    if (r.effort !== undefined && r.effort !== null && !(EFFORTS as readonly unknown[]).includes(r.effort))
      problems.push(`${at}: effort must be one of ${EFFORTS.join(' | ')} (got ${show(r.effort, 80)})`);
    if (r.paths !== undefined) problems.push(...panelPathsProblems(typeof r.name === 'string' ? r.name : `entry ${i + 1}`, r.paths).map((p) => `${at}: ${p}`));
    problems.push(...pathsOnlyProblems(r).map((p) => `${at}: ${p}`));
  });
  return problems;
}

function verifyOverlayProblems(base: Config, verify: unknown): string[] {
  if (!Array.isArray(verify) || !verify.length) return [`verify overlay needs at least one step (got ${show(verify, 80)})`];
  const shape = verifyShapeProblems(verify);
  if (shape.length) return shape;
  const commands: Record<string, unknown> = base.commands && typeof base.commands === 'object' ? base.commands : {};
  return [...new Set(verifySteps(verify))].filter((n) => !Object.hasOwn(commands, n)).map((n) => `verify step "${n}" is not a key in commands`);
}

/**
 * Why `overlay` can't be applied to `base`: run when a run starts and on every load, so an overlay
 * that skipped the start-time checks fails closed. An empty list means it is usable.
 */
export function overlayProblems(root: string, base: Config, overlay: unknown): string[] {
  if (!plainMap(overlay)) return [`the overlay must be a map of config keys (got ${show(overlay, 80)})`];
  const problems: string[] = [];
  for (const [key, value] of Object.entries(overlay)) {
    const refused = keyProblem(key);
    if (refused) problems.push(refused);
    else if (key === 'verify') problems.push(...verifyOverlayProblems(base, value));
    else if (key === 'review.panel') problems.push(...panelProblems(root, value));
    else {
      const p = validateFieldValue(FIELDS.find((f) => f.key === key)!, value);
      if (p) problems.push(p);
    }
  }
  if (problems.length) return problems;
  // The rule `forge config set` follows: the result may add no problem the base config lacks.
  const had = new Set(validateConfig(base, root));
  return validateConfig(applyOverlay(base, overlay), root).filter((p) => !had.has(p));
}

/** `base` with each overlay key set; `review.panel` and `verify` replace the whole value. */
export function applyOverlay(base: Config, overlay: EvalOverlay | null | undefined): Config {
  if (!overlay || !Object.keys(overlay).length) return base;
  const next = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) setPath(next, key, structuredClone(value));
  return next;
}

/**
 * The config a command acting on `job` uses: the base config, or for an eval job with an overlay,
 * the overlaid config after checking it again. A problem throws, so nothing runs on it.
 */
export function configForJob(root: string, config: Config, job: Pick<Job, 'id' | 'kind' | 'eval'>): Config {
  if (job.kind !== 'eval') return config;
  const overlay: unknown = job.eval?.overlay;
  if (overlay === undefined || overlay === null) return config;
  if (plainMap(overlay) && !Object.keys(overlay).length) return config;
  const [problem] = overlayProblems(root, config, overlay);
  if (problem) throw new ForgeError(`eval job ${job.id} has an invalid config overlay: ${problem}`);
  return applyOverlay(config, overlay as EvalOverlay);
}

