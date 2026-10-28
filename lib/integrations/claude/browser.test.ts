// browserMcpConfig: the one browser server Forge declares, its pinned package, loopback origins and output dir, and its refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_MCP_PACKAGE, BROWSER_RULE, BROWSER_SERVER, browserMcpConfig } from './browser.ts';

test('browserMcpConfig pins one loopback-only browser', () => {
  const json = browserMcpConfig({ port: 7412, outputDir: '/r/.forge/jobs/a b/screenshots' });
  assert.equal(typeof json, 'string');
  assert.deepEqual(JSON.parse(json), {
    mcpServers: {
      'forge-browser': {
        type: 'stdio',
        command: 'npx',
        args: ['-y', BROWSER_MCP_PACKAGE, '--headless', '--isolated', '--allowed-origins', 'http://localhost:7412;http://127.0.0.1:7412', '--output-dir', '/r/.forge/jobs/a b/screenshots'],
      },
    },
  });
  // An exact version: no range, tag or latest.
  assert.match(BROWSER_MCP_PACKAGE, /^@playwright\/mcp@\d+\.\d+\.\d+$/);
  assert.deepEqual([BROWSER_SERVER, BROWSER_RULE], ['forge-browser', 'mcp__forge-browser']);

  for (const port of [0, -1, 65536, 1.5, Number.NaN, '7412' as unknown as number, null as unknown as number])
    assert.throws(() => browserMcpConfig({ port, outputDir: '/r/s' }), /port must be an integer from 1 to 65535/, String(port));
  for (const outputDir of ['screenshots', './s', '', '/r/a\0b', '/r/a\rb', '/r/a\nb', null as unknown as string])
    assert.throws(() => browserMcpConfig({ port: 7412, outputDir }), /output dir must be an absolute path/, JSON.stringify(outputDir));
  assert.doesNotThrow(() => browserMcpConfig({ port: 1, outputDir: '/s' }));
  assert.doesNotThrow(() => browserMcpConfig({ port: 65535, outputDir: '/s' }));
});
