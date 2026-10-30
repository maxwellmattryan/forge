// Two invariants. The deprecated-config-key registry and docs/CONFIG.md "Deprecated keys" agree, and doctor
// warns on a deprecated key. And a config, job or API version bump has its doc lines: CONFIG.md's example
// schemaVersion and Migration note, and versioning.md's history. Kept through the test rewrite
// (docs/test-rewrite/README.md): docs stay in sync with code (docs/TESTING.md › Allowed source-text tests, entry 6).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEPRECATED_CONFIG_KEYS, deprecationChecks } from '#core/config/validators/deprecations.ts';
import type { DeprecatedKey } from '#core/config/validators/deprecations.ts';
import { CONFIG_SCHEMA_VERSION, JOB_SCHEMA_VERSION, API_VERSION } from '#core/job/schema.ts';
import { CONFIG_STEPS } from '#core/versions/config.ts';
import { JOB_STEPS } from '#core/versions/job.ts';
import { API_CHANGES } from '#api/versions.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..');

/** What the registry promises: semver releases, a minor's notice, and a docs entry. */
function registryProblems(registry: readonly DeprecatedKey[], docs: string): string[] {
  const problems: string[] = [];
  const section = /^## Deprecated keys\n([\s\S]*?)(?=^## )/m.exec(docs)?.[1];
  if (section === undefined) return ['docs/CONFIG.md has no "## Deprecated keys" section'];
  const ver = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
  for (const d of registry) {
    const since = ver(d.since);
    const removeIn = ver(d.removeIn);
    if (!since) problems.push(`${d.key}: since ${d.since} is not X.Y.Z`);
    if (!removeIn) problems.push(`${d.key}: removeIn ${d.removeIn} is not X.Y.Z`);
    if (since && removeIn && !(removeIn[0] > since[0] || (removeIn[0] === since[0] && removeIn[1] > since[1]))) problems.push(`${d.key}: removeIn ${d.removeIn} is not at least one minor after ${d.since}`);
    if (!section.includes(`\`${d.key}\``)) problems.push(`${d.key}: not listed in docs/CONFIG.md "Deprecated keys"`);
  }
  if (!registry.length && !section.includes('None today.')) problems.push('an empty registry reads "None today."');
  return problems;
}

test('deprecated config keys', () => {
  assert.deepEqual(
    DEPRECATED_CONFIG_KEYS.map((d) => d.key),
    ['project.description', 'project.kinds', 'project.notes', 'infra.notes', 'usage.track', 'runtime.host'],
    "the registry's keys are these six",
  );
  for (const d of DEPRECATED_CONFIG_KEYS) assert.deepEqual([d.since, d.removeIn, d.replacement], ['0.23.0', '1.0.0', null], d.key);
  const docs = fs.readFileSync(path.join(REPO, 'docs', 'CONFIG.md'), 'utf8');
  assert.deepEqual(registryProblems(DEPRECATED_CONFIG_KEYS, docs), []);

  const old: DeprecatedKey = { key: 'pipeline.oldKnob', since: '0.18.0', removeIn: '0.19.0', replacement: 'pipeline.newKnob', note: '' };
  const gone: DeprecatedKey = { key: 'daemon.legacy', since: '0.18.0', removeIn: '1.0.0', replacement: null, note: 'delete it; the daemon always does this now' };
  const yaml = 'pipeline:\n  oldKnob: true\ndaemon:\n  legacy: false\nreview:\n  blockOn: [blocker]\n';
  assert.deepEqual(deprecationChecks(yaml, [old, gone]), [
    { name: 'deprecated config key pipeline.oldKnob', ok: true, warn: true, detail: 'deprecated in 0.18.0, removed in 0.19.0; use pipeline.newKnob' },
    { name: 'deprecated config key daemon.legacy', ok: true, warn: true, detail: 'deprecated in 0.18.0, removed in 1.0.0; delete it; the daemon always does this now' },
  ]);
  assert.deepEqual(deprecationChecks('pipeline:\n  plan: auto\n', [old, gone]), [], 'absent keys');
  assert.deepEqual(deprecationChecks(yaml, []), [], 'an empty registry');
  assert.deepEqual(deprecationChecks(yaml), [], 'the real registry');
  assert.deepEqual(deprecationChecks('pipeline: [unclosed\n  : :\n\t- x', [old]), [], 'unparsable YAML');
  assert.deepEqual(deprecationChecks('', [old]), [], 'an empty file');

  // The shape check catches each broken entry.
  const listed = '## Deprecated keys\n\n`pipeline.oldKnob`\n\n## Next\n';
  assert.deepEqual(registryProblems([old], listed), []);
  assert.equal(registryProblems([{ ...old, since: '0.18' }], listed).length, 1);
  assert.equal(registryProblems([{ ...old, removeIn: '0.18.5' }], listed).length, 1);
  assert.equal(registryProblems([old], '## Deprecated keys\n\nNone today.\n\n## Next\n').length, 1);
  assert.equal(registryProblems([], '# nothing\n').length, 1);
});

