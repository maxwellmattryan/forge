// findPr never adopts a fork's PR, even on the job's own branch: untrusted code must not become the
// job's PR (docs/ARCHITECTURE.md "Untrusted input"). Kept through the test rewrite
// (docs/test-rewrite/README.md): the security posture AGENTS.md says to preserve.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { findPr } from './adopt.ts';
import { defaults } from '#core/config/load.ts';
import { claimJob, createJob, loadJob, setJob, readEvents } from '#core/job/store.ts';

// A stand-in `gh` on PATH: answers `pr view` from env, records every call, and can fail `pr merge`.
const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "pr view") printf '{"number":7,"url":"https://github.com/o/r/pull/7","state":"%s","isDraft":false,"headRefOid":"%s","mergeable":"%s","mergeStateStatus":"%s","reviewDecision":"","statusCheckRollup":%s,"mergedAt":null,"closedAt":null,"headRefName":"%s","baseRefName":"%s"}' "$FAKE_PR_STATE" "\${FAKE_HEAD_OID:-abc123}" "\${FAKE_MERGEABLE:-MERGEABLE}" "$FAKE_MERGE_STATE" "$FAKE_ROLLUP" "\${FAKE_HEAD_REF:-forge/x}" "\${FAKE_BASE_REF:-main}" ;;
  "pr list") printf '[{"number":7,"url":"https://github.com/o/r/pull/7","state":"OPEN","isDraft":false,"isCrossRepository":%s,"headRefName":"%s","baseRefName":"%s"}]' "\${FAKE_CROSS:-false}" "\${FAKE_HEAD_REF:-forge/x}" "\${FAKE_BASE_REF:-main}" ;;
  "repo view") echo o/r ;;
  "api graphql") echo '{"data":{"repository":{"pullRequest":{}}}}' ;;
  "pr merge") if [ -n "$FAKE_MERGE_FAIL" ]; then echo "auto-merge is not allowed" >&2; exit 1; fi ;;
  "issue comment") cat >> "$FAKE_GH_LOG.body" ;;
esac
`;

const ROLLUP = {
  passing: [{ conclusion: 'SUCCESS' }],
  pending: [{ status: 'IN_PROGRESS' }],
  failing: [{ conclusion: 'FAILURE' }],
  none: [],
};

function ghHarness() {
  const repo = tempRepo();
  const bin = path.join(repo.dir, '..', `fakebin-${path.basename(repo.dir)}`);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const log = path.join(bin, 'calls.log');
  const saved = { ...process.env };
  const config = defaults();
  config.tracker.github.repo = 'o/r';
  let n = 0;
  // mergeable/head are what gh reports; pushedSha, at and owner are the job's own state.
  const scenario = ({
    state = 'OPEN',
    checks = 'passing' as keyof typeof ROLLUP,
    mergeState = 'CLEAN',
    fail = false,
    mergeable = '',
    head = '',
    pushedSha = undefined as string | undefined,
    at = undefined as { stage: string; state: string; waitingOn?: string } | undefined,
    owner = undefined as string | undefined,
  } = {}) => {
    const job = createJob(repo.dir, config, { title: `job ${++n}`, issues: [{ tracker: config.tracker.kind, ref: `${n}`, url: null }] });
    setJob(repo.dir, job.id, { owned: { pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', ...(pushedSha !== undefined ? { pushedSha } : {}) } } });
    if (at) setJob(repo.dir, job.id, at);
    if (owner) claimJob(repo.dir, job.id, owner);
    fs.writeFileSync(log, '');
    Object.assign(process.env, {
      PATH: `${bin}${path.delimiter}${saved.PATH}`,
      FAKE_GH_LOG: log,
      FAKE_PR_STATE: state,
      FAKE_MERGE_STATE: mergeState,
      FAKE_ROLLUP: JSON.stringify(ROLLUP[checks]),
      FAKE_MERGE_FAIL: fail ? '1' : '',
      FAKE_MERGEABLE: mergeable,
      FAKE_HEAD_OID: head,
    });
    return job.id;
  };
  const done = () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(bin, { recursive: true, force: true });
    repo.cleanup();
  };
  return { repo, config, scenario, done };
}

test("findPr never adopts a fork PR on the job's branch", { skip: process.platform === 'win32' }, () => {
  const h = ghHarness();
  try {
    const root = h.repo.dir;
    const id = h.scenario();
    // No recorded PR, so the lookup goes by branch, and gh lists only a fork's PR on it.
    setJob(root, id, { owned: { pr: null } });
    process.env.FAKE_CROSS = 'true';
    assert.equal(findPr(root, h.config, id), null);
    assert.equal(loadJob(root, id).pr, null);
    const evs = readEvents(root, id);
    assert.ok(evs.some((e) => e.type === 'pr-find' && e.found === false));
    assert.ok(!evs.some((e) => e.type === 'pr-adopted'));
  } finally {
    h.done();
  }
});
