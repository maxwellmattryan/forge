// The shape of `forge job step`'s rule tables (lib/step/): lib/step.ts only re-exports, step walks
// TABLES and their rows in list order, each transition has one ID, and the order is pinned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as stepModule from '#engine/pipeline/step.ts';
import { RULES, TABLES, step } from '#engine/pipeline/step.ts';
import { computeFacts } from '#engine/pipeline/step/facts.ts';
import { PP1, PP1b } from '#engine/pipeline/step/gates.ts';
import { M1, M2, N1, N1b, N2, NP1, NP1b, X1 } from '#engine/pipeline/step/generic.ts';
import { firstMatch, flatRows } from '#engine/pipeline/step/rules.ts';
import type { Ctx, Row, Rule } from '#engine/pipeline/step/rules.ts';
import type { StepInput } from '#engine/pipeline/types.ts';
import { fixture } from './step-fixture.ts';
import { rows } from './step-rows.ts';

const LIB = path.resolve(import.meta.dirname, '..', 'lib', 'engine', 'pipeline');

/** Changing precedence means editing this list: every table's IDs in evaluation order, shared rows where they run. */
const PINNED: Record<string, string[]> = {
  global: ['JS2', 'JS1', 'JS3', 'G1', 'G2', 'GA1', 'GA2', 'GA2b', 'GA3', 'GA4', 'GA5', 'GA6', 'GA6b', 'GA7', 'GA8', 'GA9', 'GA10', 'GA11', 'G3', 'G3b', 'G3c', 'G4', 'G4b', 'E1', 'G5', 'L1'],
  kind: ['K1', 'K2'],
  secrets: ['SC2', 'SC1', 'SC1b', 'SC3', 'SC3b'],
  protected: ['PP2', 'PP2b', 'PP1'],
  proposals: ['RP1', 'RP2'],
  downstream: ['DS1'],
  backlog: ['I1', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8'],
  plan: ['P1', 'NP1', 'NP1b', 'N1', 'N1b', 'N2', 'M1', 'M2', 'P2', 'P2b', 'P3', 'P4', 'P5'],
  spec: ['SP1', 'SP2', 'NP1', 'NP1b', 'N1', 'N1b', 'N2', 'M1', 'M2', 'SP8', 'SP3', 'SP4', 'SP5', 'SP7', 'SP6'],
  design: ['D1', 'M1', 'M2', 'D2', 'NP1', 'NP1b', 'N1', 'N1b', 'N2', 'M1', 'M2', 'D3'],
  build: ['B1', 'B6', 'B7', 'B6b', 'B2', 'NP1', 'NP1b', 'N1', 'N1b', 'N2', 'B3', 'B8', 'B4', 'B5'],
  verify: ['V1', 'VF1', 'VF2', 'VF2b', 'VF3', 'V2', 'V2b', 'V3', 'V3b'],
  review: ['RV11', 'RV9', 'RV1', 'RV2', 'RV3', 'RV10', 'RV4', 'M1', 'M2', 'M1', 'M2', 'RV5', 'RV5b', 'RV6', 'RV7', 'RV8', 'RV8b', 'RV8c', 'RV8d'],
  decide: ['DC11', 'DC10', 'RC1', 'DC13', 'DC1', 'M1', 'M2', 'DC2', 'DC4', 'DC5', 'DC6', 'DC3', 'DC9', 'DC9b'],
  integrate: ['IG1', 'IG2', 'IG2b', 'IG3', 'IG4', 'IG5', 'IG6', 'NP1', 'NP1b', 'N1', 'N1b', 'N2', 'IG7', 'IG7b', 'IG11', 'IG8', 'M1', 'M2', 'IG12', 'IG13', 'IG9', 'IG10', 'IG10b', 'IG10c'],
  pr: ['PR12', 'PR1', 'PR9', 'PR9b', 'PR9c', 'PR2', 'PR11', 'PR2b', 'PR13', 'PR3', 'PR6', 'PR7', 'PR8', 'PR10', 'PR14', 'PR15', 'PR16', 'PP1b', 'PR17', 'PR18', 'PR4', 'PR5'],
  fallback: ['X1'],
};

test('lib/step.ts only re-exports', () => {
  const src = fs.readFileSync(path.join(LIB, 'step.ts'), 'utf8');
  const code = src
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
  const statements = code.split(';').map((s) => s.trim()).filter(Boolean);
  const names = new Set<string>();
  for (const s of statements) {
    const m = /^export (?:type )?\{([^}]+)\} from '\.\/step\/[a-z/]+\.ts'$/.exec(s);
    assert.ok(m, `not a re-export: ${s}`);
    for (const n of m[1].split(',')) names.add(n.trim());
  }
  const values = ['RULES', 'PLAN_AUTO_CHARS', 'PLAN_AUTO_LINES', 'shellLine', 'listLineCount', 'loadStepInput', 'loadIntegrationTouched', 'parsePlan', 'parseSpecHeader', 'hasSpecDeltas', 'roundLenses', 'currentRerun', 'reworkPanel', 'whenTokens', 'choosePanel', 'selectPanel', 'reworkReviewFiles', 'gateTell', 'step', 'integrationReviewSkippable'];
  for (const n of [...values, 'RuleId', 'PanelChoice', 'PanelMember']) assert.ok(names.has(n), `lib/step.ts no longer exports ${n}`);
  for (const n of values) assert.notEqual((stepModule as Record<string, unknown>)[n], undefined, n);
});

