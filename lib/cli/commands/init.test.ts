// `initWrite` in-process on scratch repos: the file holds schemaVersion and only the keys that differ
// from the defaults, plus the keys the existing file already sets, and always loads back to the
// config it validated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoTemplate } from '../../../test/helpers.ts';
import { defaults, loadConfig, stringifyConfig, validateConfig } from '#core/config/load.ts';
import { setConfigValue } from '#core/config/set.ts';
import { deepMerge } from '#core/shape.ts';
import * as yaml from '#core/format/yaml.ts';
import { initWrite, RELEASE_GATE_RULE } from './init.ts';

const repo = repoTemplate(() => {});
const HEADER =
  '# Forge configuration. Every key is documented in docs/CONFIG.md of the Forge plugin.\n' +
  '# Re-run `/forge init` to change answers interactively, or edit this file directly.\n';
const SV = defaults().schemaVersion;
const PANEL = defaults().review.panel;
// The protectedPaths list a repo initialised before the release gate holds (test-rewrite B82).
const OLD_RULES = [
  { paths: ['.github/workflows/**'], action: 'escalate', reason: 'CI/CD configuration' },
  { paths: ['.forge/config.yml', '.forge/secrets-allow.txt', '.forge/trackers/**'], action: 'refuse', reason: "Forge's own policy changes only by a human on the base branch" },
];

const isPlainMap = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every non-map value of `obj` as [dotted path, value]. */
function leaves(obj: Record<string, any>, prefix = ''): [string, unknown][] {
  return Object.entries(obj).flatMap(([k, v]) => (isPlainMap(v) ? leaves(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v] as [string, unknown]]));
}

const get = (obj: any, dotted: string) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

interface Row {
  name: string;
  existing?: Record<string, unknown>;
  steps: { answers: any; force?: boolean }[];
  /** The parsed file after the last step. */
  file?: Record<string, unknown>;
  /** What the config deep-merges over the defaults (AC2). */
  effective: Record<string, unknown>;
  check?: (root: string, text: string, texts: string[]) => void;
}

