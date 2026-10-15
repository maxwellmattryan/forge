// `forge init write` and `forge migrate`: setting a repo up and keeping its files current.
// `forge doctor` lives in lib/doctor.ts, which the dashboard's /api/doctor shares.
import fs from 'node:fs';
import path from 'node:path';
import { defaults, stringifyConfig, validateConfig } from '../config.ts';
import { configLock } from '../config-set.ts';
import { listJobs, jobDir } from '../jobs.ts';
import { paths, exists, PLUGIN_ROOT } from '../paths.ts';
import { modelOverlap } from '../roster.ts';
import { migrateConfig, normalizeJob, serializeJob } from '../schema.ts';
import { ForgeError, deepMerge, readJson, readText, withLock, writeJsonAtomic } from '../util.ts';
import * as yaml from '../yaml.ts';
import type { HelpGroup } from '../types.ts';

export const HELP: HelpGroup[] = [
  {
    name: 'init',
    summary: 'set Forge up in this repo (/forge init drives it)',
    commands: [
      { command: 'init detect', args: '', summary: "the repo's stack, commands and services, as /forge init sees them" },
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

function writeInit(root: string, answers: any, force: boolean): { ok: true; written: string[]; warnings: string[] } {
  const p = paths(root);
  if (exists(p.config) && !force) {
    const current = yaml.parse(readText(p.config)) ?? {};
    answers = deepMerge(migrateConfig(current).config, answers);
  }
  const config = deepMerge(defaults(), answers);
  if (Array.isArray(answers?.review?.panel)) config.review.panel = answers.review.panel;
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
  for (const [src, dst] of seeds) {
    if (exists(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    written.push(path.relative(root, dst));
  }
  return { ok: true, written, warnings: modelOverlap(config).warnings };
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
