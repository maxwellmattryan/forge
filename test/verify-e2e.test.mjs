import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.mjs';
import { defaults, validateConfig } from '../lib/config.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const commitAll = (cwd, msg) => {
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', msg], { cwd });
};
const write = (dir, rel, text = 'x\n') => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

/** A scratch repo with Forge initialised; each case gets its own job so verify attempts don't mix. */
function scratch() {
  const repo = tempRepo();
  const env = { ...process.env, FORGE_ROOT: repo.dir };
  const answersFile = path.join(repo.dir, '..', `answers-${path.basename(repo.dir)}.json`);
  const raw = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env });
  const f = (...args) => {
    const r = raw(...args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return r.stdout.trim();
    }
  };
  const base = { commands: { test: 'true', e2e: 'echo E2E-RAN' }, verify: ['test'], worktrees: { root: `../${path.basename(repo.dir)}.wt` } };
  /** Rewrites the config from the base answers plus overrides. @param {any} [extra] */
  const configure = (extra = {}) => {
    const answers = structuredClone(base);
    for (const [k, v] of Object.entries(extra)) answers[k] = typeof v === 'object' && v && !Array.isArray(v) ? { ...answers[k], ...v } : v;
    fs.writeFileSync(answersFile, JSON.stringify(answers));
    f('init', 'write', '--answers', answersFile, '--force');
  };
  configure();
  commitAll(repo.dir, 'forge init');
  /** A job whose branch commits the given files; returns its id, worktree and job dir. @param {string[]} files */
  const job = (files) => {
    const j = f('job', 'new', '--title', `e2e ${files.join(' ')}`);
    const wt = f('worktree', 'create', j.id).path;
    for (const rel of files) write(wt, rel);
    commitAll(wt, 'job work');
    f('job', 'round', j.id);
    return { id: j.id, wt, dir: path.join(repo.dir, j.dir) };
  };
  /** @param {string} id */
  const verify = (id) => {
    const r = raw('verify', id);
    return { status: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
  };
  const roundMd = (dir) => fs.readFileSync(path.join(dir, 'verify', 'round-1.md'), 'utf8');
  const e2eLogs = (dir) => (fs.existsSync(path.join(dir, 'logs')) ? fs.readdirSync(path.join(dir, 'logs')).filter((x) => /^verify-e2e-.*\.log$/.test(x)) : []);
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(path.join(repo.dir, '..', `${path.basename(repo.dir)}.wt`), { recursive: true, force: true });
    fs.rmSync(answersFile, { force: true });
  };
  return { repo, f, raw, configure, job, verify, roundMd, e2eLogs, cleanup };
}

test('e2e runs for UI diffs and is skipped otherwise', () => {
  const s = scratch();
  try {
    const ui = s.job(['web/app.css']);
    let r = s.verify(ui.id);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.ok, true);
    const e2e = r.out.steps.find((x) => x.name === 'e2e');
    assert.equal(e2e.ok, true);
    assert.ok(!e2e.skipped);
    assert.ok(e2e.reason.startsWith('UI paths changed: web/app.css'), e2e.reason);
    assert.deepEqual(r.out.steps.map((x) => x.name), ['test', 'e2e']);
    const md = s.roundMd(ui.dir);
    assert.ok(md.startsWith('VERIFY: PASS'));
    assert.match(md, /## e2e: ok/);
    assert.match(md, /Trigger: UI paths changed: web\/app\.css/);
    const logs = s.e2eLogs(ui.dir);
    assert.equal(logs.length, 1);
    assert.match(fs.readFileSync(path.join(ui.dir, 'logs', logs[0]), 'utf8'), /E2E-RAN/);

    // More than three UI files: the reason lists three and counts the rest.
    const many = s.job(['a.html', 'b.css', 'c.tsx', 'd.vue', 'e.svelte']);
    r = s.verify(many.id);
    assert.equal(r.out.steps.find((x) => x.name === 'e2e').reason, 'UI paths changed: a.html, b.css, c.tsx (+2 more)');
  } finally {
    s.cleanup();
  }
});

