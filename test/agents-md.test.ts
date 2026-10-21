// AGENTS.md opens with a short Essentials section every agent reads, and the rest stays as
// reference: no rule may be dropped to make it short. Also this repo's own effort defaults.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, validateConfig } from '../lib/config.ts';
import * as yaml from '../lib/yaml.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const AGENTS = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');

// Every `- **<lead>**` bullet under `## Rules` and `## Gotchas already paid for` before the
// Essentials section existed, copied as literals so a later edit can't shrink the list with the file.
const RULE_LEADS = [
  '**Zero runtime dependencies.**',
  "**`dashboard/style.css` is the source of truth for the dashboard's look**",
  '**Never commit the built dashboard.**',
  '**The CLI is the only writer of state.**',
  '**Version every shape change.**',
  "**Keep the orchestrator's context small.**",
  '**Prompts are product.**',
  '**Never add AI attribution**',
  '**Preserve the security posture**',
  "**Use the glossary's words.**",
  "**All TS (engine and dashboard) runs through Node's type stripping, which ignores tsconfig:**",
  '**Fast tests:**',
  '**Start-up cache:**',
  '**Typecheck caches:**',
  '**Engine TS:**',
  '**Claude Code transcripts**',
  '**Plugin runtime**',
  '**CLI output**',
  '**`--field` values**',
  '**Issue refs**',
  '**Worktrees live outside the repo**',
];

// The dashboard-only gotchas moved to dashboard/AGENTS.md, which the root's Essentials points to.
const DASHBOARD = fs.readFileSync(path.join(ROOT, 'dashboard', 'AGENTS.md'), 'utf8');
const DASHBOARD_LEADS = [
  '**Tailwind v4**',
  '**Dashboard text comes from `dashboard/src/messages/en.json`.**',
  '**Text never sits on the grain.**',
  '**Escape everything the dashboard renders.**',
  "**Tests can't import `.svelte` or `.svelte.ts`**",
];

/** The text of `## <name>` up to the next `## ` heading. */
function section(text: string, name: string): string {
  const start = text.indexOf(`\n## ${name}\n`);
  assert.ok(start >= 0, `AGENTS.md has ## ${name}`);
  const body = text.slice(start + 1);
  const next = body.indexOf('\n## ', 1);
  return next < 0 ? body : body.slice(0, next + 1);
}

test('AGENTS.md opens with essentials and keeps every rule', () => {
  const first = /^## .*$/m.exec(AGENTS);
  assert.equal(first?.[0], '## Essentials', 'the first ## heading is Essentials');
  const essentials = section(AGENTS, 'Essentials');
  assert.ok(Buffer.byteLength(essentials) <= 3500, `Essentials is ${Buffer.byteLength(essentials)} bytes`);
  for (const phrase of [
    'Zero runtime dependencies',
    'The CLI is the only writer of state',
    'Version every shape change',
    'only one in-flight change may bump each constant',
    'Never add AI attribution',
    'never adopt fork PRs',
    'loopback Hosts only',
    'POSTs need the token, a matching Origin and JSON',
    'tracker and PR text is fenced as data',
    'Work on `develop`',
    'Never commit `dashboard/dist/`',
    'CI builds it for the main update',
    'Escape everything the dashboard renders',
    "Never point the CLI at a real repo's `.forge/`",
    'Jobs leave `CHANGELOG.md` and versions alone',
    "Use the glossary's words",
    'Keep docs in sync with CLI behaviour',
    'Run the verify list before claiming it works',
  ])
    assert.ok(essentials.includes(phrase), `Essentials states: ${phrase}`);
  assert.ok(AGENTS.includes('The rest of this file is reference: read a section when your change touches it.'));
  const rest = section(AGENTS, 'Rules') + section(AGENTS, 'Gotchas already paid for');
  for (const lead of RULE_LEADS) assert.ok(rest.includes(`- ${lead}`), `still in Rules or Gotchas: ${lead}`);
  assert.ok(essentials.includes('](dashboard/AGENTS.md)'), 'Essentials points to dashboard/AGENTS.md');
  for (const lead of DASHBOARD_LEADS) assert.ok(DASHBOARD.includes(`- ${lead}`), `in dashboard/AGENTS.md: ${lead}`);
  for (const name of ['Layout', 'Where a change goes', 'Rules', 'Verify before claiming it works', 'Gotchas already paid for', 'Publishing']) section(AGENTS, name);
  // CI, not a person, builds dist for main: the Layout names the workflow and the scripts that release it.
  const layout = section(AGENTS, 'Layout');
  assert.match(layout, /^- `\.github\/workflows\/main-update\.yml`: /m);
  assert.ok(layout.includes('`main-update.ts`'), 'Layout names scripts/main-update.ts');
  assert.ok(layout.includes('`release.ts` is `npm run release`'), 'Layout names scripts/release.ts');
  for (const doc of [AGENTS, DASHBOARD]) assert.ok(!doc.includes('git add --force dashboard/dist'), 'no hand-built release dist');
});

// `.forge/config.yml` is a refuse default of policy.protectedPaths, so a job can't commit it: the
// block lives in docs/IMPROVEMENT.md, a human applies it on the base branch, and this test holds
// the block valid over the repo's config and, once applied, the config equal to it.
const EFFORT_BLOCK: any = { efforts: { planner: 'medium', approver: 'medium', integrator: 'low' }, effortByComplexity: { low: 'low' } };

test('repo config sets the effort defaults and leaves the panel alone', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'IMPROVEMENT.md'), 'utf8');
  const fence = /pins the gatekeepers[^\n]*\n\n```yaml\n([\s\S]*?)```/.exec(doc);
  assert.ok(fence, 'docs/IMPROVEMENT.md holds the effort defaults block');
  const block = yaml.parse(fence[1]);
  assert.deepEqual(block, EFFORT_BLOCK);
  const file = path.join(ROOT, '.forge', 'config.yml');
  const raw = yaml.parse(fs.readFileSync(file, 'utf8')) as any;
  const { config } = loadConfig(ROOT);
  // Partial maps merge over the null defaults, exactly as loadConfig merges the file.
  config.runtime.efforts = { ...config.runtime.efforts, ...block.efforts };
  config.runtime.effortByComplexity = { ...config.runtime.effortByComplexity, ...block.effortByComplexity };
  assert.deepEqual(validateConfig(config, ROOT), [], 'forge config validate passes with the block applied');
  assert.equal(config.runtime.effortByComplexity.high, null, 'a partial map leaves the other levels null');
  if (raw.runtime.efforts !== undefined || raw.runtime.effortByComplexity !== undefined) {
    assert.deepEqual(raw.runtime.efforts, EFFORT_BLOCK.efforts, 'the applied block matches the docs');
    assert.deepEqual(raw.runtime.effortByComplexity, EFFORT_BLOCK.effortByComplexity, 'the applied block matches the docs');
  }
  assert.equal('review' in block, false, 'the block never touches the review panel');
  // The effort defaults never pin a lens: the panel keeps its four lenses, none with an effort of
  // its own, and no lens is pathsOnly (a later job that changes the panel updates this line).
  assert.deepEqual(raw.review.panel.map((p: any) => [p.name, p.effort ?? null, p.pathsOnly ?? null]), [['code', null, null], ['security', null, null], ['docs', null, null], ['design', null, null]]);
});
