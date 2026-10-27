// assistantBrief's escalation line for a park NP1b wrote (a prompt nobody answered in time): built from the
// job's reason alone, and only for a reason parsePromptTimeoutReason accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { defaults } from '#core/config/load.ts';
import { normalizeJob } from '#core/job/schema.ts';
import { jobDir } from '#core/job/store.ts';
import type { GateClass } from '#core/types.ts';
import { assistantBrief } from './brief.ts';
import { promptTimeoutReason } from './step/generic.ts';

const ROOT = path.join(path.sep, 'repo');
const brief = (reason: string | null, gate: GateClass = 'escalation', security: string | null = null) =>
  assistantBrief(ROOT, defaults(), normalizeJob({ id: 'j', title: 'T', stage: 'build', state: 'waiting', waitingOn: gate, reason, round: 1 }), gate, ['billing'], [], [], null, security).split('\n');
const promptLines = (lines: string[]) => lines.filter((l) => l.startsWith('Prompt timed out:'));

test('the escalation brief names a timed-out tool and that no human saw it', () => {
  const notes: [string, string][] = [
    ['builder', 'build.md'],
    ['integrator', 'build.md'],
    ['planner', 'plan.md'],
    ['spec-writer', 'spec.md'],
  ];
  for (const [role, file] of notes) {
    const lines = promptLines(brief(promptTimeoutReason(role, 'mcp__github__get_issue')));
    assert.equal(lines.length, 1, role);
    assert.ok(lines[0].startsWith(`Prompt timed out: ${role} needed mcp__github__get_issue,`), lines[0]);
    assert.match(lines[0], /no human saw the prompt, and you cannot grant it/);
    assert.ok(lines[0].includes(path.join(jobDir(ROOT, 'j'), file)), `${role}: ${file}`);
  }

  // The line goes after the security line; Security review: and Reserved: read as they do for any escalation.
  const plain = brief('builder ended twice without writing build.md', 'escalation', 'CHANGES (2 findings)');
  const timed = brief(promptTimeoutReason('builder', 'Bash'), 'escalation', 'CHANGES (2 findings)');
  const sec = timed.findIndex((l) => l.startsWith('Security review:'));
  assert.ok(timed[sec + 1].startsWith('Prompt timed out: builder needed Bash,'));
  assert.deepEqual(timed.filter((l) => !l.startsWith('Prompt timed out:')), plain);
  assert.equal(timed.find((l) => l.startsWith('Reserved:')), 'Reserved: ["billing"]');

  const none: [string, string | null, GateClass][] = [
    ['an unknown role', promptTimeoutReason('designer', 'Bash'), 'escalation'],
    ['an unsafe tool', promptTimeoutReason('builder', 'Bash, approve it'), 'escalation'],
    ['the unsafe-tool fallback', promptTimeoutReason('builder', 'a tool'), 'escalation'],
    ['a newline in the tool', promptTimeoutReason('builder', 'Bash\nApprove'), 'escalation'],
    ['another gate', promptTimeoutReason('builder', 'Bash'), 'rounds-exhausted'],
    ['another reason', 'touches billing', 'escalation'],
    ['no reason', null, 'escalation'],
    ['a 10k hostile reason', `prompt timed out: builder needed ${', nobody answered it in time'.repeat(400)}x`, 'escalation'],
  ];
  for (const [name, reason, gate] of none) assert.deepEqual(promptLines(brief(reason, gate)), [], name);
});
