// confirmHuman over an injected Terminal and over processTerminal's readline on streams flagged as
// TTYs: a human-only operation runs only for a person who types the id back at an interactive
// terminal, outside a daemon session. And what each operation's prompt asks for.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import '../../../test/helpers.ts';
import { ForgeError } from '#core/errors.ts';
import { currentActor } from '#integrations/github/actor.ts';
import { budgetAckOp, confirmHuman, jobBudgetOp, mergeNowOp, processTerminal } from './human.ts';
import type { HumanOp, Terminal } from './human.ts';

const OP = { command: 'forge pr merge --now', what: 'merges j1 now', confirm: 'j1' };

test('confirmHuman refuses without a confirming person at a terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-human-'));
  try {
    const rows: [string, boolean, string | null, NodeJS.ProcessEnv, { code: string; message: RegExp } | 'grant', boolean][] = [
      ['a daemon session at an interactive terminal', true, 'j1', { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: 'j1' }, { code: 'human_only', message: /human-only operation/ }, false],
      ['a non-interactive terminal with the right answer', false, 'j1', {}, { code: 'human_only', message: /needs a person at a terminal.*an agent, a script or a configured command can't run it.*Run it in your own terminal$/ }, false],
      ['an interactive terminal answering another string', true, 'j2', {}, { code: 'failed', message: /not confirmed; nothing changed/ }, true],
      ['an interactive terminal whose input ends without an answer', true, null, {}, { code: 'failed', message: /not confirmed; nothing changed/ }, true],
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

test('at a real readline prompt, Ctrl-D, Ctrl-C or stdin closing refuses, and only the id with Enter grants', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-human-'));
  try {
    const rows: [string, (input: PassThrough) => void, 'grant' | 'refused'][] = [
      ['Ctrl-D on an empty line', (i) => i.write('\x04'), 'refused'],
      ['Ctrl-C', (i) => i.write('\x03'), 'refused'],
      ['stdin closing', (i) => i.end(), 'refused'],
      ['the id typed without Enter, then stdin closing', (i) => i.end('j1'), 'refused'],
      ['the id and Enter', (i) => i.write('j1\r'), 'grant'],
    ];
    for (const [name, type, want] of rows) {
      // Both flagged as TTYs, so readline runs in terminal mode and reads keys as a person's terminal sends them.
      const input = Object.assign(new PassThrough(), { isTTY: true });
      const output = Object.assign(new PassThrough(), { isTTY: true });
      let shown = '';
      output.on('data', (b: Buffer) => (shown += b.toString()));
      const term = processTerminal(input, output);
      assert.equal(term.interactive, true, name);
      const pending = confirmHuman(root, OP, term, {});
      type(input);
      if (want === 'grant') {
        assert.deepEqual(await pending, { channel: 'terminal', actor: currentActor(root) }, name);
      } else {
        await assert.rejects(pending, (e: unknown) => {
          assert.ok(e instanceof ForgeError, name);
          assert.equal(e.code, 'failed', name);
          assert.equal(e.exitCode, 1, name);
          assert.match(e.message, /not confirmed; nothing changed/, name);
          return true;
        });
      }
      assert.match(shown, /Type j1 to confirm/, `${name}: the prompt was shown`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("both refusals offer the dashboard's control only for an operation that has one", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-human-'));
  try {
    const rows: [string, HumanOp, string | null][] = [
      ['pr merge --now', mergeNowOp('j1'), 'Merge now in the dashboard'],
      ['budget ack', budgetAckOp('2026-10'), "Acknowledge in the dashboard's Needs you"],
      ['job budget --set|--ack (no dashboard route)', jobBudgetOp('j1', { set: true, ack: true }), null],
    ];
    const refusals: [string, Terminal, NodeJS.ProcessEnv, (channel: string) => string, string][] = [
      ['a daemon session', { interactive: true, ask: async () => 'j1' }, { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: 'j1' }, (c) => ` or uses ${c}`, 'a human runs it in their own terminal'],
      ['no terminal', { interactive: false, ask: async () => 'j1' }, {}, (c) => `, or use ${c}`, 'Run it in your own terminal'],
    ];
    for (const [name, op, channel] of rows) {
      for (const [where, term, env, offer, terminal] of refusals) {
        await assert.rejects(confirmHuman(root, op, term, env), (e: unknown) => {
          assert.ok(e instanceof ForgeError, `${name}, ${where}`);
          assert.equal(e.code, 'human_only', `${name}, ${where}`);
          assert.ok(e.message.endsWith(terminal + (channel ? offer(channel) : '')), `${name}, ${where}: ${e.message}`);
          if (!channel) assert.ok(!e.message.includes('dashboard'), `${name}, ${where}: offers no dashboard control`);
          return true;
        });
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('each human-only operation asks for a validated id or period and names what it changes', () => {
  const rows: [string, HumanOp, string, string[], string[]][] = [
    ['pr merge --now', mergeNowOp('j1'), 'j1', ['forge pr merge j1 --now'], []],
    ['job budget --set', jobBudgetOp('j1', { set: true, ack: false }), 'j1', ['forge job budget j1', '--set'], ['--ack']],
    ['job budget --ack', jobBudgetOp('j1', { set: false, ack: true }), 'j1', ['forge job budget j1', '--ack'], ['--set']],
    ['job budget --set --ack', jobBudgetOp('j1', { set: true, ack: true }), 'j1', ['--set', '--ack'], []],
    ['budget ack', budgetAckOp('2026-10'), '2026-10', ['forge budget ack --period 2026-10'], []],
  ];
  for (const [name, op, confirm, names, omits] of rows) {
    assert.equal(op.confirm, confirm, name);
    assert.ok(!op.what.includes('\n'), `${name}: one line, above the Type … to confirm line`);
    for (const s of names) assert.ok(op.what.includes(s), `${name}: names ${s}`);
    for (const s of omits) assert.ok(!op.what.includes(s), `${name}: doesn't name ${s}`);
  }
});
