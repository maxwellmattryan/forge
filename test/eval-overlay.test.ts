import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evalScratch, forgeAsync } from './helpers.ts';
import { TRUST_ENV, defaults, loadConfig, resolveEffort, trustDigest } from '#core/config/load.ts';
import { applyOverlay, configForJob, overlayProblems } from '#engine/evals/overlay.ts';
import { configHash } from '#engine/evals/run.ts';
import { createJob, jobDir, loadJob } from '#core/job/store.ts';
import { loadStepInput } from '#engine/pipeline/step.ts';

/** Nothing on disk says a run started: no job dir, no clone, no run file. */
function assertNothingCreated(dir: string, label = '') {
  const list = (p: string) => (fs.existsSync(p) ? fs.readdirSync(p) : []);
  assert.deepEqual(list(path.join(dir, '.forge', 'jobs')), [], label);
  assert.deepEqual(list(path.join(dir, '.forge', 'evals', 'runs')), [], label);
  assert.equal(fs.existsSync(`${dir}.wt`), false, label);
}

const configFile = (dir: string) => path.join(dir, '.forge', 'config.yml');

/** Starts a run in `dir` and returns its record. */
async function start(dir: string, ...args: string[]) {
  const r = await forgeAsync(dir, ['eval', 'start', '--tasks', 't', ...args]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/** Runs the command `forge job step` returns, then steps again: the first spawn of a fresh eval job. */
async function firstSpawn(dir: string, id: string) {
  for (let i = 0; i < 5; i++) {
    const r = await forgeAsync(dir, ['job', 'step', id]);
    assert.equal(r.status, 0, r.stderr);
    const a = JSON.parse(r.stdout);
    if (a.action === 'spawn') return a;
    assert.equal(a.action, 'run', r.stdout);
    const ran = await forgeAsync(dir, a.command);
    assert.equal(ran.status, 0, ran.stderr);
  }
  throw new Error('no spawn');
}

/** Rewrites job.json directly, as a hand edit would; `forge job set` refuses the eval field. */
function tamper(dir: string, id: string, overlay: unknown) {
  const file = path.join(jobDir(dir, id), 'job.json');
  const job = JSON.parse(fs.readFileSync(file, 'utf8'));
  job.eval.overlay = overlay;
  fs.writeFileSync(file, JSON.stringify(job, null, 2));
}

describe('eval overlays', { concurrency: 4 }, () => {
  test('--set accepts the allowlist and refuses everything else', async () => {
    const s = evalScratch();
    try {
      const refused: [string[], RegExp][] = [
        [['commands.test=x'], /"commands\.test" can't be overlaid/],
        [['verifySecrets=warn'], /"verifySecrets" can't be overlaid/],
        [['pipeline.budget={}'], /"pipeline\.budget" can't be overlaid/],
        [['runtime.models.orchestrator=haiku'], /"runtime\.models\.orchestrator" can't be overlaid/],
        [['__proto__.x=1'], /"__proto__\.x" can't be overlaid/],
        [['nokey'], /--set expects key=value, got "nokey"/],
        [['pipeline.maxRounds=0'], /pipeline\.maxRounds must be an integer from 1 to 20/],
        [['runtime.effort=huge'], /runtime\.effort must be one of/],
        [['runtime.models.builder=a;b'], /runtime\.models\.builder must be a model alias or id/],
        [['verify=[nope]'], /verify step "nope" is not a key in commands/],
        [['verify=[]'], /verify overlay needs at least one step/],
        [['verify=test'], /--set verify must be a list/],
        [['review.panel=[{name: code, checklist: x.md}]'], /review\.panel entry 1: "checklist" is not allowed/],
        [['review.panel=[{name: nolens}]'], /review\.panel entry 1: reviewer "nolens" has no checklist/],
        [['review.panel=[{name: ../code}]'], /review\.panel entry 1: name must be a lens name/],
        [['review.panel=[{__proto__: {checklist: x.md}, name: code}]'], /review\.panel entry 1 must be a map/],
        [['review.panel=[]'], /review\.panel overlay needs at least one reviewer/],
        [['review.panel=[{name: code, when: "a‮b"}]'], /review\.panel entry 1: when must not contain control/],
        [['pipeline.maxRounds=5', 'pipeline.maxRounds=6'], /--set pipeline\.maxRounds is given more than once/],
        [[], /missing value for --set/],
      ];
      const results = await Promise.all(refused.map(([sets]) => forgeAsync(s.dir, ['eval', 'start', '--tasks', 't', ...(sets.length ? sets.flatMap((x) => ['--set', x]) : ['--set'])])));
      results.forEach((r, i) => {
        const [sets, re] = refused[i];
        assert.equal(r.status, 1, `${sets.join(' ')}: ${r.stderr}`);
        assert.match(r.stderr, re, sets.join(' '));
      });
      assertNothingCreated(s.dir, 'refusals create nothing');

      const ok = await start(
        s.dir,
        ...['pipeline.maxRounds=5', 'runtime.models.builder=sonnet', 'runtime.effort=low', 'verify=[test]', 'review.panel=[{name: code, always: true}]', 'pipeline.budget.usd=null'].flatMap((x) => ['--set', x]),
      );
      assert.deepEqual(ok.overlay, {
        'pipeline.maxRounds': 5,
        'runtime.models.builder': 'sonnet',
        'runtime.effort': 'low',
        verify: ['test'],
        'review.panel': [{ name: 'code', always: true }],
        'pipeline.budget.usd': null,
      });
      assert.equal(ok.models.builder, 'sonnet');
    } finally {
      s.cleanup();
    }
  });

  test('review.panel overlay accepts paths and refuses bad globs', async () => {
    const s = evalScratch();
    try {
      const config = loadConfig(s.dir).config;
      const panel = (paths: unknown) => ({ 'review.panel': [{ name: 'code', always: true }, { name: 'security', paths }] });
      assert.deepEqual(overlayProblems(s.dir, config, panel(['lib/**', '*.ts'])), []);
      for (const [paths, re] of [
        ['lib/**', /review\.panel entry 2: review\.panel "security"\.paths must be a list/],
        [[''], /review\.panel entry 2: review\.panel "security"\.paths entries must be non-empty strings/],
        [['/etc'], /must be relative to the repo/],
        [['-x'], /must not start with -, ! or :/],
        [['!x'], /must not start with -, ! or :/],
        [[':x'], /must not start with -, ! or :/],
        [['a/../b'], /must not contain a \.\. segment/],
      ] as [unknown, RegExp][]) {
        const [p] = overlayProblems(s.dir, config, panel(paths));
        assert.match(String(p), re, JSON.stringify(paths));
      }

      const refused = await forgeAsync(s.dir, ['eval', 'start', '--tasks', 't', '--set', 'review.panel=[{name: code, always: true}, {name: security, paths: [../x]}]']);
      assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stderr, /review\.panel entry 2: review\.panel "security"\.paths entry "\.\.\/x" must not contain a \.\. segment/);
      assertNothingCreated(s.dir, 'a bad glob creates nothing');

      const ok = await start(s.dir, '--set', 'review.panel=[{name: code, always: true}, {name: security, paths: ["lib/**", "*.ts"]}]');
      assert.deepEqual(ok.overlay['review.panel'], [{ name: 'code', always: true }, { name: 'security', paths: ['lib/**', '*.ts'] }]);
    } finally {
      s.cleanup();
    }
  });

  test('the overlay is recorded and hashed', async () => {
    const s = evalScratch();
    try {
      const config = loadConfig(s.dir).config;
      const plain = await start(s.dir, '--label', 'plain');
      const rec = await start(s.dir, '--label', 'overlay', '--set', 'pipeline.maxRounds=5', '--repeat', '2');
      assert.deepEqual(rec.overlay, { 'pipeline.maxRounds': 5 });
      assert.equal(rec.tasks.length, 2);
      for (const t of rec.tasks) {
        const job = loadJob(s.dir, t.job);
        assert.deepEqual(job.eval?.overlay, { 'pipeline.maxRounds': 5 });
        assert.equal(job.maxRounds, 5);
      }
      assert.deepEqual(loadJob(s.dir, plain.tasks[0].job).eval?.overlay, {});
      assert.equal(loadJob(s.dir, plain.tasks[0].job).maxRounds, config.pipeline.maxRounds);

      assert.equal(configHash(s.dir, applyOverlay(config, {})), configHash(s.dir, config));
      assert.equal(plain.configHash, configHash(s.dir, config), 'a plain run hashes as before');
      assert.notEqual(rec.configHash, plain.configHash);
      assert.equal(rec.configHash, configHash(s.dir, applyOverlay(config, { 'pipeline.maxRounds': 5 })));
    } finally {
      s.cleanup();
    }
  });

  test('the config file is never written', async () => {
    const s = evalScratch();
    try {
      const before = fs.readFileSync(configFile(s.dir));
      const rec = await start(s.dir, ...['pipeline.maxRounds=3', 'runtime.effort=low', 'verify=[test]', 'runtime.models.spec-writer=haiku'].flatMap((x) => ['--set', x]));
      assert.deepEqual(fs.readFileSync(configFile(s.dir)), before);
      const id = rec.tasks[0].job;
      await firstSpawn(s.dir, id);
      assert.deepEqual(fs.readFileSync(configFile(s.dir)), before);
      const v = await forgeAsync(s.dir, ['verify', id]);
      assert.equal(v.status, 0, v.stderr);
      assert.deepEqual(fs.readFileSync(configFile(s.dir)), before);
    } finally {
      s.cleanup();
    }
  });

  test('step applies the overlay to its job only', async () => {
    const s = evalScratch();
    try {
      const config = loadConfig(s.dir).config;
      const rec = await start(s.dir, '--label', 'low', '--set', 'runtime.effort=low', '--set', 'runtime.models.spec-writer=haiku');
      const spawn = await firstSpawn(s.dir, rec.tasks[0].job);
      assert.equal(spawn.role, 'spec-writer');
      assert.equal(spawn.model, 'haiku');
      assert.equal(spawn.effort, 'low');

      // Another eval job, without the overlay, in the same repo.
      const plain = await start(s.dir, '--label', 'plain');
      const base = await firstSpawn(s.dir, plain.tasks[0].job);
      assert.equal(base.role, 'spec-writer');
      assert.equal(base.model, config.runtime.models['spec-writer']);
      assert.notEqual(base.model, 'haiku');
      assert.equal(base.effort ?? null, resolveEffort(config, loadJob(s.dir, plain.tasks[0].job), 'spec-writer').level);

      // A job that is not an eval job reads the base config, whatever its fields say.
      const other = createJob(s.dir, config, { title: 'Plain job', body: 'Do a small thing' });
      const x = loadStepInput(s.dir, config, other.id);
      assert.equal(x.config, config);
      assert.equal(configForJob(s.dir, config, { id: 'x', kind: 'feature', eval: { run: 'r', task: 't', overlay: { 'runtime.effort': 'low' } } }), config);
    } finally {
      s.cleanup();
    }
  });

  test('verify and budget use the job\'s overlay', async () => {
    const s = evalScratch();
    try {
      assert.deepEqual(loadConfig(s.dir).config.verify, ['build', 'lint', 'test']);
      const rec = await start(s.dir, '--set', 'verify=[test]', '--set', 'pipeline.budget.tokens=1000');
      const id = rec.tasks[0].job;
      const v = await forgeAsync(s.dir, ['verify', id]);
      assert.equal(v.status, 0, v.stderr);
      const res = JSON.parse(v.stdout);
      const names = res.steps.map((x) => x.name);
      assert.ok(names.includes('test'), names.join());
      assert.equal(names.includes('build') || names.includes('lint'), false, names.join());
      const md = fs.readFileSync(path.join(jobDir(s.dir, id), 'verify', 'round-0.md'), 'utf8');
      assert.match(md, /^## test: ok$/m);
      assert.doesNotMatch(md, /^## (build|lint)/m);

      const b = await forgeAsync(s.dir, ['job', 'budget', id]);
      assert.equal(b.status, 0, b.stderr);
      assert.equal(JSON.parse(b.stdout).limits.tokens, 1000);
    } finally {
      s.cleanup();
    }
  });

  test('a session can neither write nor start an overlay', async () => {
    const s = evalScratch();
    try {
      const rec = await start(s.dir);
      const id = rec.tasks[0].job;
      const before = fs.readFileSync(path.join(jobDir(s.dir, id), 'job.json'), 'utf8');
      for (const kv of ['eval.overlay.verify=["test"]', 'eval={}']) {
        const r = await forgeAsync(s.dir, ['job', 'set', id, '--field', kv]);
        assert.equal(r.status, 1, r.stderr);
        assert.match(r.stderr, /--field eval is not settable; use forge eval start/);
      }
      assert.equal(fs.readFileSync(path.join(jobDir(s.dir, id), 'job.json'), 'utf8'), before);
    } finally {
      s.cleanup();
    }

    const d = evalScratch();
    try {
      const daemon = () => ({ FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(d.dir) });
      const set = await forgeAsync(d.dir, ['eval', 'start', '--tasks', 't', '--set', 'pipeline.maxRounds=5'], daemon());
      assert.equal(set.status, 1, set.stderr);
      assert.match(set.stderr, /forge eval start --set changes what eval jobs run, which a daemon session may not do/);
      assertNothingCreated(d.dir);
      const rep = await forgeAsync(d.dir, ['eval', 'start', '--tasks', 't', '--repeat', '2'], daemon());
      assert.equal(rep.status, 0, rep.stderr);
      assert.equal(JSON.parse(rep.stdout).tasks.length, 2);
    } finally {
      d.cleanup();
    }
  });

  test('a tampered overlay fails closed', async () => {
    const s = evalScratch();
    try {
      const rec = await start(s.dir, '--repeat', '3');
      const [a, b, c] = rec.tasks.map((t) => t.job);
      tamper(s.dir, a, { verify: ['nope'] });
      tamper(s.dir, b, { 'review.panel': [{ name: 'code', checklist: '../x.md' }] });
      tamper(s.dir, c, 'not a map');
      for (const id of [a, b, c]) {
        const st = await forgeAsync(s.dir, ['job', 'step', id]);
        assert.equal(st.status, 1, st.stderr);
        assert.match(st.stderr, new RegExp(`eval job ${id} has an invalid config overlay: `));
        const v = await forgeAsync(s.dir, ['verify', id]);
        assert.equal(v.status, 1, v.stderr);
        assert.match(v.stderr, /invalid config overlay/);
        assert.equal(fs.existsSync(path.join(jobDir(s.dir, id), 'verify')), false, 'verify ran nothing');
        assert.deepEqual(loadJob(s.dir, id).verifyRuns, []);
      }

      const config = loadConfig(s.dir).config;
      assert.deepEqual(overlayProblems(s.dir, config, { 'commands.test': 'rm -rf /' }).length, 1);
      assert.throws(() => configForJob(s.dir, config, { id: 'j', kind: 'eval', eval: { run: 'r', task: 't', overlay: JSON.parse('{"__proto__": {"x": 1}}') } }), /invalid config overlay/);
      assert.equal(({} as any).x, undefined);
      assert.equal(configForJob(s.dir, defaults(), { id: 'j', kind: 'eval', eval: { run: 'r', task: 't', overlay: {} } }).pipeline.maxRounds, defaults().pipeline.maxRounds);
    } finally {
      s.cleanup();
    }
  });
});
