// Who an action is recorded as: resolveActor over injected deps, so no gh, git or OS user is read,
// and currentActor's per-root memo over seeded actor.json caches.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentActor, resolveActor } from './actor.ts';
import type { ActorDeps } from './actor.ts';

const deps = (env: NodeJS.ProcessEnv, osUser: string | null = 'carol'): ActorDeps => ({
  env,
  gh: () => 'gh-login',
  gitEmail: () => 'g@example.com',
  osUser: () => osUser,
  cacheFile: null,
  now: () => 0,
});

test('resolveActor: a daemon session records source daemon', () => {
  const rows: [string, ActorDeps, { login: string | null; source: string }][] = [
    ['a daemon session', deps({ FORGE_DAEMON: '1' }), { login: 'carol', source: 'daemon' }],
    ['a daemon session ignores FORGE_ACTOR', deps({ FORGE_DAEMON: '1', FORGE_ACTOR: 'spoof' }), { login: 'carol', source: 'daemon' }],
    ['a daemon session with no OS user', deps({ FORGE_DAEMON: '1' }, null), { login: null, source: 'daemon' }],
    ['FORGE_ACTOR outside a daemon', deps({ FORGE_ACTOR: 'alice' }), { login: 'alice', source: 'env' }],
  ];
  for (const [name, d, want] of rows) assert.deepEqual(resolveActor(d), want, name);
});

test('currentActor: one process keeps each root its own cached login', () => {
  const saved = { FORGE_DAEMON: process.env.FORGE_DAEMON, FORGE_ACTOR: process.env.FORGE_ACTOR, GH_HOST: process.env.GH_HOST };
  for (const k of Object.keys(saved)) delete process.env[k];
  const roots = ['alice', 'bob'].map((login) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `forge-actor-${login}-`)));
    fs.mkdirSync(path.join(root, '.forge', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, '.forge', 'runtime', 'actor.json'), JSON.stringify({ 'github.com': { login, at: Date.now() } }));
    return root;
  });
  try {
    assert.deepEqual(currentActor(roots[0]!), { login: 'alice', source: 'gh' });
    assert.deepEqual(currentActor(roots[1]!), { login: 'bob', source: 'gh' });
    assert.deepEqual(currentActor(roots[0]!), { login: 'alice', source: 'gh' });
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  }
});