test('init write writes only what differs from the defaults', () => {
  const legacy = deepMerge(defaults(), { commands: { test: 't' } }) as Record<string, any>;
  delete legacy.outcomes;
  const rows: Row[] = [
    {
      name: 'fresh',
      steps: [{ answers: { commands: { test: 'npm test', dist: 'node build.mjs' }, git: { base: 'main' }, review: { panel: PANEL } } }],
      file: { schemaVersion: SV, commands: { test: 'npm test', dist: 'node build.mjs' } },
      effective: { commands: { test: 'npm test', dist: 'node build.mjs' } },
      check: (_root, text) => assert.ok(text.startsWith(HEADER), 'the two-line header comes first'),
    },
    {
      name: 'empty answers',
      steps: [{ answers: {} }],
      file: { schemaVersion: SV },
      effective: {},
      check: (_root, text) => assert.equal(text, `${HEADER}schemaVersion: ${SV}\n`),
    },
    {
      name: 'delta re-run',
      steps: [{ answers: { commands: { test: 't' } } }, { answers: { pipeline: { maxRounds: 5 } } }, { answers: { pipeline: { maxRounds: 5 } } }],
      file: { schemaVersion: SV, commands: { test: 't' }, pipeline: { maxRounds: 5 } },
      effective: { commands: { test: 't' }, pipeline: { maxRounds: 5 } },
      check: (_root, _text, texts) => assert.equal(texts[2], texts[1], 'the same answers again give a byte-identical file'),
    },
    {
      name: 'kept key',
      existing: { schemaVersion: SV, git: { base: 'main' } },
      steps: [{ answers: { commands: { lint: 'l' } } }],
      file: { schemaVersion: SV, git: { base: 'main' }, commands: { lint: 'l' } },
      effective: { git: { base: 'main' }, commands: { lint: 'l' } },
      check: () => assert.equal(defaults().git.base, 'main', 'the kept key is at its default'),
    },
    {
      name: 'legacy',
      existing: legacy,
      steps: [{ answers: { pipeline: { maxRounds: 5 } } }],
      effective: deepMerge(legacy, { pipeline: { maxRounds: 5 } }),
      check: (root) => {
        const file = yaml.parse(fs.readFileSync(path.join(root, '.forge/config.yml'), 'utf8'));
        for (const [dotted, value] of leaves(legacy)) {
          assert.deepEqual(get(file, dotted), dotted === 'pipeline.maxRounds' ? 5 : value, `${dotted} is kept`);
        }
        assert.equal(Object.hasOwn(file, 'outcomes'), false, 'a key added after the file was written is not added');
        assert.deepEqual(validateConfig(loadConfig(root).config, root), []);
      },
    },
    {
      name: '--force',
      existing: { schemaVersion: SV, commands: { test: 't' }, git: { base: 'main' } },
      steps: [{ answers: { commands: { lint: 'l' } }, force: true }],
      file: { schemaVersion: SV, commands: { lint: 'l' } },
      effective: { commands: { lint: 'l' } },
    },
    {
      name: 'default panel',
      steps: [{ answers: { review: { panel: structuredClone(PANEL) } } }],
      file: { schemaVersion: SV },
      effective: {},
    },
    {
      name: 'one-entry panel',
      steps: [{ answers: { review: { panel: [{ name: 'code', always: true }] } } }],
      file: { schemaVersion: SV, review: { panel: [{ name: 'code', always: true }] } },
      effective: { review: { panel: [{ name: 'code', always: true }] } },
    },
    {
      name: 'default panel plus one',
      steps: [{ answers: { review: { panel: [...structuredClone(PANEL), { name: 'docs', when: 'docs/**' }] } } }],
      file: { schemaVersion: SV, review: { panel: [...PANEL, { name: 'docs', when: 'docs/**' }] } },
      effective: { review: { panel: [...PANEL, { name: 'docs', when: 'docs/**' }] } },
    },
    {
      name: 'release gate, fresh',
      steps: [{ answers: { release: { interim: 'git-ref' } } }],
      file: { schemaVersion: SV, release: { interim: 'git-ref' } },
      effective: { release: { interim: 'git-ref' } },
      check: (root) => {
        assert.ok(fs.existsSync(path.join(root, '.forge/ci/release-gate.mjs')));
        assert.ok(fs.existsSync(path.join(root, '.github/workflows/forge-release-gate.yml')));
      },
    },
    {
      name: 'release gate, older protectedPaths',
      existing: { schemaVersion: SV, release: { interim: 'git-ref' }, policy: { protectedPaths: OLD_RULES } },
      steps: [{ answers: {} }, { answers: {} }],
      file: { schemaVersion: SV, release: { interim: 'git-ref' }, policy: { protectedPaths: [...OLD_RULES, RELEASE_GATE_RULE] } },
      effective: { release: { interim: 'git-ref' }, policy: { protectedPaths: [...OLD_RULES, RELEASE_GATE_RULE] } },
    },
  ];
  for (const r of rows) {
    const { dir: root, cleanup } = repo();
    try {
      const file = path.join(root, '.forge/config.yml');
      if (r.existing) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, stringifyConfig(r.existing));
      }
      const texts: string[] = [];
      for (const s of r.steps) {
        initWrite(root, s.answers, s.force ?? false);
        texts.push(fs.readFileSync(file, 'utf8'));
      }
      const text = texts[texts.length - 1];
      if (r.file) assert.deepEqual(yaml.parse(text), r.file, `${r.name}: file content`);
      assert.deepEqual(loadConfig(root).config, deepMerge(defaults(), r.effective), `${r.name}: effective config`);
      r.check?.(root, text, texts);
    } finally {
      cleanup();
    }
  }
});

test('config set inserts a key a delta file lacks', () => {
  const { dir: root, cleanup } = repo();
  try {
    initWrite(root, { commands: { test: 't' } }, false);
    const file = path.join(root, '.forge/config.yml');
    assert.equal(Object.hasOwn(yaml.parse(fs.readFileSync(file, 'utf8')), 'pipeline'), false);
    const res = setConfigValue(root, 'pipeline.maxRounds', 5, () => ({ login: 'test', source: 'env' }));
    assert.equal(res.changed, true);
    assert.equal(yaml.parse(fs.readFileSync(file, 'utf8')).pipeline.maxRounds, 5);
    assert.equal(loadConfig(root).config.pipeline.maxRounds, 5);
  } finally {
    cleanup();
  }
});
