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
  'docs/architecture/daemon-runtime.md': { words: 5857, topic: 7157, reason: '#693: runtime topic, becomes a folder with an index' },
  'docs/architecture/daemon-security.md': { words: 9657, topic: 12131, reason: '#692: security topic, becomes a folder with an index' },
  'docs/architecture/dashboard-security.md': { words: 5655, topic: 6099, reason: '#692: security topic, becomes a folder with an index' },
  'docs/architecture/foreman.md': { words: 9512, topic: 12088, reason: '#693: runtime topic, becomes a folder with an index' },
  'docs/architecture/untrusted-input.md': { words: 3787, topic: 8199, reason: '#692: security topic, becomes a folder with an index' },
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
