// The dashboard's protected-paths summary (dashboard/src/lib/protected.ts): what the card chip, the
// drawer chip and the Needs-you list show.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTECTED_ROWS, protectedSummary, showParkReason } from '../dashboard/src/lib/protected.ts';
import type { ProtectedHit, ProtectedPaths } from '../dashboard/src/lib/types.ts';

const hit = (path: string, rule: number, reason: string): ProtectedHit => ({ path, rule, glob: path, reason, blob: null });
const flag = (hits: ProtectedHit[], more = 0): ProtectedPaths => ({ hits, more, at: '2026-10-01T10:00:00.000Z', gate: 'commit', head: null });

test('protectedSummary', () => {
  assert.equal(protectedSummary({ protectedPaths: null }), null);
  assert.equal(protectedSummary({ protectedPaths: flag([]) }), null, 'no hits: nothing to show');
  assert.equal(protectedSummary({ protectedPaths: { hits: 'x' } as any }), null, 'a malformed flag shows nothing');

  const s = protectedSummary({ protectedPaths: flag([hit('package-lock.json', 4, 'dependency lockfile'), hit('.github/workflows/ci.yml', 1, 'CI/CD configuration'), hit('web/package-lock.json', 4, 'dependency lockfile')]) });
  assert.deepEqual(s, {
    reasons: ['CI/CD configuration', 'dependency lockfile'],
    rows: [
      { path: 'package-lock.json', reason: 'dependency lockfile' },
      { path: '.github/workflows/ci.yml', reason: 'CI/CD configuration' },
      { path: 'web/package-lock.json', reason: 'dependency lockfile' },
    ],
    more: 0,
  });

  const many = protectedSummary({ protectedPaths: flag(Array.from({ length: 13 }, (_, i) => hit(`db/migrations/${i}.sql`, 3, 'database migrations')), 7) })!;
  assert.equal(PROTECTED_ROWS, 10);
  assert.equal(many.rows.length, 10);
  assert.equal(many.more, 3 + 7, 'unlisted hits and the flag’s own more');
  assert.deepEqual(many.reasons, ['database migrations']);

  // Paths are data: returned as they are, for the components to render as escaped text.
  const odd = protectedSummary({ protectedPaths: flag([hit('<img src=x onerror=alert(1)>.yml', 1, 'CI/CD configuration')]) })!;
  assert.equal(odd.rows[0].path, '<img src=x onerror=alert(1)>.yml');
});

test('showParkReason drops a protected park reason the path list repeats', () => {
  const f = flag([hit('package-lock.json', 4, 'dependency lockfile')]);
  assert.equal(showParkReason({ reason: 'protected paths: package-lock.json', protectedPaths: f }), false);
  assert.equal(showParkReason({ reason: 'protected paths: package-lock.json', protectedPaths: null }), true, 'no list: the reason stays');
  assert.equal(showParkReason({ reason: 'escalated: risky change', protectedPaths: f }), true, 'another park keeps its reason');
  assert.equal(showParkReason({ reason: null, protectedPaths: f }), false);
});