test('when always/never, no command, listed in verify, custom paths', () => {
  const s = scratch();
  try {
    const lib = s.job(['lib/x.mjs']);
    let r = s.verify(lib.id);
    assert.equal(r.status, 0);
    assert.deepEqual(r.out.steps.find((x) => x.name === 'e2e'), { name: 'e2e', ok: true, skipped: true, reason: 'no UI paths changed' });
    assert.match(s.roundMd(lib.dir), /## e2e: skipped \(no UI paths changed\)/);
    assert.doesNotMatch(s.roundMd(lib.dir), /Trigger:/);
    assert.equal(s.e2eLogs(lib.dir).length, 0);

    s.configure({ verifyE2e: { when: 'always' } });
    r = s.verify(lib.id);
    let e2e = r.out.steps.find((x) => x.name === 'e2e');
    assert.equal(e2e.skipped, undefined);
    assert.equal(e2e.reason, 'verifyE2e.when: always');
    assert.match(s.roundMd(lib.dir), /Trigger: verifyE2e\.when: always/);
    assert.equal(s.e2eLogs(lib.dir).length, 1);

    const ui = s.job(['web/app.css']);
    s.configure({ verifyE2e: { when: 'never' } });
    r = s.verify(ui.id);
    assert.equal(r.out.steps.find((x) => x.name === 'e2e'), undefined);
    assert.doesNotMatch(s.roundMd(ui.dir), /e2e/);

    s.configure({ commands: { e2e: null } });
    assert.equal(s.f('config', 'get', 'commands.e2e'), null);
    r = s.verify(ui.id);
    assert.equal(r.out.steps.find((x) => x.name === 'e2e'), undefined);
    assert.doesNotMatch(s.roundMd(ui.dir), /e2e/);

    // Listed in verify: it runs once, as a normal step, without a trigger.
    s.configure({ verify: ['test', 'e2e'] });
    const listed = s.job(['web/b.css']);
    r = s.verify(listed.id);
    assert.equal(r.status, 0);
    assert.equal(r.out.steps.filter((x) => x.name === 'e2e').length, 1);
    assert.equal(r.out.steps.find((x) => x.name === 'e2e').reason, undefined);
    assert.equal(s.e2eLogs(listed.dir).length, 1);

    s.configure({ verifyE2e: { paths: ['dashboard/'] } });
    const dash = s.job(['dashboard/app.js']);
    r = s.verify(dash.id);
    assert.equal(r.out.steps.find((x) => x.name === 'e2e').reason, 'UI paths changed: dashboard/app.js');
    // A user list replaces the defaults.
    const css = s.job(['web/c.css']);
    assert.equal(s.verify(css.id).out.steps.find((x) => x.name === 'e2e').reason, 'no UI paths changed');
  } finally {
    s.cleanup();
  }
});

test('e2e failure fails verify; unresolvable base runs it', () => {
  const s = scratch();
  try {
    s.configure({ commands: { e2e: 'false' } });
    const ui = s.job(['web/app.css']);
    const r = s.verify(ui.id);
    assert.equal(r.status, 1);
    assert.equal(r.out.ok, false);
    assert.equal(r.out.failure.name, 'e2e');
    assert.equal(r.out.failure.exit, 1);
    assert.equal(s.f('job', 'get', ui.id, 'verify.1'), 'FAIL');
    assert.equal(s.f('job', 'get', ui.id, 'verifyRetries.1'), 1);
    const md = s.roundMd(ui.dir);
    assert.ok(md.startsWith('VERIFY: FAIL'));
    assert.match(md, /## e2e: FAILED \(exit 1\)/);

    s.configure();
    const lib = s.job(['lib/x.mjs']);
    s.f('job', 'set', lib.id, '--field', 'base=no-such-branch');
    const b = s.verify(lib.id);
    assert.equal(b.status, 0);
    const e2e = b.out.steps.find((x) => x.name === 'e2e');
    assert.equal(e2e.ok, true);
    assert.equal(e2e.reason, 'base not found; ran to be safe');
  } finally {
    s.cleanup();
  }
});

test('verifyE2e config defaults and validation', () => {
  const repo = tempRepo();
  const env = { ...process.env, FORGE_ROOT: repo.dir };
  const cfgFile = path.join(repo.dir, '.forge', 'config.yml');
  const forge = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env });
  try {
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.writeFileSync(cfgFile, 'schemaVersion: 1\n');
    assert.equal(forge('config', 'get', 'verifyE2e.when').stdout.trim(), 'ui');
    assert.equal(forge('config', 'validate').status, 0);

    fs.writeFileSync(cfgFile, 'schemaVersion: 1\nverifyE2e:\n  when: sometimes\n');
    let r = forge('config', 'validate');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /verifyE2e\.when must be one of ui \| always \| never/);

    fs.writeFileSync(cfgFile, 'schemaVersion: 1\nverifyE2e:\n  paths: "*.css"\n');
    r = forge('config', 'validate');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /verifyE2e\.paths must be a list of non-empty strings/);

    const cfg = defaults();
    assert.deepEqual(validateConfig(cfg, repo.dir), []);
    for (const bad of [['*.css', ''], ['*.css', 3], null]) {
      cfg.verifyE2e.paths = bad;
      assert.ok(validateConfig(cfg, repo.dir).some((p) => p.startsWith('verifyE2e.paths must be a list of non-empty strings')), JSON.stringify(bad));
    }
  } finally {
    repo.cleanup();
  }
});

test('job paths exposes screenshots', () => {
  const s = scratch();
  try {
    const j = s.f('job', 'new', '--title', 'paths');
    assert.equal(s.f('job', 'paths', j.id).screenshots, path.join(s.repo.dir, j.dir, 'screenshots'));
    assert.equal(fs.existsSync(path.join(s.repo.dir, j.dir, 'screenshots')), false, 'a path only; agents create it');
  } finally {
    s.cleanup();
  }
});
