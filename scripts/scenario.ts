// `npm run scenario -- <name> | --list`: seeds a named dashboard scenario (test/fixtures/scenarios/<name>.json)
// into a fresh scratch FORGE_ROOT through the CLI alone, prints its path and waits; a signal removes it.
// `npm run dev -- --scenario` and `npm run test:render` seed through seedScenario. docs/TESTING.md
// › "Dashboard scenarios and the render check" has the format.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ROOT, jobDir } from '../lib/core/paths.ts';
import { gitEnv } from '../lib/integrations/git/runner.ts';
import { VIEWS } from '../dashboard/src/lib/nav.ts';
import type { ViewId } from '../dashboard/src/lib/nav.ts';
import { gitSync } from './git.ts';

export const SCENARIO_DIR = path.join(PLUGIN_ROOT, 'test', 'fixtures', 'scenarios');
export const SCENARIO_NAME = /^[a-z0-9][a-z0-9-]*$/;
const BIN = path.join(PLUGIN_ROOT, 'bin', 'forge');
const MESSAGES = path.join(PLUGIN_ROOT, 'dashboard', 'src', 'messages', 'en.json');
const USAGE = 'usage: npm run scenario -- <name> | --list';
const PREFIX = 'forge-scenario-';
const STEP_TIMEOUT_MS = 60_000;

// Steps can't start a server, a session or a release: only these command groups run.
const STEP_COMMANDS = new Set(['job', 'worktree', 'verify', 'requests']);
// The seeder passes these to `forge job new` itself.
const NEW_FLAGS_REFUSED = ['--title', '--slug', '--session', '--body-file'];
// What a scenario's config may set. tracker, daemon, foreman, worktrees, notify, repos and the rest
// are the seeder's or refused, so no scenario reaches GitHub, a webhook, the daemon or another repo.
const CONFIG_KEYS = new Set(['project', 'commands', 'verify', 'runtime', 'pipeline', 'review', 'components', 'budget', 'usage']);
const FILE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const STATE_FILES = new Set(['job.json', 'events.jsonl']);
// The variables that would point a child CLI at another root, the daemon's session or a job's own
// ports and actor; the git location variables go through gitEnv.
const FORGE_DROPPED = /^FORGE_(DAEMON|PORT|ENDPOINT|BACKING|ROOT|JOB|WORKTREE|ACTOR|NOTIFY|MODE)(_|$)/;

export interface ScenarioStep {
  argv: string[];
  exit: number;
}

export interface ScenarioJob {
  key: string;
  title: string;
  new: string[];
  files: Record<string, string>;
  steps: ScenarioStep[];
}

export interface ResolvedExpect {
  views: Record<ViewId, string[]>;
  drawer: { title: string; text: string[] } | null;
}

export interface Scenario {
  name: string;
  description: string;
  config: Record<string, unknown>;
  jobs: ScenarioJob[];
  expect: ResolvedExpect;
}

export interface Seeded {
  name: string;
  root: string;
  worktrees: string;
  /** Job key to job id. */
  jobs: Record<string, string>;
  expect: ResolvedExpect;
  ms: number;
  /** Removes root and its .worktrees sibling; idempotent. */
  cleanup(): void;
}

/** The scenario names in `dir`: its `.json` basenames, sorted. */
export function listScenarios(dir: string = SCENARIO_DIR): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

function onlyKeys(o: Record<string, unknown>, allowed: string[], where: string, fail: (m: string) => never): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`unknown key "${k}"${where ? ` in ${where}` : ''}`);
}

let messages: unknown = null;
function message(key: string, fail: (m: string) => never): string {
  messages ??= JSON.parse(fs.readFileSync(MESSAGES, 'utf8'));
  let v: unknown = messages;
  for (const part of key.split('.')) {
    if (!isObject(v) || !Object.prototype.hasOwnProperty.call(v, part)) fail(`unknown message key "${key}"`);
    v = (v as Record<string, unknown>)[part];
  }
  if (typeof v !== 'string') fail(`message key "${key}" is not a plain string`);
  // A placeholder's value differs per state, so only the text before the first one is expected.
  const text = (v as string).split('{')[0].trim();
  if (!text) fail(`message key "${key}" has no text before its first placeholder`);
  return text;
}

