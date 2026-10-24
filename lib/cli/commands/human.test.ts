// confirmHuman over an injected Terminal: a human-only operation runs only for a person who types
// the id back at an interactive terminal, outside a daemon session.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../../../test/helpers.ts';
import { ForgeError } from '#core/errors.ts';
import { currentActor } from '#integrations/github/actor.ts';
import { confirmHuman } from './human.ts';
import type { Terminal } from './human.ts';

const OP = { command: 'forge pr merge --now', what: 'merges j1 now', confirm: 'j1' };

test('confirmHuman refuses without a confirming person at a terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-human-'));
  try {
    const rows: [string, boolean, string, NodeJS.ProcessEnv, { code: string; message: RegExp } | 'grant', boolean][] = [
      ['a daemon session at an interactive terminal', true, 'j1', { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: 'j1' }, { code: 'human_only', message: /human-only operation/ }, false],
      ['a non-interactive terminal with the right answer', false, 'j1', {}, { code: 'human_only', message: /needs a person at a terminal.*an agent, a script or a configured command can't run it.*your own terminal, or use the dashboard/ }, false],
      ['an interactive terminal answering another string', true, 'j2', {}, { code: 'failed', message: /not confirmed; nothing changed/ }, true],
      ['an interactive terminal answering the id with whitespace', true, '  j1\n', {}, 'grant', true],
    ];
    for (const [name, interactive, answer, env, want, asks] of rows) {
      const prompts: string[] = [];
      const term: Terminal = { interactive, ask: async (p) => (prompts.push(p), answer) };
      if (want === 'grant') {
        assert.deepEqual(await confirmHuman(root, OP, term, env), { channel: 'terminal', actor: currentActor(root) }, name);
      } else {
        await assert.rejects(confirmHuman(root, OP, term, env), (e: unknown) => {
          assert.ok(e instanceof ForgeError, name);
          assert.equal(e.code, want.code, name);
          assert.equal(e.exitCode, 1, name);
          assert.match(e.message, want.message, name);
          return true;
        });
      }
      assert.equal(prompts.length, asks ? 1 : 0, `${name}: asked`);
      if (asks) assert.match(prompts[0], /merges j1 now[\s\S]*Type j1 to confirm/, name);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
