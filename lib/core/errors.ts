// ForgeError, the CLI's error codes and the exit each code fixes. Imports nothing local, so every module
// can use it.

/**
 * The CLI's error codes and the exit each one fixes (docs/CLI.md "Error codes"). Scripts branch on
 * these, so renaming or removing one is a breaking change.
 */
export const ERROR_CODES = { failed: 1, not_found: 1, internal: 1, secret_found: 1, protected_path: 1, interim_stale: 1, release_gate: 1, human_only: 1, usage: 2, unknown_command: 2, not_initialized: 2, not_a_repo: 2, config_invalid: 2, owned: 3, stale_epoch: 3, blocked: 4, external: 5, docker_missing: 5, docker_stopped: 5 } as const;
export type ErrorCode = keyof typeof ERROR_CODES;
export type ExitCode = (typeof ERROR_CODES)[ErrorCode];
/** What each code means, as docs/CLI.md "Error codes" shows it (markdown; npm run docs:cli escapes `|`). */
export const ERROR_CODE_DOCS: Record<ErrorCode, string> = {
  failed: 'the default for exit 1: the command ran and failed, or refused by policy',
  not_found: 'no such job or request',
  internal: 'not a Forge error: a bug or an unexpected Node error (rerun with `FORGE_DEBUG=1` for the stack)',
  secret_found: 'the secret scanner found a likely credential in what Forge was about to commit or send (a commit, the PR title or body, a tracker write); the message shows it masked, with its fingerprint',
  protected_path:
    'a path the `policy.protectedPaths` policy refuses is in what `forge git add|commit` would stage or commit, `forge pr open` found a refused path or escalate paths no human approved, or `forge pr merge` finds a protected path at the live PR head that no human approved at that content (docs/CONFIG.md "Protected paths")',
  interim_stale:
    "`forge pr open` found a git-ref or canary pin in the checked commits that is not the dependency's checked HEAD (a hand-edited pin, or a dependency that moved without a verify), or, after a recorded release, a consumer manifest that does not name the released version yet; the hint is `forge verify <id>` (docs/CONFIG.md \"Interim strategies\")",
  release_gate:
    "`forge pr ready` targeted a consumer PR whose local or sequential dependency's release is not recorded (a human runs `forge job interim release <id> <name>|--root <version>`), or whose manifests don't name a recorded release yet (gate `bump-due`, or a HEAD that doesn't carry it: run `forge verify <id>`, then `forge pr open <id>`); nothing was called (docs/CONFIG.md \"Interim strategies\")",
  human_only:
    'a human-only operation (`forge pr merge --now`, `forge job budget --set|--ack`, `forge budget ack`) needs a person who confirms it at a terminal by typing the job id or period, or, for `pr merge --now`, the dashboard\'s Merge now and, for `budget ack`, its Acknowledge in Needs you (`job budget` has no dashboard route); a daemon session, an agent, a script or a configured command can\'t run it, and nothing was changed (docs/architecture/daemon-security.md "Human-only operations")',
  usage: 'the default for exit 2: the call could not be parsed; the hint names the help to read',
  unknown_command: 'the first word is not a command',
  not_initialized: 'the repo has no `.forge/config.yml`; run `/forge init`',
  not_a_repo: 'not inside a git repository, and `FORGE_ROOT` is unset',
  config_invalid: '`.forge/config.yml` cannot be parsed, or `forge init write` would write an invalid one',
  owned: 'another live session holds the job or request, or a tracker claim was lost',
  stale_epoch:
    "a write fenced with `--epoch N` (`forge job step|advance|set|claim|agent start|end`) found the job's lease at another epoch, or another driver, because another session took the job over: the caller must stop driving it. The check runs under the job lock before any write, so `job.json` is unchanged",
  blocked: "the job's dependencies are not done (`--force` claims anyway), or the repo budget holds new work (the message is the `repo budget: …` reason; a human runs `forge budget ack`)",
  external:
    'git, gh, claude or docker failed to start, exited non-zero, or ran past its timeout (`gh <subcommand> timed out after <n> s`; every gh call has one, 60 s by default); also gh output that is not JSON where JSON was asked for',
  docker_missing: 'a backing command needs Docker and `docker` is not on PATH',
  docker_stopped: 'a backing command needs Docker and its daemon does not answer',
};
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
