// ForgeError, the CLI's error codes and the exit each code fixes. Imports nothing local, so every module
// can use it.

/**
 * The CLI's error codes and the exit each one fixes (docs/CLI.md "Error codes"). Scripts branch on
 * these, so renaming or removing one is a breaking change.
 */
export const ERROR_CODES = { failed: 1, not_found: 1, internal: 1, secret_found: 1, protected_path: 1, interim_stale: 1, release_gate: 1, usage: 2, unknown_command: 2, not_initialized: 2, not_a_repo: 2, config_invalid: 2, owned: 3, stale_epoch: 3, blocked: 4, external: 5, docker_missing: 5, docker_stopped: 5 } as const;
export type ErrorCode = keyof typeof ERROR_CODES;
export type ExitCode = (typeof ERROR_CODES)[ErrorCode];
/** The code a bare exit number means, so `new ForgeError(msg, 3)` written before codes existed keeps working. */
export const DEFAULT_CODE: Record<ExitCode, ErrorCode> = { 1: 'failed', 2: 'usage', 3: 'owned', 4: 'blocked', 5: 'external' };

export class ForgeError extends Error {
  // `declare` keeps these types only: a plain field would become a runtime class field and show up in Object.keys.
  declare code: ErrorCode;
  declare exitCode: ExitCode;
  /** A next command to run, shown under `--json`; null when the message says it all. */
  declare hint: string | null;
  constructor(message: string, code: ErrorCode | ExitCode = 'failed', hint: string | null = null, options?: ErrorOptions) {
    super(message, options);
    this.code = typeof code === 'number' ? (DEFAULT_CODE[code] ?? 'failed') : code;
    this.exitCode = ERROR_CODES[this.code];
    this.hint = hint;
  }
}
