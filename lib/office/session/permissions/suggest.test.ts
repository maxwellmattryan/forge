// promptReport over built entries, in-process: its grouping, ranking and caps, and every reason a rule is not
// suggested, including the bypasses the suggestion filter must refuse (docs/architecture/daemon-security.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PromptEntry, PromptReason } from './history.ts';
import { promptReport } from './suggest.ts';

const JOB = '42-add-login';

test('promptReport groups, ranks and suggests', () => {
  const ROOT = '/work/repo';
  const WT = '/work/repo.wt';
  const base = Date.parse('2026-10-01T00:00:00.000Z');
  let tick = 0;
  /** `n` entries for `rules`, each a minute after the last. */
  const many = (n: number, rules: string[], o: { decision?: PromptEntry['decision']; reason?: PromptReason | null; scope?: string; tool?: string } = {}): PromptEntry[] =>
    Array.from({ length: n }, () => ({
      v: 1,
      at: new Date(base + ++tick * 60_000).toISOString(),
      scope: o.scope ?? JOB,
      tool: o.tool ?? 'Bash',
      rules,
      decision: o.decision ?? 'allow',
      reason: o.reason ?? null,
    }));
  const A = 'Bash(npm test:*)';
  const B = 'Read(src/**)';
  const C = 'Bash(npm run lint:*)';
  const report = (entries: PromptEntry[], o: { min?: number; since?: string | null; allowedTools?: unknown } = {}) =>
    promptReport(entries, { min: o.min ?? 3, since: o.since ?? null, allowedTools: o.allowedTools ?? ['Agent'], roots: { files: [ROOT, WT], commands: [WT] } });
  const skips = (r: ReturnType<typeof report>) => Object.fromEntries(r.groups.map((g) => [g.rule ?? `null:${g.tool}`, g.skip]));

  // The issue's example: allowed 9, 4 and 2 times, none denied.
  const abc = [...many(2, [C]), ...many(9, [A]), ...many(4, [B], { tool: 'Read' })];
  const r = report(abc);
  assert.deepEqual(r.suggest, [A, B]);
  assert.deepEqual(r.groups.map((g) => g.rule), [A, B, C]);
  assert.deepEqual(skips(r), { [A]: null, [B]: null, [C]: 'below-min' });
  assert.deepEqual([r.entries, r.omitted, r.min, r.since], [15, 0, 3, null]);
  assert.deepEqual(r.groups[1], {
    rule: B,
    tool: 'Read',
    asked: 4,
    allowed: 4,
    denied: 0,
    deniedBy: { human: 0, timeout: 0, unasked: 0 },
    deniedEarlier: 0,
    jobs: [JOB],
    lastSeen: abc.at(-1)!.at,
    listed: false,
    skip: null,
  });

  type Row = { name: string; entries: PromptEntry[]; opts?: Parameters<typeof report>[1]; skips: Record<string, string | null>; suggest: string[]; check?: (r: ReturnType<typeof report>) => void };
  const rows: Row[] = [
    {
      name: "a prompt with no rule counts in its tool's null group",
      entries: [...many(4, [], { tool: 'WebSearch' }), ...many(1, [], { tool: 'Bash' })],
      skips: { 'null:WebSearch': 'no-rule', 'null:Bash': 'no-rule' },
      suggest: [],
    },
    {
      name: 'one entry counts once in each of its rules',
      entries: many(3, [A, C]),
      skips: { [C]: null, [A]: null },
      suggest: [C, A],
      check: (r) => assert.deepEqual(r.groups.map((g) => [g.rule, g.asked]), [[C, 3], [A, 3]], 'equal asked and lastSeen: by rule'),
    },
    ...(['human', 'timeout', 'too-many', 'unserialisable-input', 'too-large', 'unusable-tool-name'] as PromptReason[]).map((reason) => ({
      name: `a rule denied once (${reason}) is never suggested`,
      entries: [...many(5, [A]), ...many(1, [A], { decision: 'deny', reason }), ...many(5, [A], { decision: 'session' })],
      skips: { [A]: 'denied' },
      suggest: [],
      check: (r: ReturnType<typeof report>) => {
        const g = r.groups[0];
        assert.deepEqual([g.asked, g.allowed, g.denied], [11, 10, 1]);
        const key = reason === 'human' || reason === 'timeout' ? reason : 'unasked';
        assert.deepEqual(g.deniedBy, { human: 0, timeout: 0, unasked: 0, [key]: 1 });
      },
    })),
    ...['Bash(git log:*)', 'Bash(gh api:*)', 'Edit(src/**)', 'mcp__x__y(z)', 'Bash(echo a,b:*)'].map((rule) => ({
      name: `an entry daemon.allowedTools refuses: ${rule}`,
      entries: many(5, [rule]),
      skips: { [rule]: 'invalid' },
      suggest: [],
    })),
    // A shell, an interpreter, an exec wrapper, a package runner, a fetcher or a file writer is as wide as an unscoped
    // Bash whatever follows it, and the validation above doesn't refuse any of them.
    ...[
      'Bash(python3:*)',
      'Bash(node:*)',
      'Bash(sh -c:*)',
      'Bash(bash:*)',
      'Bash(env:*)',
      'Bash(xargs:*)',
      'Bash(find:*)',
      'Bash(npx:*)',
      'Bash(npm exec:*)',
      'Bash(pnpm dlx:*)',
      'Bash(curl:*)',
      'Bash(cp:*)',
      'Bash(rm:*)',
      'Bash(chmod +x .git/hooks/pre-commit)',
      'Bash(FOO=1 python3.12 x.py:*)',
      'Bash(cd docs && node build.js:*)',
      'Bash(true | sh:*)',
      'Bash("py"thon3:*)',
      'Bash(./node_modules/.bin/node:*)',
      'Bash(PYTHON3:*)',
      'Bash(p*:*)',
      `Bash(${WT}/bin/python3:*)`,
    ].map((rule) => ({
      name: `a command that runs or writes anything: ${rule}`,
      entries: many(5, [rule]),
      skips: { [rule]: 'broad' },
      suggest: [],
    })),
    {
      name: 'ordinary commands that only resemble a broad one are not broad',
      entries: ['Bash(npm run build:*)', 'Bash(forge git diff:*)', 'Bash(git commit:*)', 'Bash(make test:*)', 'Bash(node-gyp rebuild:*)', 'Bash(shellcheck a.sh:*)', 'Bash(python-lint:*)', 'Bash(FOO=1 ls:*)'].flatMap((rule) => many(5, [rule])),
      skips: Object.fromEntries(['Bash(npm run build:*)', 'Bash(forge git diff:*)', 'Bash(git commit:*)', 'Bash(make test:*)', 'Bash(node-gyp rebuild:*)', 'Bash(shellcheck a.sh:*)', 'Bash(python-lint:*)', 'Bash(FOO=1 ls:*)'].map((rule) => [rule, null])),
      suggest: ['Bash(FOO=1 ls:*)', 'Bash(forge git diff:*)', 'Bash(git commit:*)', 'Bash(make test:*)', 'Bash(node-gyp rebuild:*)', 'Bash(npm run build:*)', 'Bash(python-lint:*)', 'Bash(shellcheck a.sh:*)'],
    },
    ...[
      'Read(//etc/**)',
      'Bash(cat /etc/passwd:*)',
      'Read(~/.ssh/**)',
      'Bash(cd $HOME:*)',
      'Read(/src/**)',
      'Bash(ls ../other:*)',
      'Bash(echo `id`:*)',
      'Bash(cat \\/etc:*)',
      `Read(//${ROOT.slice(1)}-evil/**)`,
      'Bash(cat -f/etc/passwd:*)',
      'Bash(upload -d @/etc/passwd x:*)',
      'Bash(open file:///etc/passwd:*)',
      'Bash(sync host:/etc/x .:*)',
      'Bash(FOO=/etc/x make:*)',
      // The checkout is a root for a file tool's patterns, not for a command's arguments.
      `Bash(ls ${ROOT}/x:*)`,
      `Bash(${'/ '.repeat(2100)}:*)`,
    ].map((rule) => ({
      name: `a path outside the roots, or one that can't be proven inside: ${rule.slice(0, 60)}`,
      entries: many(5, [rule]),
      skips: { [rule]: 'outside-repo' },
      suggest: [],
    })),
    {
      name: 'paths inside the checkout and the worktrees roots, and no path at all',
      entries: [...many(5, [`Read(/${ROOT}/src/**)`]), ...many(5, [`Bash(ls ${WT}/x:*)`]), ...many(5, [B]), ...many(5, ['WebFetch(domain:example.com)']), ...many(5, ['Bash(gh pr view https://github.com/o/r/pull/1:*)'])],
      skips: { [`Read(/${ROOT}/src/**)`]: null, [`Bash(ls ${WT}/x:*)`]: null, [B]: null, 'WebFetch(domain:example.com)': null, 'Bash(gh pr view https://github.com/o/r/pull/1:*)': null },
      suggest: ['Bash(gh pr view https://github.com/o/r/pull/1:*)', `Bash(ls ${WT}/x:*)`, `Read(/${ROOT}/src/**)`, B, 'WebFetch(domain:example.com)'],
    },
    {
      name: 'a rule already listed exactly',
      entries: [...many(5, [A]), ...many(5, [B])],
      opts: { allowedTools: ['Agent', A, 'Read(src/*)'] },
      skips: { [A]: 'listed', [B]: null },
      suggest: [B],
      check: (r) => assert.deepEqual(r.groups.map((g) => [g.rule, g.listed]), [[B, false], [A, true]]),
    },
    {
      name: 'since drops older entries',
      entries: [...many(5, [A]), ...many(2, [B])],
      // Built after its entries: B's two are the last two ticks.
      opts: { since: new Date(base + (tick - 1) * 60_000).toISOString(), min: 1 },
      skips: { [B]: null },
      suggest: [B],
      check: (r) => assert.equal(r.entries, 2),
    },
    {
      name: 'a deny before since still blocks a rule, though it makes no group of its own',
      entries: [...many(1, [A], { decision: 'deny', reason: 'human' }), ...many(1, [C], { decision: 'deny', reason: 'timeout' }), ...many(4, [A]), ...many(4, [B], { tool: 'Read' })],
      // The last 8 ticks: everything but the two denies.
      opts: { since: new Date(base + (tick - 7) * 60_000).toISOString(), min: 1 },
      skips: { [A]: 'denied', [B]: null },
      suggest: [B],
      check: (r) => {
        assert.equal(r.entries, 8);
        assert.deepEqual(r.groups.map((g) => [g.rule, g.asked, g.denied, g.deniedEarlier]), [[B, 4, 0, 0], [A, 4, 0, 1]], 'asked and denied count the window only; C has no entry in it');
      },
    },
    {
      name: 'jobs are the newest 20 scopes, newest first; ties rank by lastSeen, then rule',
      entries: [...Array.from({ length: 25 }, (_, i) => many(1, [C], { scope: `${i + 1}-job` })).flat(), ...many(25, [B]), ...many(25, [A])],
      opts: { min: 1 },
      skips: { [A]: null, [B]: null, [C]: null },
      suggest: [C, A, B],
      check: (r) => {
        assert.deepEqual(r.groups.map((g) => g.rule), [A, B, C], 'equal asked: the newest first');
        assert.deepEqual(r.groups[2].jobs, Array.from({ length: 20 }, (_, i) => `${25 - i}-job`));
      },
    },
    {
      name: 'past 100 groups the rest are omitted, and suggest still covers them',
      entries: Array.from({ length: 105 }, (_, i) => many(1, [`Bash(task${String(i).padStart(3, '0')}:*)`])).flat(),
      opts: { min: 1 },
      skips: {},
      suggest: Array.from({ length: 105 }, (_, i) => `Bash(task${String(i).padStart(3, '0')}:*)`),
      check: (r) => assert.deepEqual([r.groups.length, r.omitted], [100, 5]),
    },
    {
      name: 'suggest ranks by allowed, then rule',
      entries: [...many(1, [A]), ...many(2, ['Bash(z:*)']), ...many(2, ['Bash(b:*)']), ...many(3, [B])],
      opts: { min: 1 },
      skips: { [B]: null, 'Bash(b:*)': null, 'Bash(z:*)': null, [A]: null },
      suggest: [B, 'Bash(b:*)', 'Bash(z:*)', A],
    },
  ];
  for (const row of rows) {
    const got = report(row.entries, row.opts);
    if (Object.keys(row.skips).length) assert.deepEqual(skips(got), row.skips, row.name);
    assert.deepEqual(got.suggest, row.suggest, row.name);
    row.check?.(got);
  }
});