interface Versions { config: number; configStep: string; job: number; jobStep: string; api: number; apiStep: string }

/** The doc lines the current config, job and API versions need, as one fix-it message per missing line. */
function versionDocProblems(v: Versions, configDoc: string, historyDoc: string): string[] {
  const problems: string[] = [];
  const found = /^schemaVersion: (\d+)/m.exec(configDoc)?.[1];
  const fix = `run npm run docs:config, which writes "schemaVersion: ${v.config}" at the top of the generated block`;
  if (found === undefined) problems.push(`docs/CONFIG.md: the example config has no "schemaVersion: <n>" line: ${fix}`);
  else if (Number(found) !== v.config) problems.push(`docs/CONFIG.md: the example config says "schemaVersion: ${found}" but CONFIG_SCHEMA_VERSION is ${v.config}: ${fix}`);
  if (v.config > 1) {
    const note = `**Migration** (config \`schemaVersion\` ${v.config - 1} → ${v.config}`;
    if (!configDoc.includes(note + ')') && !configDoc.includes(note + ',')) {
      problems.push(`docs/CONFIG.md: add "${note}): <what changes on disk, or "nothing changes">; the bump lets older Forges refuse …" for config step '${v.configStep}' (lib/core/versions/config.ts), beside the Migration notes of the section that documents what the step adds`);
    }
  }
  if (!new RegExp(`\\b[Jj]ob schema v${v.job}(?!\\d)`).test(historyDoc)) {
    problems.push(`docs/architecture/versioning.md: name "Job schema v${v.job}" for job step '${v.jobStep}' (lib/core/versions/job.ts): append a paragraph at the end, "Job schema v${v.job} … adds …", or name it in the last paragraph if that one documents the same change`);
  }
  if (!new RegExp(`\\bAPI version ${v.api}(?!\\d)`).test(historyDoc)) {
    problems.push(`docs/architecture/versioning.md: name "API version ${v.api}" for API step '${v.apiStep}' (lib/api/versions.ts): append a paragraph at the end, "API version ${v.api} adds …", or name it in the last paragraph if that one documents the same change`);
  }
  return problems;
}