/**
 * Reads and checks `<dir>/<name>.json`, resolving each `@key` in expect against en.json. Throws
 * `scenario <name>: <problem>` before anything is seeded.
 */
export function loadScenario(name: string, dir: string = SCENARIO_DIR): Scenario {
  const fail = (m: string): never => {
    throw new Error(`scenario ${name}: ${m}`);
  };
  if (typeof name !== 'string' || !SCENARIO_NAME.test(name)) fail(`scenario name must match ${SCENARIO_NAME}`);
  const known = listScenarios(dir);
  if (!known.includes(name)) fail(`unknown scenario "${name}" (${known.join(', ') || 'none'})`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
  } catch (e) {
    fail(`not valid JSON: ${(e as Error).message}`);
  }
  if (!isObject(raw)) fail('a scenario is a JSON object');
  const s = raw as Record<string, unknown>;
  onlyKeys(s, ['description', 'config', 'jobs', 'expect'], '', fail);
  if (typeof s.description !== 'string' || !s.description.trim()) fail('description must be a non-empty string');

  const config = s.config ?? {};
  if (!isObject(config)) fail('config must be an object');
  for (const k of Object.keys(config)) if (!CONFIG_KEYS.has(k)) fail(`config key "${k}" is not allowed`);

  const rawJobs = s.jobs ?? [];
  if (!Array.isArray(rawJobs)) fail('jobs must be a list');
  const keys: string[] = [];
  for (const j of rawJobs as unknown[]) {
    if (!isObject(j)) fail('each job is an object');
    const key = (j as Record<string, unknown>).key;
    if (typeof key !== 'string' || !SCENARIO_NAME.test(key)) fail(`job key ${JSON.stringify(key)} must match ${SCENARIO_NAME}`);
    if (keys.includes(key as string)) fail(`duplicate job key "${key}"`);
    keys.push(key as string);
  }

  // `{id}` is the step's own job, `{id:<key>}` another one; `earlier` limits a job's `new` flags to
  // the jobs created before it.
  const checkPlaceholders = (arg: string, where: string, allowed: string[], own: boolean): void => {
    for (const m of arg.matchAll(/\{id[^}]*\}?/g)) {
      const tok = m[0];
      if (tok === '{id}') {
        if (!own) fail(`${where}: {id} is not allowed here`);
        continue;
      }
      const ref = /^\{id:([^}]*)\}$/.exec(tok);
      if (!ref) fail(`${where}: bad placeholder "${tok}"`);
      const k = ref![1];
      if (!keys.includes(k)) fail(`${where}: unknown job key "${k}"`);
      if (!allowed.includes(k)) fail(`${where}: {id:${k}} names a job not created yet`);
    }
  };

  const jobs: ScenarioJob[] = (rawJobs as Record<string, unknown>[]).map((j, i) => {
    const key = j.key as string;
    onlyKeys(j, ['key', 'title', 'new', 'files', 'steps'], `job "${key}"`, fail);
    if (typeof j.title !== 'string' || !j.title.trim()) fail(`job "${key}": title must be a non-empty string`);
    const flags = j.new ?? [];
    if (!isStringList(flags)) fail(`job "${key}": new must be a list of strings`);
    for (const f of flags as string[]) {
      const bad = NEW_FLAGS_REFUSED.find((r) => f === r || f.startsWith(`${r}=`));
      if (bad) fail(`job "${key}": new must not pass ${bad}; the seeder sets it`);
      if (f === '--json') fail(`job "${key}": new must not pass --json; the seeder appends it`);
      checkPlaceholders(f, `job "${key}" new`, keys.slice(0, i), false);
    }
    const files = j.files ?? {};
    if (!isObject(files)) fail(`job "${key}": files must be an object`);
    for (const [p, v] of Object.entries(files as Record<string, unknown>)) {
      if (!FILE_PATH.test(p) || STATE_FILES.has(p.toLowerCase())) fail(`job "${key}": file path "${p}" must be job-dir-relative and not job.json or events.jsonl`);
      if (typeof v !== 'string') fail(`job "${key}": file "${p}" must be a string`);
    }
    const rawSteps = j.steps ?? [];
    if (!Array.isArray(rawSteps)) fail(`job "${key}": steps must be a list`);
    const steps = (rawSteps as unknown[]).map((st, n): ScenarioStep => {
      const where = `job "${key}" step ${n + 1}`;
      let step: ScenarioStep;
      if (isStringList(st)) step = { argv: st, exit: 0 };
      else if (isObject(st)) {
        onlyKeys(st, ['argv', 'exit'], where, fail);
        if (!isStringList(st.argv) || !Number.isInteger(st.exit)) fail(`${where}: a step object is { argv: string[], exit: integer }`);
        step = { argv: st.argv as string[], exit: st.exit as number };
      } else return fail(`${where}: a step is a string list or { argv, exit }`);
      if (!step.argv.length) fail(`${where}: argv is empty`);
      if (!STEP_COMMANDS.has(step.argv[0])) fail(`${where}: forge ${step.argv[0]} is not allowed (only ${[...STEP_COMMANDS].join(', ')})`);
      if (step.argv.includes('--json')) fail(`${where}: must not pass --json; the seeder appends it`);
      for (const a of step.argv) checkPlaceholders(a, where, keys, true);
      return step;
    });
    return { key, title: j.title as string, new: flags as string[], files: files as Record<string, string>, steps };
  });

  const rawExpect = s.expect;
  if (!isObject(rawExpect)) fail('expect must be an object');
  const e = rawExpect as Record<string, unknown>;
  onlyKeys(e, [...VIEWS.map((v) => v.id), 'drawer'], 'expect', fail);
  const resolve = (list: unknown, what: string): string[] => {
    if (!isStringList(list) || !list.length || list.some((t) => !t.trim())) fail(`expect has no text for ${what}`);
    return (list as string[]).map((t) => (t.startsWith('@') ? message(t.slice(1), fail) : t));
  };
  const views = Object.fromEntries(VIEWS.map((v) => [v.id, resolve(e[v.id], v.id)])) as Record<ViewId, string[]>;
  let drawer: ResolvedExpect['drawer'] = null;
  if (e.drawer !== undefined) {
    if (!jobs.length) fail('drawer needs a job');
    if (!isObject(e.drawer)) fail('expect.drawer must be an object');
    const d = e.drawer as Record<string, unknown>;
    onlyKeys(d, ['job', 'text'], 'expect.drawer', fail);
    if (d.job !== undefined && (typeof d.job !== 'string' || !keys.includes(d.job))) fail(`expect.drawer: unknown job key "${String(d.job)}"`);
    const job = jobs.find((j) => j.key === (d.job ?? jobs[0].key))!;
    drawer = { title: job.title, text: d.text === undefined ? [] : resolve(d.text, 'drawer') };
  } else if (jobs.length) drawer = { title: jobs[0].title, text: [] };

  return { name, description: s.description as string, config: config as Record<string, unknown>, jobs, expect: { views, drawer } };
}

