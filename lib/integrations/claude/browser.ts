// Forge's one browser MCP server, `forge-browser`: Playwright MCP pinned to one exact version, headless, with an
// in-memory profile and its requests limited to the job's loopback dev-server origins. It starts from an absolute
// `npx` on a PATH of absolute entries, with an empty Forge-owned dir as npm's prefix, so no file a branch wrote
// chooses what runs. Only a UI role of a spec with a UI acceptance criterion gets it
// (lib/engine/pipeline/brief.ts needsBrowser); docs/architecture/daemon-security.md lists what it leaves open.
import fs from 'node:fs';
import path from 'node:path';
import { ForgeError } from '#core/errors.ts';
import { confinedDir } from '#core/os/fs.ts';
import { paths } from '#core/paths.ts';

/** The MCP server name: its tools are `mcp__forge-browser__<tool>`. */
export const BROWSER_SERVER = 'forge-browser';

const tool = (name: string): string => `mcp__${BROWSER_SERVER}__${name}`;

/**
 * The page tools a role child may call with no one to ask: look at a page, move around it and fill in its forms.
 * Never the server-wide rule: Playwright MCP also ships `browser_run_code_unsafe`, arbitrary JavaScript in its own
 * server process, and `browser_evaluate`, `browser_file_upload` and `browser_install`, which prompt, so a role child
 * (which has no one to answer) is denied them.
 */
export const BROWSER_ALLOWED: readonly string[] = Object.freeze(
  [
    'browser_navigate',
    'browser_navigate_back',
    'browser_snapshot',
    'browser_take_screenshot',
    'browser_click',
    'browser_type',
    'browser_fill_form',
    'browser_hover',
    'browser_press_key',
    'browser_select_option',
    'browser_resize',
    'browser_wait_for',
    'browser_console_messages',
    'browser_network_requests',
    'browser_tabs',
    'browser_handle_dialog',
    'browser_close',
  ].map(tool),
);

/**
 * Denied in every session that gets the server, appended to `--disallowedTools` whatever else allows it. Playwright MCP
 * 0.0.83's README calls `browser_run_code_unsafe` "RCE-equivalent": code in the server process runs outside every
 * write root, deny rule and hook, in the session's environment, and leaves no file in the job's diff.
 */
export const BROWSER_DENIED: readonly string[] = Object.freeze([tool('browser_run_code_unsafe')]);

/** An exact version, never a range or tag: npx fetches what this names. */
export const BROWSER_MCP_PACKAGE = '@playwright/mcp@0.0.83';

/** `env`'s PATH without its empty and relative entries: sanitizePath's rule (lib/engine/guard/command-env.ts), which an integration can't import. */
function absoluteDirs(env: NodeJS.ProcessEnv): string[] {
  return String(env.PATH ?? env.Path ?? '')
    .split(path.delimiter)
    .filter((dir) => dir !== '' && path.isAbsolute(dir) && !/[\0\r\n]/.test(dir));
}

/** The first executable file named `npx` (`npx.cmd` on Windows) in `dirs`, or null. */
function findNpx(dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    const file = path.join(dir, process.platform === 'win32' ? 'npx.cmd' : 'npx');
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {}
  }
  return null;
}

/**
 * The `--mcp-config` value declaring the browser for a job on `port`, writing automatically named files (a
 * screenshot with no `filename`) to `outputDir`: one JSON argv word built from an integer, Forge paths and
 * the PATH of `env` (the environment the session starts with), so nothing from a job's files can add a server,
 * a flag or an origin. The server runs `<npx> -y --prefix <.forge/runtime/browser> <package> …` with that PATH
 * as its own: `npx` is found only in absolute PATH entries, and the empty prefix dir makes npm read no `.npmrc`
 * (`script-shell`, `node-options`, `registry` and `cache` included) and no `node_modules` of the worktree it
 * starts in. Null when no `npx` is on that PATH or the prefix dir can't be made: the role runs without a browser.
 * Throws on a port outside 1–65535 or an outputDir that is relative or holds NUL, CR or LF.
 */
export function browserMcpConfig({ root, port, outputDir, env }: { root: string; port: number; outputDir: string; env: NodeJS.ProcessEnv }): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ForgeError(`the browser's port must be an integer from 1 to 65535 (got ${JSON.stringify(port)})`);
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir) || /[\0\r\n]/.test(outputDir))
    throw new ForgeError(`the browser's output dir must be an absolute path without NUL, CR or LF (got ${JSON.stringify(String(outputDir).slice(0, 200))})`);
  const dirs = absoluteDirs(env);
  const npx = findNpx(dirs);
  if (npx === null) return null;
  let prefix: string;
  try {
    const p = paths(root);
    prefix = confinedDir(p.dir, path.join(p.runtime, 'browser'));
  } catch {
    return null;
  }
  const origins = `http://localhost:${port};http://127.0.0.1:${port}`;
  const args = ['-y', '--prefix', prefix, BROWSER_MCP_PACKAGE, '--headless', '--isolated', '--allowed-origins', origins, '--output-dir', outputDir];
  return JSON.stringify({ mcpServers: { [BROWSER_SERVER]: { type: 'stdio', command: npx, args, env: { PATH: dirs.join(path.delimiter) } } } });
}
