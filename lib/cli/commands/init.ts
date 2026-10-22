// `forge init write` and `forge migrate`: setting a repo up and keeping its files current.
// `forge doctor` lives in lib/engine/ops/doctor.ts, which the dashboard's /api/doctor shares.
import fs from 'node:fs';
import path from 'node:path';
import { defaults, stringifyConfig, validateConfig } from '../../core/config/load.ts';
import { configLock } from '../../core/config/set.ts';
import { listJobs, jobDir } from '../../core/job/store.ts';
import { paths, exists, PLUGIN_ROOT } from '../../core/paths.ts';
import { matchPolicy } from '../../core/config/validators/policy-check.ts';
import { modelOverlap } from '../../engine/pipeline/roster.ts';
import { migrateConfig, normalizeJob, serializeJob } from '../../core/job/schema.ts';
import { deepMerge } from '../../core/shape.ts';
import { ForgeError } from '../../core/errors.ts';
import { readJson, readText, writeJsonAtomic } from '../../core/os/fs.ts';
import { withLock } from '../../core/os/lock.ts';
import * as yaml from '../../core/format/yaml.ts';
import type { HelpGroup } from '../../core/types.ts';

export const HELP: HelpGroup[] = [
  {
    name: 'init',
    summary: 'set Forge up in this repo (/forge init drives it)',
    commands: [
      { command: 'init detect', args: '', summary: "the repo's stack, commands and components, as /forge init sees them" },
      {
        command: 'init write',
        args: '--answers FILE [--force]',
        summary: 'write .forge/config.yml from a JSON answers file, merged over the current config, and seed .forge/',
        flags: [
          ['--answers FILE', 'the answers, as JSON'],
          ['--force', 'start from the defaults instead of the current config'],
        ],
        exits: [[1, 'the answers file cannot be read']],
      },
    ],
  },
  {
    name: 'migrate',
    summary: 'bring config.yml and every job.json to the current schema',
    commands: [{ command: 'migrate', args: '', summary: 'bring config.yml and every job.json to the current schema, listing the files it changed' }],
  },
];

/** `answers` is the orchestrator's JSON file, merged over defaults and validated before anything is written. */
export function initWrite(root: string, answers: any, force: boolean): { ok: true; written: string[]; warnings: string[] } {
  // Same lock as `forge config set`, so a dashboard Save can't interleave with this rewrite.
  return withLock(configLock(root), () => writeInit(root, answers, force));
}

const LOCAL_YML_LINES = '# Machine-local paths (member repo clones); never committed.\nlocal.yml\n';

/**
 * Appends a `local.yml` line to an existing `.forge/.gitignore` that lacks one, leaving every other
 * line alone: a repo initialized before member repos would otherwise commit its machine paths.
 */
function ignoreLocalYml(file: string): boolean {
  if (!exists(file)) return false;
  const text = readText(file);
  if (text.split(/\r?\n/).some((l) => ['local.yml', '/local.yml'].includes(l.trim()))) return false;
  fs.appendFileSync(file, (text && !text.endsWith('\n') ? '\n' : '') + LOCAL_YML_LINES);
  return true;
}

export const RELEASE_GATE_WARNING =
  'seeded the release gate: commit .forge/ci/release-gate.mjs and .github/workflows/forge-release-gate.yml, then make the "release gate" check required in branch protection (docs/CONFIG.md "Release gate")';

/** Whether the config pins any dependency (git-ref or canary, at the root or a member): only those leave a pin a CI check can see. */
function seedsReleaseGate(config: any): boolean {
  const repos: any[] = Array.isArray(config?.repos) ? config.repos : [];
  return [config?.release?.interim, ...repos.map((r) => r?.release?.interim)].some((s) => s === 'git-ref' || s === 'canary');
}

export const RELEASE_GATE_RULE = { paths: ['.forge/ci/**'], action: 'refuse', reason: "Forge's own policy changes only by a human on the base branch" } as const;

