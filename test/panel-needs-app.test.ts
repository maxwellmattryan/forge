import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { defaults, lensNeedsApp, reviewerChecklist, validateConfig } from '../lib/config.ts';
import { PLUGIN_ROOT } from '../lib/paths.ts';

const needsAppProblems = (problems: string[]) => problems.filter((p) => p.includes('needsApp'));

test('needsApp must be a boolean', () => {
  const repo = tempRepo();
  try {
    const cfg = defaults();
    cfg.review.panel.push({ name: 'ui', needsApp: 'yes' as any });
    assert.deepEqual(needsAppProblems(validateConfig(cfg, repo.dir)), ['review.panel "ui".needsApp must be true or false (got "yes")']);

    for (const needsApp of [undefined, true, false]) {
      const ok = defaults();
      ok.review.panel.push(needsApp === undefined ? { name: 'ui' } : { name: 'ui', needsApp });
      assert.deepEqual(needsAppProblems(validateConfig(ok, repo.dir)), [], `needsApp ${needsApp}`);
    }
  } finally {
    repo.cleanup();
  }
});

test('the design lens has a plugin checklist', () => {
  const file = path.join(PLUGIN_ROOT, 'reviewers', 'design.md');
  const text = fs.readFileSync(file, 'utf8');
  for (const heading of ['## Visual', '## Flow and copy', '## Accessibility (WCAG 2.2 AA)']) assert.ok(text.includes(heading), heading);
  assert.match(text, /\*\*Focus:\*\*/);
  assert.match(text, /forge run <job> dev --background/);
  assert.match(text, /`design-<what>\.png`/);
  assert.match(text, /^Severity guide:/m);
  // Repo-neutral: nothing from this repo's own dashboard or design system.
  for (const local of ['dashboard/', 'design/drafting.css', 'en.json']) assert.ok(!text.includes(local), local);

  const repo = tempRepo();
  try {
    assert.equal(fs.existsSync(path.join(repo.dir, '.forge', 'reviewers')), false);
    const cfg = defaults();
    cfg.review.panel.push({ name: 'design' });
    assert.deepEqual(validateConfig(cfg, repo.dir).filter((p) => p.includes('design')), []);
    assert.equal(reviewerChecklist(repo.dir, 'design'), file);
  } finally {
    repo.cleanup();
  }
});

test('lensNeedsApp defaults by name and honours the panel entry', () => {
  const cfg = defaults();
  for (const lens of ['ui', 'ux', 'accessibility', 'design']) assert.equal(lensNeedsApp(cfg, lens), true, `${lens} with no entry`);
  assert.equal(lensNeedsApp(cfg, 'code'), false);
  assert.equal(lensNeedsApp(cfg, 'visual-qa'), false);

  cfg.review.panel.push({ name: 'design' }, { name: 'ui', needsApp: false }, { name: 'visual-qa', needsApp: true });
  assert.equal(lensNeedsApp(cfg, 'design'), true, 'an entry with no key keeps the name default');
  assert.equal(lensNeedsApp(cfg, 'ui'), false);
  assert.equal(lensNeedsApp(cfg, 'visual-qa'), true);
});
