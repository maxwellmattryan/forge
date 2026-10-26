// docs/CLI.md's Common commands table is what `npm run docs:commands` writes from the help tables, and every row matches
// `forge help`. Kept through the test rewrite (docs/test-rewrite/README.md): docs stay in sync with code
// (docs/TESTING.md › Allowed source-text tests, entry 6).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { BIN } from '../helpers.ts';
import { GROUPS, COMMON_END, COMMON_START, commonTable, syncCommonCommands } from '../../lib/cli/commands/help.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

type Run = { status: number | null; stdout: string; stderr: string };

/** The environment the CLI runs in: no inherited FORGE_DEBUG, which would add stacks to stderr. */
function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (!('FORGE_DEBUG' in extra)) delete env.FORGE_DEBUG;
  return env;
}

/** `forge <args>` without blocking the event loop. */
function spawnCli(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (err as any).code : 0;
      resolve({ status: typeof code === 'number' ? code : null, stdout, stderr });
    });
  });
}

/** `forge <args>` in an empty, non-git temp dir with no FORGE_ROOT: help needs neither. */
async function helpCli(...args: string[]): Promise<Run> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-help-'));
  try {
    const env = baseEnv();
    delete env.FORGE_ROOT;
    return await spawnCli(args, dir, env);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('Common commands table is generated from the help tables', async () => {
  const doc = read('docs/CLI.md');
  const start = doc.indexOf(COMMON_START);
  const end = doc.indexOf(COMMON_END);
  assert.ok(start >= 0 && end > start, 'docs/CLI.md has the generated region');
  const region = doc.slice(start + COMMON_START.length + 1, end).replace(/\n$/, '');
  assert.equal(region, commonTable());
  assert.equal(syncCommonCommands(doc), doc, 'npm run docs:commands would change nothing');

  const rows = region.split('\n').slice(2);
  assert.equal(rows.length, GROUPS.flatMap((g) => g.commands).filter((c) => c.common).length);
  assert.ok(rows.length >= 11);
  for (const row of rows) {
    // Cells are separated by ` | `; a pipe inside a cell is written `\|`, never with a space before it.
    const cells = row.slice(2, -2).split(' | ').map((c) => c.replace(/\\\|/g, '|'));
    assert.equal(cells.length, 2, row);
    const usage = cells[0].replace(/^`|`$/g, '');
    const summary = cells[1].replace(/ \(see \[[^\]]+\]\([^)]+\)\)$/, '');
    const words = usage.split(' ').slice(1, 3);
    const help = await helpCli('help', ...words);
    assert.equal(help.status, 0, usage);
    assert.ok(help.stdout.includes(usage), `forge help ${words.join(' ')} shows ${usage}`);
    assert.ok(help.stdout.includes(summary), `forge help ${words.join(' ')} shows its summary`);
  }
  // A doc without the markers is refused rather than silently left alone.
  assert.throws(() => syncCommonCommands('# no markers\n'), /no <!-- forge:commands:start/);
});
