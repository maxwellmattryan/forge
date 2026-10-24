// What a configured command inherits (docs/CONFIG.md "Command environment"): an allowlist of the
// Forge process's environment that every spawn site builds on, and the shell argv it runs under. The
// job's own code runs through these before any reviewer reads it, so credentials, start-up files and
// the login profile stay out of it, in and out of the daemon alike.
import { posixShell } from '#core/os/platform.ts';
import type { PosixShellOptions } from '#core/os/platform.ts';
import { inheritEntryProblem } from '#core/config/validators/command-env.ts';
import type { CommandEnvConfig, Config } from '#core/types.ts';
import { COMMAND_PATH_ENV, sanitizePath } from './command-path.ts';

// The daemon's trust check guards the session's own `forge` calls; a configured command that
// calls `forge` (a test suite on scratch repos) must behave as it does for a human.
const DAEMON_MARKER = /^FORGE_DAEMON(_|$)/;
// An outer job's per-component and backing variables would otherwise reach a nested job's
// commands (the suite run by `forge verify` driving scratch jobs) beside that job's own.
const JOB_VARS = /^FORGE_(PORT|ENDPOINT|BACKING)_/;
// The captured PATH lives only in Forge's own environment: a command that got it could not change
// it, but a nested `forge` would take it over the PATH the command chose.
const COMMAND_PATH_VARS = /^FORGE_COMMAND_PATH(_SOURCE)?$/;

/** Names every command gets, compared exactly (case-insensitively on win32). */
export const ALLOW_EXACT: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'CI',
  'GIT_CONFIG_COUNT', 'GIT_EDITOR', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_DIRS', 'XDG_DATA_DIRS',
  // Windows essentials: a process without them can't find its own system dirs. Absent elsewhere.
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'MSYSTEM',
]);

/**
 * Families every command gets, minus a credential-like name: locale, the git pins sessionEnv sets
 * (lib/integrations/claude/argv.ts), Node's settings but NODE_OPTIONS (it can `--require` any file),
 * and Forge's own but the internal variables above.
 */
export const ALLOW_PATTERNS: readonly RegExp[] = [/^LC_/, /^GIT_CONFIG_(KEY|VALUE)_\d+$/, /^NODE_(?!OPTIONS$)/, /^FORGE_/];

const CREDENTIAL_LIKE = [/_(TOKEN|KEY|PAT|AUTH)$/, /PASSWORD|PASSWD|ACCESS_KEY/, /(^|_)SECRET/, /(^|_)CREDENTIALS?(_|$)/, /^OP_SESSION_/];

/** Whether `name`, in any letter case, looks like it holds a credential: no pattern or glob ever passes one. */
export function credentialLike(name: string): boolean {
  const upper = name.toUpperCase();
  return CREDENTIAL_LIKE.some((re) => re.test(upper));
}

const fold = (name: string, platform: NodeJS.Platform) => (platform === 'win32' ? name.toUpperCase() : name);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** An inherit glob as an anchored RegExp: `*` is any run of characters (`**` too, so no `.*.*`), everything else literal. */
const globRe = (glob: string, platform: NodeJS.Platform) => new RegExp(`^${glob.replace(/\*+/g, '*').split('*').map(escapeRe).join('.*')}$`, platform === 'win32' ? 'i' : '');

/**
 * Whether commandEnv.inherit passes `name`: an entry without `*` names it exactly; one with `*`
 * (any run of characters, whole name) passes only names that are not credential-like. Entries
 * validation refuses (a bare `*`, non-strings) are ignored here too.
 */
export function inheritMatcher(entries: unknown, platform: NodeJS.Platform = process.platform): (name: string) => boolean {
  const valid = (Array.isArray(entries) ? entries : []).filter((e): e is string => inheritEntryProblem(e) === null);
  const exact = new Set(valid.filter((e) => !e.includes('*')).map((e) => fold(e, platform)));
  const globs = valid.filter((e) => e.includes('*')).map((e) => globRe(e, platform));
  return (name) => exact.has(fold(name, platform)) || (globs.some((re) => re.test(name)) && !credentialLike(name));
}

/** The source variable of every declared `env` secret, malformed entries included: strip more, never less. */
function envSources(config: Pick<Config, 'secrets'>): string[] {
  const all: unknown = config?.secrets;
  if (!all || typeof all !== 'object') return [];
  const out: string[] = [];
  for (const entry of Object.values(all)) {
    const env = entry && typeof entry === 'object' ? (entry as { env?: unknown }).env : undefined;
    if (typeof env === 'string') out.push(env);
  }
  return out;
}

/** The config commandEnv reads: secrets for their sources, and commandEnv for inherit. */
export type CommandEnvSource = Pick<Config, 'secrets'> & { commandEnv?: Partial<CommandEnvConfig> | null };

