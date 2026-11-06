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
  'docs/architecture/foreman.md': { words: 9512, topic: 12088, reason: '#693: runtime topic, becomes a folder with an index' },
};