/**
 * A repo initialised before the gate existed keeps its own protectedPaths list, which the new
 * default never reaches; without a refuse rule a job could weaken the script its own PR runs.
 */
function protectReleaseGate(config: any): void {
  const rules: any[] = Array.isArray(config?.policy?.protectedPaths) ? config.policy.protectedPaths : [];
  // A malformed rule is validateConfig's to report, not a match.
  const wellFormed = rules.filter((r) => r && Array.isArray(r.paths) && r.paths.every((g: unknown) => typeof g === 'string'));
  if (matchPolicy('.forge/ci/release-gate.mjs', wellFormed)?.action === 'refuse') return;
  config.policy = { ...(config.policy ?? {}), protectedPaths: [...rules, { ...RELEASE_GATE_RULE, paths: [...RELEASE_GATE_RULE.paths] }] };
}

function writeInit(root: string, answers: any, force: boolean): { ok: true; written: string[]; warnings: string[] } {
  const p = paths(root);
  if (exists(p.config) && !force) {
    const current = yaml.parse(readText(p.config)) ?? {};
    answers = deepMerge(migrateConfig(current).config, answers);
  }
  const config = deepMerge(defaults(), answers);
  if (Array.isArray(answers?.review?.panel)) config.review.panel = answers.review.panel;
  if (seedsReleaseGate(config)) protectReleaseGate(config);
  const problems = validateConfig(config, root);
  if (problems.length) throw new ForgeError(`config would be invalid:\n- ${problems.join('\n- ')}`, 'config_invalid');
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.config, stringifyConfig(config));
  const written = [path.relative(root, p.config)];
  const tpl = path.join(PLUGIN_ROOT, 'templates');
  const seeds: [string, string][] = [
    [path.join(tpl, 'gitignore'), path.join(p.dir, '.gitignore')],
    [path.join(tpl, 'learnings.md'), path.join(p.notes, 'learnings.md')],
    [path.join(tpl, 'README.md'), path.join(p.dir, 'README.md')],
  ];
  if (config.tracker.kind === 'local') seeds.push([path.join(tpl, 'backlog.md'), path.join(root, config.tracker.local.path)]);
  const gate: [string, string][] = seedsReleaseGate(config)
    ? [
        [path.join(tpl, 'release-gate', 'release-gate.mjs'), path.join(p.dir, 'ci', 'release-gate.mjs')],
        [path.join(tpl, 'release-gate', 'forge-release-gate.yml'), path.join(root, '.github', 'workflows', 'forge-release-gate.yml')],
      ]
    : [];
  const gateDst = new Set(gate.map(([, g]) => g));
  let gateWritten = false;
  for (const [src, dst] of [...seeds, ...gate]) {
    if (exists(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    written.push(path.relative(root, dst));
    if (gateDst.has(dst)) gateWritten = true;
  }
  if (ignoreLocalYml(path.join(p.dir, '.gitignore'))) {
    const rel = path.relative(root, path.join(p.dir, '.gitignore'));
    if (!written.includes(rel)) written.push(rel);
  }
  const warnings = [...modelOverlap(config).warnings];
  if (gateWritten) warnings.push(RELEASE_GATE_WARNING);
  return { ok: true, written, warnings };
}

export function migrate(root: string): { changed: string[] } {
  const p = paths(root);
  const changed: string[] = [];
  if (exists(p.config)) {
    withLock(configLock(root), () => {
      const raw = yaml.parse(readText(p.config)) ?? {};
      const m = migrateConfig(raw);
      if (m.from !== undefined) {
        fs.writeFileSync(p.config, stringifyConfig(m.config));
        changed.push(path.relative(root, p.config));
      }
    });
  }
  for (const j of listJobs(root)) {
    const file = path.join(jobDir(root, j.id), 'job.json');
    const raw = readJson(file);
    const next = serializeJob(normalizeJob(raw));
    if (JSON.stringify(raw) !== JSON.stringify(next)) {
      writeJsonAtomic(file, next);
      changed.push(path.relative(root, file));
    }
  }
  return { changed };
}