/**
 * The environment every child of a seed (git and the CLI) gets: `env` without the git location
 * variables and the FORGE_ ones that would steer the CLI elsewhere, then FORGE_ROOT pinned to `root`.
 */
export function scenarioEnv(env: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const out = gitEnv(env);
  for (const k of Object.keys(out)) if (FORGE_DROPPED.test(k)) delete out[k];
  out.FORGE_ROOT = root;
  return out;
}

const tail = (s: string, n = 400): string => (s.length > n ? s.slice(-n) : s).trim();

function cli(argv: string[], root: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...argv, '--json'], { cwd: root, env, timeout: STEP_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (err as NodeJS.ErrnoException & { code?: unknown }).code : 0;
      resolve({ code: typeof code === 'number' ? code : null, stdout, stderr });
    });
  });
}

/**
 * Seeds scenario `name` into a fresh scratch repo under os.tmpdir(), writing Forge state only through
 * bin/forge. On a failed step it removes what it made and rejects with the step's argv, its exit and
 * the tail of its output. The returned cleanup also runs on process exit.
 */
export async function seedScenario(name: string, opts: { dir?: string; env?: NodeJS.ProcessEnv; log?: (s: string) => void } = {}): Promise<Seeded> {
  const scenario = loadScenario(name, opts.dir);
  const started = Date.now();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)));
  const worktrees = `${root}.worktrees`;
  const created = root;
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    process.removeListener('exit', cleanup);
    // Only the two paths this call made, behind the prefix: nothing else is ever deleted.
    if (!path.basename(root).startsWith(PREFIX) || root !== created) return;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(worktrees, { recursive: true, force: true });
  };
  process.on('exit', cleanup);
  opts.log?.(`seeding ${name} into ${root}`);
  const env = scenarioEnv(opts.env ?? process.env, root);
  const fail = (m: string): never => {
    cleanup();
    throw new Error(`scenario ${name}: ${m}`);
  };
  const git = (...args: string[]): void => {
    const r = gitSync(args, { cwd: root, env });
    if (r.status !== 0) fail(`git ${args.join(' ')} exited ${r.status}: ${tail(r.stderr || r.stdout || String(r.error ?? ''))}`);
  };
  const forge = async (label: string, argv: string[], want = 0): Promise<string> => {
    const r = await cli(argv, root, env);
    if (r.code !== want) fail(`${label} (forge ${argv.join(' ')}) exited ${r.code}, expected ${want}: ${tail(r.stderr || r.stdout)}`);
    return r.stdout;
  };

  try {
    git('init', '-q', '-b', 'main');
    // SESSION_PINS' reasoning: no host hook or signing agent decides whether a seed works.
    for (const [k, v] of [
      ['user.name', 'Forge scenario'],
      ['user.email', 'scenario@forge.invalid'],
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false'],
      ['core.autocrlf', 'false'],
      ['maintenance.auto', 'false'],
      ['gc.auto', '0'],
      ['core.hooksPath', os.devNull],
    ])
      git('config', k, v);
    fs.writeFileSync(path.join(root, 'README.md'), `# Scenario: ${name}\n\n${scenario.description}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', 'Scenario repo');

    const { project, ...rest } = scenario.config;
    const answers = {
      ...rest,
      project: { name: `Scenario: ${name}`, ...(isObject(project) ? project : {}) },
      tracker: { kind: 'none' },
      daemon: { enabled: false },
      foreman: { enabled: false },
      worktrees: { root: '../{repo}.worktrees', setup: [] },
    };
    const answersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-scenario-answers-'));
    try {
      const file = path.join(answersDir, 'answers.json');
      fs.writeFileSync(file, JSON.stringify(answers));
      await forge('init', ['init', 'write', '--answers', file]);
    } finally {
      fs.rmSync(answersDir, { recursive: true, force: true });
    }
    // Verify reads the base branch's committed config.
    git('add', '-A');
    git('commit', '-q', '-m', 'Forge config');

    const ids: Record<string, string> = {};
    const fill = (arg: string, own: string | null): string => arg.replace(/\{id(?::([^}]*))?\}/g, (_, k: string | undefined) => ids[k ?? own!]);
    for (const job of scenario.jobs) {
      const out = await forge(`${job.key} new`, ['job', 'new', '--title', job.title, '--slug', job.key, ...job.new.map((a) => fill(a, null))]);
      let id: unknown;
      try {
        id = JSON.parse(out).id;
      } catch {}
      if (typeof id !== 'string' || !SCENARIO_NAME.test(id)) fail(`${job.key} new printed no job id: ${tail(out)}`);
      ids[job.key] = id as string;
    }
    for (const job of scenario.jobs) {
      const dir = jobDir(root, ids[job.key]);
      for (const [rel, text] of Object.entries(job.files)) {
        const file = path.join(dir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      }
    }
    for (const job of scenario.jobs) {
      for (const [n, step] of job.steps.entries()) {
        await forge(`${job.key} step ${n + 1}`, step.argv.map((a) => fill(a, job.key)), step.exit);
      }
    }
    const ms = Date.now() - started;
    opts.log?.(`seeded ${name} in ${ms} ms`);
    return { name, root, worktrees, jobs: ids, expect: scenario.expect, ms, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || (args[0].startsWith('-') && args[0] !== '--list')) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  try {
    if (args[0] === '--list') {
      for (const n of listScenarios()) process.stdout.write(`${n}  ${loadScenario(n).description}\n`);
      process.exit(0);
    }
    loadScenario(args[0]);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
  }
  // A signal during the seed exits too; seedScenario's own exit handler removes what it made.
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, () => process.exit(0));
  let seeded: Seeded;
  try {
    seeded = await seedScenario(args[0], { log: (s) => process.stderr.write(`${s}\n`) });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
  process.stdout.write(`${seeded.root}\n`);
  // Wait for a signal; the exit handler removes the scratch repo.
  setInterval(() => {}, 1 << 30);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
