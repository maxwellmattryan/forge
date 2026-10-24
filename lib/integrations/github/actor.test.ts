// Who an action is recorded as: resolveActor over injected deps, so no gh, git or OS user is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveActor } from './actor.ts';
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
