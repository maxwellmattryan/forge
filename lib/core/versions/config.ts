// The config version steps: `.forge/config.yml`'s schemaVersion is this list's length plus one.
// Append only (AGENTS.md here): a new step goes at the end, with a row keyed by its id in
// test/schema.test.ts.
import { servicesToComponents } from '../config/components.ts';
import { versionOf } from './steps.ts';
import type { Step } from './steps.ts';

export const CONFIG_STEPS: readonly Step[] = [
  // v2 replaces the per-request `dashboard.launcher` shell template with the supervised `daemon:`
  // block. A launcher becomes `daemon.command` so its owner sees why validation rejects it, but
  // `enabled` is never set: an upgrade must not turn on an unattended, permission-skipping process.
  { id: 'dashboard-launcher-to-daemon', up: (c) => {
    if (!c.dashboard || typeof c.dashboard !== 'object') return c;
    const { launcher, ...dashboard } = c.dashboard;
    const out = { ...c, dashboard };
    if (typeof launcher === 'string' && launcher.trim() && !c.daemon?.command) out.daemon = { ...(c.daemon ?? {}), command: launcher };
    return out;
  } },
  // v3 lets a `verify` entry be a list of steps that run at the same time. Every v2 list is a valid v3
  // list, so nothing changes; the bump is what lets this and later Forges refuse a config they cannot read.
  { id: 'parallel-verify-steps', up: (c) => c },
  // v4 adds runtime.efforts, runtime.effortByComplexity and a review.panel entry's `effort`, all
  // defaulting to unset, so no v3 config changes; the bump lets older Forges refuse a config whose
  // effort they would ignore.
  { id: 'runtime-efforts', up: (c) => c },
  // v5 adds the foreman block (off by default) and the assistant's model and effort, so no v4 config
  // changes; the bump lets older Forges refuse a config whose foreman policy they would ignore.
  { id: 'foreman-block', up: (c) => c },
  // v6 adds policy.protectedPaths; defaults fill it, so no v5 config changes; the bump lets older
  // Forges refuse a config whose policy they would ignore.
  { id: 'policy-protected-paths', up: (c) => c },
  // v7 adds retention, whose defaults keep everything, so no v6 config changes; the bump lets older
  // Forges refuse a config whose retention policy they would ignore.
  { id: 'retention', up: (c) => c },
  // v8 adds notify, empty by default, so no v7 config changes; the bump lets older Forges refuse a
  // config whose notifications they would ignore.
  { id: 'notify', up: (c) => c },
  // v9 adds the repo-wide budget block, unlimited by default, so no v8 config changes; the bump lets
  // older Forges refuse a config whose spend caps they would ignore.
  { id: 'repo-budget', up: (c) => c },
  // v10 replaces `services` with `components`, which add a kind and dependencies. A service was a
  // part with its own commands, so each becomes a `service` component with no dependencies; its
  // name, path and commands are unchanged, so `forge run` and `forge verify` pick the same command.
  { id: 'services-to-components', up: servicesToComponents },
  // v11 adds member repos, empty by default, so a v10 config gains `repos: []` (an existing value is
  // kept for validation to judge); the bump lets older Forges refuse a config whose member repos they
  // would ignore. A v10 config may still carry `services`, which migrateConfig folded while 10 was
  // current, so fold it here first.
  { id: 'member-repos', up: (c) => {
    const f = servicesToComponents(c);
    return f && typeof f === 'object' && 'repos' in f ? f : { ...f, repos: [] };
  } },
  // v12 adds dependsOn links, absent by default, so no v11 config changes; the bump lets older Forges
  // refuse a config whose links they would ignore.
  { id: 'depends-on-links', up: (c) => c },
  // v13 adds release.interim and link.manifest, absent by default, so no v12 config changes; the bump
  // lets older Forges refuse a config whose interim strategy they would ignore.
  { id: 'release-interim', up: (c) => c },
  // v14 adds downstream verification, on by default, so a v13 config gains the default `downstream`
  // map (an existing value is kept for validation to judge); the bump lets older Forges refuse a
  // config whose downstream settings they would ignore.
  { id: 'downstream-verification', up: (c) => (c && typeof c === 'object' && 'downstream' in c ? c : { ...c, downstream: { enabled: true, max: 5, skip: [] } }) },
  // v15 adds checkout, empty by default, so no v14 config changes; the bump lets older Forges
  // refuse a config whose checkout steps they would ignore.
  { id: 'checkout', up: (c) => c },
  // v16 adds the release strategy keys, unset by default, so no v15 config changes; the bump lets
  // older Forges refuse a config whose release strategy they would ignore.
  { id: 'release-strategy', up: (c) => c },
  // v17 adds release.publish (whether forge release run asks before a publish step), unset by
  // default, so no v16 config changes; the bump lets older Forges refuse a config whose publish
  // policy they would ignore.
  { id: 'release-publish', up: (c) => c },
  // v18 adds the `release` gate class and `gate:<class>` entries in foreman.reserved, with
  // `gate:release` in the default list. deepMerge replaces arrays, so a config that wrote out its own
  // `reserved` would never get the new default: append it there. A v17 `decides` can't name
  // `release` (it was invalid), so this never takes a delegation away, and the bump lets older
  // Forges refuse a config whose `decides` names a class they would ignore.
  { id: 'reserved-gate-release', up: (c) => {
    const r = c?.foreman?.reserved;
    if (!Array.isArray(r) || r.includes('gate:release')) return c;
    return { ...c, foreman: { ...c.foreman, reserved: [...r, 'gate:release'] } };
  } },
  // v19 adds backing, empty by default, so no v18 config changes; the bump lets older Forges refuse
  // a config whose backing services they would ignore.
  { id: 'backing', up: (c) => c },
  // v20 adds components[].config (config sinks), absent by default, so no v19 config changes; the
  // bump lets older Forges refuse a config whose sinks they would ignore.
  { id: 'config-sinks', up: (c) => c },
  // v21 adds runtime.modelByComplexity, runtime.reworkModel, review.onRework and a panel entry's
  // `pathsOnly`; defaults fill them, so no v20 config changes. onRework defaults to `narrow`, so an
  // upgraded repo's rework rounds re-run only the rework panel, while round 1 is unchanged. The bump
  // lets older Forges refuse a config whose builder models and rework panel they would ignore.
  { id: 'builder-models-and-rework-panel', up: (c) => c },
  // v22 adds a shared backing entry's `database` (a job database cloned from a template database),
  // absent by default, so no v21 config changes; the bump lets older Forges refuse a config whose
  // job databases they would ignore.
  { id: 'backing-database', up: (c) => c },
  // v23 adds `secrets` (named secret references for config sinks), `{}` by default, so no v22 config
  // changes; the bump lets older Forges refuse a config whose {secret.NAME} references they would
  // reject at render or, worse, leave unredacted.
  { id: 'secrets', up: (c) => c },
  // v24 adds outcomes.windowDays (14 by default), so no v23 config changes; the bump lets older
  // Forges refuse a config whose outcome window they would ignore.
  { id: 'outcomes-window', up: (c) => c },
  // v25 adds environments.maxRunning, null by default, so no v24 config changes; the bump lets older
  // Forges refuse a config whose cap they would ignore.
  { id: 'environments-max-running', up: (c) => c },
  // v26 adds scoring (sample 0 and model null by default, so off), so no v25 config changes; the
  // bump lets older Forges refuse a config whose score sampling they would ignore.
  { id: 'scoring', up: (c) => c },
  // v27 adds pipeline.maxTotalRounds (null), pr.maxCiReworks (3) and daemon.jobBudget, all filled
  // from defaults, so no v26 config changes; the bump lets older Forges refuse a config whose loop
  // bounds they would ignore.
  { id: 'loop-bounds', up: (c) => c },
  // v28 adds daemon.turnTimeoutMinutes (60), filled from defaults, so no v27 config changes; the
  // bump lets older Forges refuse a config whose turn limit they would ignore.
  { id: 'daemon-turn-timeout', up: (c) => c },
  // v29 adds improve.experiments (minJobs 5, maxJobs 10) and evals.recall.paths, filled from
  // defaults, so no v28 config changes; the bump lets older Forges refuse a config whose experiment
  // thresholds and recall gate they would ignore.
  { id: 'experiments-and-recall', up: (c) => c },
  // v30 adds worktrees.seed (off while its paths are empty), filled from defaults, so no v29 config
  // changes; the bump lets older Forges refuse a config whose seed they would ignore.
  { id: 'worktree-seed', up: (c) => c },
  // v31 turns a `project.instructions` list into `{ default: <list> }`, the per-role map's form; a
  // config without the key, or with a map, is unchanged. The bump lets older Forges refuse a config
  // whose role map they would misread as a list.
  { id: 'instructions-per-role', up: (c) => (Array.isArray(c?.project?.instructions) ? { ...c, project: { ...c.project, instructions: { default: [...c.project.instructions] } } } : c) },
  // v32 adds commandEnv (inherit [] and loginShell false), filled from defaults, so no v31 config
  // changes and upgraded repos get the strict command environment too; the bump lets older Forges
  // refuse a config whose inherit list they would ignore.
  { id: 'command-env', up: (c) => c },
  // v33 adds daemon.dailyUsd ({ inbox: 25, office: 60 }), filled from defaults, so no v32 config changes
  // and upgraded repos get the caps too; the bump lets older Forges refuse a config whose daily caps they
  // would ignore.
  { id: 'daemon-daily-usd', up: (c) => c },
  // v34 adds merge.requiredChecks ([]), filled from defaults, so no v33 config changes; the bump lets
  // older Forges refuse a config whose required checks they would ignore and merge without.
  { id: 'merge-required-checks', up: (c) => c },
  // v35 adds the Office's foreman keys (model, effort, cadence, assistants, surveyors, mandate), filled
  // from defaults, and moves the assistant's model and effort under foreman.assistants as written: an
  // existing foreman.assistants value wins, and the old runtime keys are deleted. A config with neither
  // old key, or whose foreman (or foreman.assistants) isn't a map, is unchanged.
  { id: 'foreman-office', up: foremanOffice },
  // v36 adds daemon.keepAwake (auto) and the service-restarted notify event, filled from defaults, so
  // no v35 config changes; the bump lets older Forges refuse a webhook subscribed to an event they lack.
  { id: 'office-uptime', up: (c) => c },
  // v37 adds the mandate-stalled, mandate-budget and mandate-closed notify events, so no v36 config
  // changes; the bump lets older Forges refuse a webhook subscribed to an event they lack.
  { id: 'mandate-notify', up: (c) => c },
  // v38 adds daemon.dailyUsd.chat (25), filled from defaults, so no v37 config changes; the bump lets older
  // Forges refuse a config whose chat cap they would reject as an unknown key.
  { id: 'daemon-daily-usd-chat', up: (c) => c },
  // v39 adds the script release mechanism and release.script (null), filled from defaults, so no v38 config
  // changes; the bump lets older Forges refuse a config whose mechanism they would reject or never run.
  { id: 'release-script', up: (c) => c },
  // v40: forge dash's gate runner replaces the assistant foreman sessions, so foreman.assistants.sessions (how many
  // sessions) becomes foreman.assistants.parallel (how many gate runs at once), unless parallel is already written.
  { id: 'foreman-gate-runs', up: foremanGateRuns },
];

