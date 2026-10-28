// Forge's one browser MCP server, `forge-browser`: Playwright MCP pinned to one exact version, headless,
// with an in-memory profile, its requests limited to the job's loopback dev-server origins and its files
// written to the job's screenshots dir. Only a UI role of a spec with a UI acceptance criterion gets it
// (lib/engine/pipeline/brief.ts needsBrowser); docs/architecture/daemon-security.md lists what it leaves open.
import path from 'node:path';
import { ForgeError } from '#core/errors.ts';

/** The MCP server name: its tools are `mcp__forge-browser__<tool>`. */
export const BROWSER_SERVER = 'forge-browser';

/** The permission rule that allows every tool of the server, for a role child with no one to ask. */
export const BROWSER_RULE = `mcp__${BROWSER_SERVER}`;

/** An exact version, never a range or tag: npx fetches what this names. */
export const BROWSER_MCP_PACKAGE = '@playwright/mcp@0.0.83';

/**
 * The `--mcp-config` value declaring the browser for a job on `port`, writing to `outputDir`: one JSON
 * argv word built from an integer and a Forge path, so nothing from a job's files can add a server, a
 * flag or an origin. Throws on a port outside 1–65535 or an outputDir that is relative or holds NUL, CR or LF.
 */
export function browserMcpConfig({ port, outputDir }: { port: number; outputDir: string }): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ForgeError(`the browser's port must be an integer from 1 to 65535 (got ${JSON.stringify(port)})`);
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir) || /[\0\r\n]/.test(outputDir))
    throw new ForgeError(`the browser's output dir must be an absolute path without NUL, CR or LF (got ${JSON.stringify(String(outputDir).slice(0, 200))})`);
  const origins = `http://localhost:${port};http://127.0.0.1:${port}`;
  const args = ['-y', BROWSER_MCP_PACKAGE, '--headless', '--isolated', '--allowed-origins', origins, '--output-dir', outputDir];
  return JSON.stringify({ mcpServers: { [BROWSER_SERVER]: { type: 'stdio', command: 'npx', args } } });
}