test('version bumps are documented', () => {
  const real: Versions = {
    config: CONFIG_SCHEMA_VERSION, configStep: CONFIG_STEPS.at(-1)!.id,
    job: JOB_SCHEMA_VERSION, jobStep: JOB_STEPS.at(-1)!.id,
    api: API_VERSION, apiStep: API_CHANGES.at(-1)!.id,
  };
  const configDocReal = fs.readFileSync(path.join(REPO, 'docs', 'CONFIG.md'), 'utf8');
  const historyReal = fs.readFileSync(path.join(REPO, 'docs', 'architecture', 'versioning.md'), 'utf8');
  assert.deepEqual(versionDocProblems(real, configDocReal, historyReal), []);

  const v: Versions = { config: 48, configStep: 'daemon-permission-timeout', job: 23, jobStep: 'context-sessions', api: 73, apiStep: 'context-sessions' };
  const cfg = (example: number, note: string) => `\`\`\`yaml\nschemaVersion: ${example} # …\n\`\`\`\n\n${note}\n`;
  const okNote = '**Migration** (config `schemaVersion` 47 → 48): nothing changes.';
  const okCfg = cfg(48, okNote);
  const okHist = 'Job schema v23 and API version 73 add context sessions.\n';
  const exampleFix = 'run npm run docs:config, which writes "schemaVersion: 48" at the top of the generated block';
  const noteMsg = `docs/CONFIG.md: add "**Migration** (config \`schemaVersion\` 47 → 48): <what changes on disk, or "nothing changes">; the bump lets older Forges refuse …" for config step 'daemon-permission-timeout' (lib/core/versions/config.ts), beside the Migration notes of the section that documents what the step adds`;
  const jobMsg = (n: number) => `docs/architecture/versioning.md: name "Job schema v${n}" for job step 'context-sessions' (lib/core/versions/job.ts): append a paragraph at the end, "Job schema v${n} … adds …", or name it in the last paragraph if that one documents the same change`;
  const apiMsg = (n: number) => `docs/architecture/versioning.md: name "API version ${n}" for API step 'context-sessions' (lib/api/versions.ts): append a paragraph at the end, "API version ${n} adds …", or name it in the last paragraph if that one documents the same change`;
  const rows: { name: string; versions?: Versions; configDoc: string; historyDoc: string; want: string[] }[] = [
    { name: 'passes', configDoc: okCfg, historyDoc: okHist, want: [] },
    { name: 'old example version', configDoc: cfg(47, okNote), historyDoc: okHist, want: [`docs/CONFIG.md: the example config says "schemaVersion: 47" but CONFIG_SCHEMA_VERSION is 48: ${exampleFix}`] },
    { name: 'no example line', configDoc: okNote + '\n', historyDoc: okHist, want: [`docs/CONFIG.md: the example config has no "schemaVersion: <n>" line: ${exampleFix}`] },
    { name: 'no migration note', configDoc: cfg(48, ''), historyDoc: okHist, want: [noteMsg] },
    { name: 'wrong pair', configDoc: cfg(48, '**Migration** (config `schemaVersion` 46 → 47): nothing.'), historyDoc: okHist, want: [noteMsg] },
    { name: 'longer number', configDoc: cfg(48, '**Migration** (config `schemaVersion` 47 → 480): nothing.'), historyDoc: okHist, want: [noteMsg] },
    { name: 'bulleted and combined forms pass', configDoc: cfg(48, '- **Migration** (config `schemaVersion` 47 → 48, job `schemaVersion` 22 → 23): nothing.'), historyDoc: okHist, want: [] },
    { name: 'config v1 needs no note', versions: { ...v, config: 1 }, configDoc: cfg(1, ''), historyDoc: okHist, want: [] },
    { name: 'no job entry', configDoc: okCfg, historyDoc: 'API version 73 adds context sessions.\n', want: [jobMsg(23)] },
    { name: 'no API entry', configDoc: okCfg, historyDoc: 'Job schema v23 adds context sessions.\n', want: [apiMsg(73)] },
    { name: 'digit boundary', versions: { ...v, job: 2, api: 7 }, configDoc: okCfg, historyDoc: 'Job schema v23 and API version 73 add context sessions.\n', want: [jobMsg(2), apiMsg(7)] },
    { name: 'lowercase job passes', configDoc: okCfg, historyDoc: 'Config schema v48, job schema v23 and API version 73 add context sessions.\n', want: [] },
  ];
  for (const r of rows) assert.deepEqual(versionDocProblems(r.versions ?? v, r.configDoc, r.historyDoc), r.want, r.name);
});
