// The CLI's router called in-process: what a spawned `forge` would exit with and print as JSON,
// without starting a process. Import it through test/helpers.ts like the other support helpers.

/** What forgeInProcess resolves to: the exit status, the JSON a consumer would parse, and the error main would report. */
export interface InProcessResult {
  status: number;
  data: unknown;
  error: { code: string; message: string; exit: number; hint: string | null } | null;
}

// These print for themselves or are routed only by main(), so dispatch can't stand in for them.
const MAIN_ONLY = new Set(['config', 'dash', 'daemon', 'git', 'help', 'version', 'update']);

/**
 * One `forge <args>` call through `dispatch` (lib/cli.ts) against `root`, for per-case checks of
 * validation, refusal and formatting logic. It skips main()'s daemon trust check and output-mode
 * resolution, so a test of those spawns the CLI with forgeAsync.
 *
 * `opts.env` sets those keys on `process.env` for the call (an `undefined` value deletes one) and
 * restores them afterwards. A call with `env` must never run inside `describe(…, { concurrency })`
 * or beside a test that spawns the CLI, which would see the changed environment.
 */
export async function forgeInProcess(root: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<InProcessResult> {
  if (MAIN_ONLY.has(args[0]) || args.includes('--help') || args.includes('--mode')) {
    throw new Error(`forgeInProcess cannot run \`forge ${args.join(' ')}\`: it prints for itself or only main() routes it; use forgeAsync`);
  }
  // Loaded here, not at the top: test/helpers.ts re-exports this module, and most test files never
  // call it, so they shouldn't load the whole command graph.
  const [{ dispatch }, { loadConfig }, { toCliError }] = await Promise.all([import('../../lib/cli/main.ts'), import('../../lib/core/config/load.ts'), import('../../lib/cli/commands/help.ts')]);
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const { config, initialized } = loadConfig(root);
    const r = await dispatch(args, { root, config, initialized });
    return { status: r.exitCode ?? 0, data: JSON.parse(JSON.stringify(r.data ?? null)), error: null };
  } catch (err) {
    const error = toCliError(err, args);
    return { status: error.exit, data: null, error };
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