/** How commandEnv sorts each name of an environment. */
function classifier(config: CommandEnvSource, platform: NodeJS.Platform) {
  const sources = new Set(envSources(config).map((k) => fold(k, platform)));
  const inherited = inheritMatcher(config?.commandEnv?.inherit, platform);
  return {
    /** Never passed, whatever matches: internal variables and declared secret sources. */
    never: (k: string) => {
      const f = fold(k, platform);
      return DAEMON_MARKER.test(f) || JOB_VARS.test(f) || COMMAND_PATH_VARS.test(f) || sources.has(f);
    },
    allowed: (k: string) => {
      const f = fold(k, platform);
      return ALLOW_EXACT.has(f) || (ALLOW_PATTERNS.some((re) => re.test(f)) && !credentialLike(k));
    },
    inherited,
  };
}

/**
 * A configured command's inherited environment, the same in and out of the daemon: only the
 * allowlist (ALLOW_EXACT, ALLOW_PATTERNS) and what commandEnv.inherit names, never an internal
 * variable or a declared secret's source (a sink passes the value). PATH is FORGE_COMMAND_PATH when
 * set, else base's own, sanitised (sanitizePath). Callers add the job's own variables after it,
 * unfiltered. Names fold on win32, where the original spelling is kept. `base` is never mutated.
 */
export function commandEnv(config: CommandEnvSource, base: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const c = classifier(config, platform);
  const env: NodeJS.ProcessEnv = {};
  let pathKey: string | null = null;
  let captured: string | undefined;
  for (const k of Object.keys(base)) {
    const v = base[k];
    if (v === undefined) continue;
    const f = fold(k, platform);
    if (f === COMMAND_PATH_ENV) captured = v;
    if (c.never(k)) continue;
    if (f === 'PATH') {
      pathKey ??= k;
      continue;
    }
    if (c.allowed(k) || c.inherited(k)) env[k] = v;
  }
  const value = captured ?? (pathKey === null ? undefined : base[pathKey]);
  if (value !== undefined) env[pathKey ?? 'PATH'] = sanitizePath(value, platform);
  return env;
}

/** Whether configured commands run under the login shell: only `commandEnv.loginShell: true`. */
export function loginShell(config: { commandEnv?: Partial<CommandEnvConfig> | null } | null | undefined): boolean {
  return config?.commandEnv?.loginShell === true;
}

export interface CommandShellOptions extends Pick<PosixShellOptions, 'where' | 'exists'> {
  /** Where posixShell is resolved from: the Forge process's own environment, never the command's. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** true: `posixShell() -lc`, sourcing the login profile (loginShell(config); `forge release run`). */
  login?: boolean;
}

/**
 * The program and arguments a configured command runs under: `/bin/sh -c` off Windows and Git for
 * Windows' sh (posixShell) with `-c` there, so no login profile, `.zshenv`, BASH_ENV or ENV file is
 * sourced; `posixShell() -lc` with `login: true`. FORGE_DAEMON and $SHELL play no part in the default.
 */
export function commandShell(cmd: string, opts: CommandShellOptions = {}): { file: string; args: string[] } {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const sh = () => posixShell({ env, platform, where: opts.where, exists: opts.exists });
  if (opts.login === true) return { file: sh(), args: ['-lc', cmd] };
  if (platform !== 'win32') return { file: '/bin/sh', args: ['-c', cmd] };
  return { file: sh(), args: ['-c', cmd] };
}

/** Variables configured commands are likely to need for a build, matched case-insensitively. */
export const BUILD_LIKE: ReadonlySet<string> = new Set([
  'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_NDK_HOME', 'GRADLE_USER_HOME', 'MAVEN_HOME', 'M2_HOME',
  'CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN', 'GOPATH', 'GOROOT', 'GOFLAGS', 'GOPROXY',
  'PYENV_ROOT', 'PYENV_VERSION', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'NVM_DIR', 'VOLTA_HOME', 'PNPM_HOME', 'BUN_INSTALL', 'DENO_DIR', 'DOTNET_ROOT', 'SDKMAN_DIR',
  'NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
  'DATABASE_URL', 'REDIS_URL', 'SSH_AUTH_SOCK', 'DOCKER_HOST', 'CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'PKG_CONFIG_PATH',
]);

const buildLike = (name: string) => {
  const upper = name.toUpperCase();
  return BUILD_LIKE.has(upper) || (/_(HOME|ROOT)$/.test(upper) && !credentialLike(name));
};

/**
 * The names in `env` that commandEnv drops and that look like build settings, sorted: what forge
 * doctor suggests for commandEnv.inherit. Names only, never values; internal variables and declared
 * secret sources are never listed.
 */
export function droppedVariables(config: CommandEnvSource, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const c = classifier(config, platform);
  const out = new Set<string>();
  for (const k of Object.keys(env)) {
    if (env[k] === undefined || c.never(k) || fold(k, platform) === 'PATH' || c.allowed(k) || c.inherited(k)) continue;
    if (buildLike(k)) out.add(k);
  }
  return [...out].sort();
}
