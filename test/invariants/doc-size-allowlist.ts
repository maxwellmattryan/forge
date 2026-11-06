// The agent-facing docs over the doc-size caps today (test/invariants/doc-size.test.ts). `words` pins the
// total words of a file's paragraphs over the 250-word cap; `topic` pins an architecture topic's word count
// over the 6,000-word cap. Each pin is a ceiling: the file may shrink below it, never grow past it. The list
// only shrinks: `npm run check:touchpoints` (rule doc-size-allowlist) fails a diff that adds an entry, raises
// a pin or adds a pin field. Keep one entry per line, in exactly the form ALLOWLIST_ENTRY in
// scripts/check-touchpoints.ts reads: fields in the order words, topic, reason, the reason in single quotes.

export interface DocAllowance {
  words?: number;
  topic?: number;
  reason: string;
}

export const DOC_ALLOWED: Record<string, DocAllowance> = {
  'docs/ARCHITECTURE.md': { words: 339, reason: '#694: a long index paragraph, split into a list' },
  'docs/CI.md': { words: 442, reason: '#694: the workflow-tests paragraph, split into a list' },
  'docs/DASHBOARD.md': { words: 4176, reason: '#694: page reference list items, split into sub-items' },
  'docs/IMPROVEMENT.md': { words: 555, reason: '#694: long reference paragraphs, split into lists' },
  'docs/RELEASES.md': { words: 1297, reason: '#694: release pipeline paragraphs, split into lists' },
  'docs/TESTING.md': { words: 421, reason: '#694: a long reference paragraph, split into a list' },
  'docs/TRACKERS.md': { words: 264, reason: '#694: a long reference paragraph, split into a list' },
  'docs/architecture/audit-trail.md': { words: 263, reason: '#694: a long topic paragraph, split into a list' },
  'docs/architecture/cli-bookkeeping.md': { words: 755, reason: '#694: long topic paragraphs, split into lists' },
  'docs/architecture/daemon-runtime.md': { words: 5857, topic: 7157, reason: '#693: runtime topic, becomes a folder with an index' },
  'docs/architecture/daemon-security.md': { words: 9657, topic: 12131, reason: '#692: security topic, becomes a folder with an index' },
  'docs/architecture/daemon.md': { words: 3109, reason: '#694: long topic paragraphs, split into lists' },
  'docs/architecture/dashboard-security.md': { words: 5655, topic: 6099, reason: '#692: security topic, becomes a folder with an index' },
  'docs/architecture/foreman.md': { words: 9512, topic: 12088, reason: '#693: runtime topic, becomes a folder with an index' },
  'docs/architecture/job-model.md': { words: 3186, reason: '#694: long topic paragraphs, split into lists' },
  'docs/architecture/job-repos.md': { words: 987, reason: '#694: long topic paragraphs, split into lists' },
  'docs/architecture/policies.md': { words: 2055, reason: '#694: long topic paragraphs, split into lists' },
  'docs/architecture/release-security.md': { words: 580, reason: '#694: long topic paragraphs, split into lists' },
  'docs/architecture/startup-cache.md': { words: 699, reason: '#694: long topic paragraphs, split into lists' },
  'docs/architecture/untrusted-input.md': { words: 3787, topic: 8199, reason: '#692: security topic, becomes a folder with an index' },
  'docs/design/agentic-pipeline-audit.md': { words: 1609, reason: '#694: long design paragraphs, split into lists' },
  'docs/test-rewrite/modules/core.config.md': { words: 900, reason: '#694: inventory table rows, split into shorter rows' },
  'docs/test-rewrite/modules/dashboard.lib.md': { words: 271, reason: '#694: an inventory table row, split into shorter rows' },
  'docs/test-rewrite/modules/engine.environment.md': { words: 302, reason: '#694: an inventory table row, split into shorter rows' },
  'docs/test-rewrite/modules/engine.evals.md': { words: 256, reason: '#694: an inventory table row, split into shorter rows' },
  'docs/test-rewrite/modules/engine.guard.md': { words: 549, reason: '#694: inventory table rows, split into shorter rows' },
  'docs/test-rewrite/modules/engine.pipeline.md': { words: 538, reason: '#694: inventory table rows, split into shorter rows' },
  'docs/test-rewrite/modules/engine.pr.md': { words: 841, reason: '#694: inventory table rows, split into shorter rows' },
  'docs/test-rewrite/modules/repo.invariants.md': { words: 548, reason: '#694: inventory table rows, split into shorter rows' },
  'docs/test-rewrite/modules/scripts.md': { words: 256, reason: '#694: an inventory table row, split into shorter rows' },
  'lib/integrations/claude/AGENTS.md': { words: 324, reason: '#694: a long folder-guide paragraph, split into a list' },
  'skills/forge/reference/pr-lifecycle.md': { words: 1085, reason: '#694: long skill reference paragraphs, split into lists' },
  'skills/forge/reference/requests.md': { words: 485, reason: '#694: long skill reference paragraphs, split into lists' },
};