const isPlainMap = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);

function foremanOffice(c: any): any {
  const models = c?.runtime?.models;
  const efforts = c?.runtime?.efforts;
  const model = isPlainMap(models) ? models.assistant : undefined;
  const effort = isPlainMap(efforts) ? efforts.assistant : undefined;
  if (model === undefined && effort === undefined) return c;
  // Left as written for validation to report: there is no map to move the values into.
  if (c.foreman !== undefined && !isPlainMap(c.foreman)) return c;
  if (c.foreman?.assistants !== undefined && !isPlainMap(c.foreman.assistants)) return c;
  const assistants = c.foreman?.assistants ?? {};
  const moved: Record<string, unknown> = {};
  if (model !== undefined) moved.model = model;
  if (effort !== undefined) moved.effort = effort;
  const runtime = { ...c.runtime };
  if (model !== undefined) {
    const { assistant: _m, ...rest } = models;
    runtime.models = rest;
  }
  if (effort !== undefined) {
    const { assistant: _e, ...rest } = efforts;
    runtime.efforts = rest;
  }
  return { ...c, runtime, foreman: { ...(c.foreman ?? {}), assistants: { ...moved, ...assistants } } };
}

/** foreman.assistants.sessions → parallel, a written parallel winning; a foreman or assistants that is not a map is left for validation. */
function foremanGateRuns(c: any): any {
  if (!isPlainMap(c?.foreman) || !isPlainMap(c.foreman.assistants) || !Object.hasOwn(c.foreman.assistants, 'sessions')) return c;
  const { sessions, ...rest } = c.foreman.assistants;
  const assistants = Object.hasOwn(rest, 'parallel') ? rest : { ...rest, parallel: sessions };
  return { ...c, foreman: { ...c.foreman, assistants } };
}

export const CONFIG_SCHEMA_VERSION = versionOf(CONFIG_STEPS);
