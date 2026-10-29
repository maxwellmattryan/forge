// browserMcpConfig: the one browser server Forge declares, its pinned package, loopback origins, absolute npx, PATH and empty npm prefix, its
// refusals, and the page tools a role child may call without one of them being the server's code-running tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeBin, tempRepo } from '../../../test/helpers.ts';
import { BROWSER_ALLOWED, BROWSER_DENIED, BROWSER_MCP_PACKAGE, BROWSER_SERVER, browserMcpConfig } from './browser.ts';

const posix = { skip: process.platform === 'win32' ? 'the fake npx is a shell script' : false };
const OUT = '/r/.forge/jobs/a b/screenshots';

/** A scratch main checkout with a .forge dir, and a fake `npx` on its own PATH. */
function rig(t: { after: (fn: () => void) => void }) {
  const repo = tempRepo();
  t.after(repo.cleanup);
  fs.mkdirSync(path.join(repo.dir, '.forge'));
  const npx = fakeBin('npx');
  return { root: repo.dir, npx, prefix: path.join(repo.dir, '.forge', 'runtime', 'browser') };
}

test('browserMcpConfig pins one loopback-only browser', posix, (t) => {
  const { root, npx, prefix } = rig(t);
  const json = browserMcpConfig({ root, port: 7412, outputDir: OUT, env: { PATH: npx.dir } });
  assert.equal(typeof json, 'string');
  assert.deepEqual(JSON.parse(json as string), {
    mcpServers: {
      'forge-browser': {
        type: 'stdio',
        command: npx.bin,
        args: ['-y', '--prefix', prefix, BROWSER_MCP_PACKAGE, '--headless', '--isolated', '--allowed-origins', 'http://localhost:7412;http://127.0.0.1:7412', '--output-dir', OUT],
        env: { PATH: npx.dir },
      },
    },
  });
  // An exact version: no range, tag or latest.
  assert.match(BROWSER_MCP_PACKAGE, /^@playwright\/mcp@\d+\.\d+\.\d+$/);
  assert.equal(BROWSER_SERVER, 'forge-browser');
  // The prefix is a real, empty dir: npm reads no .npmrc and finds no node_modules there.
  assert.deepEqual([fs.lstatSync(prefix).isDirectory(), fs.readdirSync(prefix)], [true, []]);

  for (const port of [0, -1, 65536, 1.5, Number.NaN, '7412' as unknown as number, null as unknown as number])
    assert.throws(() => browserMcpConfig({ root, port, outputDir: '/r/s', env: { PATH: npx.dir } }), /port must be an integer from 1 to 65535/, String(port));
  for (const outputDir of ['screenshots', './s', '', '/r/a\0b', '/r/a\rb', '/r/a\nb', null as unknown as string])
    assert.throws(() => browserMcpConfig({ root, port: 7412, outputDir, env: { PATH: npx.dir } }), /output dir must be an absolute path/, JSON.stringify(outputDir));
  assert.notEqual(browserMcpConfig({ root, port: 1, outputDir: '/s', env: { PATH: npx.dir } }), null);
  assert.notEqual(browserMcpConfig({ root, port: 65535, outputDir: '/s', env: { PATH: npx.dir } }), null);
});

test('browserMcpConfig runs only an npx found in an absolute PATH entry, with that PATH', posix, (t) => {
  const { root, npx } = rig(t);
  const decoy = fakeBin('npx');
  const want = (env: NodeJS.ProcessEnv) => {
    const json = browserMcpConfig({ root, port: 7412, outputDir: OUT, env });
    return json === null ? null : JSON.parse(json).mcpServers['forge-browser'];
  };
  // A relative or empty entry, which resolves against the worktree the child starts in, never finds the npx and never reaches the server's PATH.
  const relative = path.relative(process.cwd(), decoy.dir);
  const server = want({ PATH: ['', '.', relative, 'node_modules/.bin', npx.dir].join(path.delimiter) });
  assert.deepEqual([server.command, server.env], [npx.bin, { PATH: npx.dir }]);
  assert.equal(want({ PATH: ['', '.', relative, 'node_modules/.bin'].join(path.delimiter) }), null, 'only relative entries: no npx');
  assert.equal(want({}), null, 'no PATH');
  // An npx that is not an executable file is no npx.
  const plain = fakeBin('npx');
  fs.chmodSync(plain.bin, 0o644);
  assert.equal(want({ PATH: plain.dir }), null, 'not executable');
  fs.rmSync(plain.bin);
  fs.mkdirSync(plain.bin);
  assert.equal(want({ PATH: plain.dir }), null, 'a directory');
});

test('browserMcpConfig gives no browser when the prefix dir is not a real directory', posix, (t) => {
  const { root, npx, prefix } = rig(t);
  const env = { PATH: npx.dir };
  // A link at the prefix would let npm read the .npmrc and node_modules of wherever it points.
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  fs.symlinkSync(root, prefix);
  assert.equal(browserMcpConfig({ root, port: 7412, outputDir: OUT, env }), null, 'a link');
  fs.rmSync(prefix);
  assert.notEqual(browserMcpConfig({ root, port: 7412, outputDir: OUT, env }), null, 'a real directory is made again');
  assert.equal(browserMcpConfig({ root: path.join(root, 'no-such-root'), port: 7412, outputDir: OUT, env }), null, 'no .forge dir');
});

test("a role child's browser rules are named page tools, and the code-running tool is denied", () => {
  for (const rule of BROWSER_ALLOWED) assert.match(rule, /^mcp__forge-browser__browser_[a-z_]+$/, `${rule}: one named tool, never the server or a wildcard`);
  assert.equal(new Set(BROWSER_ALLOWED).size, BROWSER_ALLOWED.length);
  assert.deepEqual(BROWSER_DENIED, ['mcp__forge-browser__browser_run_code_unsafe']);
  assert.deepEqual(
    BROWSER_ALLOWED.filter((rule) => BROWSER_DENIED.includes(rule)),
    [],
    'nothing is both',
  );
  assert.ok(BROWSER_ALLOWED.includes('mcp__forge-browser__browser_navigate') && BROWSER_ALLOWED.includes('mcp__forge-browser__browser_take_screenshot'), 'the tools the UI roles use');
});
