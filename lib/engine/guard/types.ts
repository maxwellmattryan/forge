// The secret scanner's and the redactor's shapes, type-only: SecretKind derives from SECRET_KINDS in secrets.ts.
import type { SECRET_KINDS } from './secrets.ts';

/** What the secret scanner reports: SECRET_KINDS in lib/engine/guard/secrets.ts. */
export type SecretKind = (typeof SECRET_KINDS)[number];

/** Text the scanner reads: a run of added lines, a whole file, or text Forge is about to send. */
export interface TextUnit {
  /** A repo path, a job-dir path, or a label in parentheses such as `(pr body)`. */
  path: string;
  /** The line `text` starts on. */
  line: number;
  text: string;
  /** Repository content: path globs in the allowlist apply, and so does the entropy check. */
  file: boolean;
  /** 12-char sha, `staged`, or null. */
  commit: string | null;
  /** Overrides the entropy check, which otherwise follows `file` (agent output is text, but checked). */
  entropy?: boolean;
}

/** One likely credential. Never holds the value: `excerpt` is masked and `fingerprint` is its sha256. */
export interface SecretFinding {
  kind: SecretKind;
  path: string;
  line: number;
  excerpt: string;
  /** `sha256:` + 64 hex of the full value; for a `known-secret`, `known:` + 12 hex keyed per process, never the value's hash. */
  fingerprint: string;
  commit: string | null;
  /** `.forge/secrets-allow.txt:<line>`, on an allowed finding. */
  allowedBy?: string;
}

/** `.forge/secrets-allow.txt` in the main checkout: loadAllowlist. */
export interface SecretAllowlist {
  file: string;
  present: boolean;
  entries: number;
  problems: string[];
  globs: { glob: string; line: number }[];
  prints: Map<string, number>;
}

/** A scan's result: scanBranch, scanPaths, scanAgentOutputs. `error` means it did not finish. */
export interface SecretScan {
  findings: SecretFinding[];
  allowed: SecretFinding[];
  scanned: { commits: number; files: number; texts: number; skipped: number };
  allowlist: SecretAllowlist;
  base: string | null;
  mergeBase: string | null;
  error?: string;
}

/** The `secrets` key of verify's JSON: compactSecrets. */
export interface CompactSecrets {
  mode: 'block' | 'warn';
  ok: boolean;
  count: number;
  allowed: number;
  findings: { kind: SecretKind; path: string; line: number }[];
  more: number;
  error?: string;
}

/** How many spans of each class lib/engine/guard/redact.ts replaced. */
export interface RedactCounts {
  secrets: number;
  paths: number;
  emails: number;
  logins: number;
}
