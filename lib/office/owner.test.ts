// The daemon refusals that keep a session to its own scope, checked in-process over a plain env.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ForgeError } from '#core/errors.ts';
import { INBOX_SCOPE, OFFICE_SCOPE } from '#core/job/requests.ts';
import { ASSISTANT_REFUSAL, OFFICE_REFUSAL, inInboxOrOffice, refuseBrokenScope, refuseDaemonMerge, refuseInOffice, refuseInboxDrive, refuseInboxOrOffice } from './owner.ts';

const daemon = (scope: string | undefined): NodeJS.ProcessEnv => ({ FORGE_DAEMON: '1', ...(scope === undefined ? {} : { FORGE_DAEMON_SCOPE: scope }) });
const refusal = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    assert.ok(e instanceof ForgeError && e.exitCode === 1, String(e));
    return e.message;
  }
};

test('daemon merge refusals', () => {
  const NOW = /--now is a human's override; a daemon session never passes it/;
  const rows: [string, string, Record<string, unknown>, NodeJS.ProcessEnv, RegExp | null][] = [
    ['--now in the job\'s own scope', 'j1', { now: true }, daemon('j1'), NOW],
    ['--now in another scope', 'j1', { now: true }, daemon('j2'), NOW],
    ['--now with a value', 'j1', { now: 'x' }, daemon('j1'), NOW],
    ["another job's id", 'j2', {}, daemon('j1'), /a daemon session merges only its own job \(j1\), not j2/],
    ['the inbox scope', 'j1', {}, daemon(INBOX_SCOPE), new RegExp(`merges only its own job \\(${INBOX_SCOPE}\\), not j1`)],
    ['the office', 'j1', {}, daemon(OFFICE_SCOPE), new RegExp(OFFICE_REFUSAL)],
    ['an assistant foreman', 'j1', {}, daemon('_assistant-1'), new RegExp(ASSISTANT_REFUSAL)],
    ['an assistant foreman with --now', 'j1', { now: true }, daemon('_assistant-1'), new RegExp(ASSISTANT_REFUSAL)],
    ['an assistant foreman naming its own scope', '_assistant-1', {}, daemon('_assistant-1'), new RegExp(ASSISTANT_REFUSAL)],
    ['a missing FORGE_DAEMON_SCOPE', 'j1', {}, daemon(undefined), /FORGE_DAEMON_SCOPE is missing or invalid/],
    ['an invalid FORGE_DAEMON_SCOPE', 'j1', {}, daemon('../x'), /FORGE_DAEMON_SCOPE is missing or invalid/],
    ['its own id without --now', 'j1', {}, daemon('j1'), null],
    ['any id outside a daemon', 'j2', {}, {}, null],
    ['--now outside a daemon', 'j2', { now: true }, {}, null],
  ];
  for (const [name, id, flags, env, want] of rows) {
    const got = refusal(() => refuseDaemonMerge(id, flags, env));
    if (want === null) assert.equal(got, null, name);
    else assert.match(got ?? '', want, name);
  }
});

test('refuseBrokenScope refuses a daemon session whose scope is missing or invalid', () => {
  const BROKEN = /FORGE_DAEMON_SCOPE is missing or invalid/;
  const rows: [string, NodeJS.ProcessEnv, RegExp | null][] = [
    ['a missing scope', daemon(undefined), BROKEN],
    ['an empty scope', daemon(''), BROKEN],
    ['an invalid scope', daemon('../x'), BROKEN],
    ['a job scope', daemon('j1'), null],
    ['the office', daemon(OFFICE_SCOPE), null],
    ['an assistant foreman', daemon('_assistant-1'), null],
    ['a forged assistant scope', daemon('_assistant-01'), BROKEN],
    ['the gate group', daemon('_assistants'), BROKEN],
    ['outside a daemon', { FORGE_DAEMON_SCOPE: '' }, null],
  ];
  for (const [name, env, want] of rows) {
    const got = refusal(() => refuseBrokenScope(env));
    if (want === null) assert.equal(got, null, name);
    else assert.match(got ?? '', want, name);
  }
});

test('refuseInOffice refuses an invalid scope', () => {
  assert.match(refusal(() => refuseInOffice('hint', daemon('../x'))) ?? '', /FORGE_DAEMON_SCOPE is missing or invalid/);
  assert.match(refusal(() => refuseInOffice('hint', daemon(OFFICE_SCOPE))) ?? '', new RegExp(`${OFFICE_REFUSAL}; hint`));
  assert.equal(refusal(() => refuseInOffice('hint', daemon('j1'))), null);
  assert.equal(refusal(() => refuseInOffice('hint', {})), null);
  // An assistant foreman: every refusal the office gets, with its own reason.
  const assistant = daemon('_assistant-1');
  assert.match(refusal(() => refuseInOffice('hint', assistant)) ?? '', new RegExp(`${ASSISTANT_REFUSAL}; hint`));
  assert.match(refusal(() => refuseInboxDrive('j1', assistant)) ?? '', new RegExp(ASSISTANT_REFUSAL));
  assert.match(refusal(() => refuseInboxOrOffice('hint', assistant)) ?? '', new RegExp(ASSISTANT_REFUSAL));
  assert.equal(inInboxOrOffice(assistant), true);
  // A chat may drive a job when the owner asks: none of these refuse it, so forge job set tears an environment down there.
  const chat = daemon('_chat-0123456789ab');
  assert.equal(refusal(() => refuseInboxDrive('j1', chat)), null);
  assert.equal(refusal(() => refuseInboxOrOffice('hint', chat)), null);
  assert.equal(inInboxOrOffice(chat), false);
});