test('tables evaluate in list order', async () => {
  // firstMatch: the first row whose `when` holds, even when later rows hold too.
  const c = fixture() as unknown as StepInput;
  const base: Ctx = { x: c, f: computeFacts(c) };
  const row = (id: Rule['id'], holds: boolean): Rule => ({ id, when: () => holds, then: () => ({ action: 'done', rule: id, id: 'j', state: 'running' }) });
  assert.equal(firstMatch([row('G1', false), row('G2', true), row('G4', true)], base)?.rule, 'G2');
  assert.equal(firstMatch([row('G1', false)], base), null);
  assert.equal(firstMatch([{ role: () => null, rows: [N2] }, row('G4', true)], base)?.rule, 'G4', 'a null role skips its shared rows');

  // step walks TABLES in order: an independent walk of every fixture lands on the rule step returns.
  const walk = (x: StepInput): string => {
    const b: Ctx = { x, f: computeFacts(x) };
    for (const t of TABLES) {
      if (!t.applies(b)) continue;
      const ctx = t.context ? t.context(b) : b;
      for (const r of t.rules as Row<any>[]) {
        if ('rows' in r) {
          const role = r.role(ctx);
          if (role === null) continue;
          const hit = r.rows.find((s) => s.when({ x, f: b.f, role, retryLine: r.retryLine?.(ctx) }));
          if (hit) return hit.id;
        } else if (r.when(ctx)) return r.id;
      }
    }
    return 'none';
  };
  for (const r of rows) {
    const x = fixture(r.fx);
    assert.equal(walk(x), step(x).rule, r.name);
  }
  assert.deepEqual(TABLES.map((t) => t.name), Object.keys(PINNED));

  // Each stage module exports its table, and it is one step walks.
  const stages = fs.readdirSync(path.join(LIB, 'step', 'stages')).filter((f) => f.endsWith('.ts'));
  assert.equal(stages.length, 10, stages.join(', '));
  await Promise.all(
    stages.map(async (f) => {
      const mod = await import(path.join(LIB, 'step', 'stages', f));
      const tables = Object.values(mod).filter((v: any) => v && typeof v === 'object' && Array.isArray(v.rules));
      assert.equal(tables.length, 1, f);
      assert.ok(TABLES.includes(tables[0] as any), `${f}: its table is not in TABLES`);
    }),
  );
});

test('each transition has one ID', () => {
  const objects = new Map<string, Set<Rule<any>>>();
  const positions = new Map<string, number>();
  for (const t of TABLES)
    for (const r of flatRows(t.rules)) {
      if (!objects.has(r.id)) objects.set(r.id, new Set());
      objects.get(r.id)!.add(r);
      positions.set(r.id, (positions.get(r.id) ?? 0) + 1);
    }
  for (const id of RULES) assert.equal(objects.get(id)?.size, 1, `${id}: ${objects.get(id)?.size ?? 0} rows`);
  for (const id of objects.keys()) assert.ok((RULES as readonly string[]).includes(id), `${id} is not in RULES`);
  assert.equal(new Set(RULES).size, RULES.length, 'RULES has a duplicate');
  // The shared rows are single objects, placed wherever they run.
  const shared = { NP1, NP1b, N1, N1b, N2, M1, M2, PP1, PP1b, X1 };
  for (const [id, r] of Object.entries(shared)) assert.ok(objects.get(id)!.has(r as Rule<any>), id);
  for (const id of ['NP1', 'NP1b', 'N1', 'N1b', 'N2', 'M1', 'M2']) assert.ok(positions.get(id)! > 1, `${id} runs in one place only`);
});

test('table order is pinned', () => {
  for (const t of TABLES) assert.deepEqual(flatRows(t.rules).map((r) => r.id), PINNED[t.name], t.name);
});
