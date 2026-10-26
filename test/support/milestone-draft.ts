// A goal mandate at the milestone-approval gate, for the gate, filing and CLI tests: a repo whose config
// delegates the class, a goal mandate with its first draft request done, and a draft.json written as
// `forge mandate draft record` writes it (so its digest is what readDraft computes).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN } from './cli.ts';
import { forgeInProcess } from './in-process.ts';
import { ackRequest, claimRequest, listRequests } from '#core/job/requests.ts';
import { DRAFT_SCHEMA_VERSION } from '#core/versions/draft.ts';
import type { DraftBody } from '#core/types.ts';

/** `forge init write` answers: the foreman on and delegating milestone-approval, assistants on, nothing reserved. */
export function initMilestoneRepo(dir: string, foreman: Record<string, unknown> = {}): void {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ foreman: { enabled: true, decides: ['spec-approval', 'milestone-approval'], reserved: [], assistants: { enabled: true }, ...foreman } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
}

/** Three issues in two waves: `lens` and `brief` are new, `reuse` reuses the backlog's `old-item`, and `brief` depends on `lens`. */
export const MILESTONE_DRAFT: DraftBody = {
  milestone: { title: 'Fewer review rounds', exitCriteria: ['quality.avgRounds under 1.5', 'no nit-only rounds'] },
  issues: [
    { key: 'lens', title: 'Sharper code lens', why: 'Rounds go to nits.', whatToDo: 'Trim the checklist.', done: 'Fewer nit findings.', stat: 'quality.avgRounds', wave: 1, dependsOn: [], files: ['reviewers/'], existing: null },
    { key: 'reuse', title: 'Old item', why: 'It already says it.', whatToDo: 'Keep it.', done: 'It is in the milestone.', stat: 'quality.avgRounds', wave: 1, dependsOn: [], files: ['docs/'], existing: { ref: 'old-item', action: 'reuse' } },
    { key: 'brief', title: 'Builder brief names nits', why: 'Builders repeat them.', whatToDo: 'Add a line.', done: 'It is there.', stat: 'quality.firstPassReviewRate', wave: 2, dependsOn: ['lens'], files: ['agents/builder.md'], existing: null },
  ],
};

export const draftJson = (root: string, id: string): string => path.join(root, '.forge', 'runtime', 'mandates', id, 'draft.json');

/** draft.json as recordDraft writes it, for `request`: its digest. */
export function writeDraftFile(root: string, id: string, request: string, body: unknown = MILESTONE_DRAFT): string {
  const text = `${JSON.stringify({ schemaVersion: DRAFT_SCHEMA_VERSION, mandate: id, request, recordedAt: new Date().toISOString(), ...(body as object) }, null, 2)}\n`;
  fs.mkdirSync(path.dirname(draftJson(root, id)), { recursive: true });
  fs.writeFileSync(draftJson(root, id), text);
  return createHash('sha256').update(text).digest('hex');
}

/** The backlog with the open item `old-item` the fixture reuses. */
export function seedBacklog(root: string, extra = ''): void {
  fs.writeFileSync(path.join(root, '.forge', 'backlog.md'), `# Backlog\n\n- [ ] Old item\n  Keep it short.\n${extra}`);
}

/**
 * A goal mandate `id` (extra `new` flags in `flags`) with its first draft request claimed and done and a
 * ready draft.json: the gate is pending. Returns the draft's request id and digest.
 */
export async function readyGoal(root: string, id: string, flags: string[] = [], body: unknown = MILESTONE_DRAFT): Promise<{ request: string; digest: string }> {
  const r = await forgeInProcess(root, ['mandate', 'new', id, '--title', id.toUpperCase(), '--goal', 'Halve review rounds', ...flags]);
  if (r.status !== 0) throw new Error(`mandate new ${id}: ${JSON.stringify(r.error)}`);
  const request = (r.data as { draft: { request: string } }).draft.request;
  claimRequest(root, request, 'office-1');
  ackRequest(root, request, { status: 'done', result: 'drafted' });
  return { request, digest: writeDraftFile(root, id, request, body) };
}

/** The gate requests for mandate `id`. */
export const gateRequests = (root: string, id: string) => listRequests(root).filter((r) => r.type === 'gate' && r.args?.mandate === id);
