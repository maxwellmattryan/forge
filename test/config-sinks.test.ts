// Config sinks (components[].config): validation, the v19 migration, expressions and the renderers.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, tempRepo } from './helpers.ts';
import { componentProblems } from '../lib/components.ts';
import { loadConfig, validateConfig } from '../lib/config.ts';
import { EXPRESSION_ROOTS, fillTemplate, renderEnvFile, renderMerge, renderTemplate, resolveString, resolveValue, sinkProblems } from '../lib/config-sinks.ts';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../lib/schema.ts';
import * as yaml from '../lib/yaml.ts';

const CTX = { job: 'j1', port: 4123, worktree: '/wt/j1', branch: 'forge/j1', base: 'main', component: { name: 'api', path: 'services/api', dir: '/wt/j1/services/api' } };
const NO_PORT = { ...CTX, port: null };

const VALID = [
  { env: { PORT_HTTP: '{port}', API_BASE: 'http://localhost:{port}' } },
  { 'env-file': '.env.local', values: { JOB_ID: '{job}' } },
  { file: { path: 'config.json', format: 'json', mode: 'merge', from: 'config.example.json' }, values: { server: { port: '{port}', name: '{job}' } } },
  { file: { path: 'app.toml', format: 'toml', mode: 'template', from: 'app.toml.template' } },
  { command: 'node scripts/write-config.mjs', values: { PORT_HTTP: '{port}' } },
];

const component = (config: unknown, extra: Record<string, unknown> = {}) => ({ name: 'api', path: 'services/api', kind: 'service', config, ...extra });
const problems = (config: unknown, extra: Record<string, unknown> = {}) => componentProblems({ components: [component(config, extra)] });

describe('config sinks validation', { concurrency: 4 }, () => {
  test('validation reports each malformed sink', () => {
    const at = 'components "api".config';
    const one = (sink: unknown) => problems([sink]);
    const has = (list: string[], re: RegExp) => assert.ok(list.some((p) => re.test(p)), `${re} in:\n${list.join('\n')}`);
    has(problems('nope'), /^components "api"\.config must be a list/);
    has(one({}), new RegExp(`^${at.replace(/[."]/g, '\\$&')}\\[0\\] must be a map with exactly one of env \\| env-file \\| file \\| command`));
    has(one({ env: {}, command: 'x' }), /\[0\] must be a map with exactly one of/);
    has(one('text'), /\[0\] must be a map with exactly one of/);
    for (const p of ['/abs', '', '../up', 'a/../b']) {
      has(one({ 'env-file': p }), /\[0\]\.env-file must be a relative path inside the component's directory/);
      has(one({ file: { path: p, format: 'json', mode: 'merge' }, values: {} }), /\[0\]\.file\.path must be a relative path/);
      has(one({ file: { path: 'c.json', format: 'json', mode: 'template', from: p } }), /\[0\]\.file\.from must be a relative path/);
    }
    has(one({ file: { path: 'c.ini', format: 'ini', mode: 'merge' }, values: {} }), /\[0\]\.file\.format must be one of json \| yaml \| toml \(got "ini"\)/);
    has(one({ file: { path: 'c.json', format: 'json', mode: 'copy' }, values: {} }), /\[0\]\.file\.mode must be one of template \| merge \(got "copy"\)/);
    has(one({ file: { path: 'c.toml', format: 'toml', mode: 'merge' }, values: {} }), /\[0\]\.file: toml supports mode template only/);
    has(one({ file: { path: 'c.json', format: 'json', mode: 'template' } }), /\[0\]\.file\.from is required with mode: template/);
    has(one({ file: { path: 'c.json', format: 'json', mode: 'template', from: 't.json' }, values: { a: 1 } }), /\[0\]\.values is not allowed with mode: template/);
    has(one({ file: { path: 'c.json', format: 'json', mode: 'merge' } }), /\[0\]\.values is required with mode: merge/);
    for (const name of ['1ABC', 'A-B', 'a b', '']) {
      const q = JSON.stringify(name).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
      has(one({ env: { [name]: 'x' } }), new RegExp(`\\[0\\]\\.env variable ${q} must match \\^\\[A-Za-z_\\]\\[A-Za-z0-9_\\]\\*\\$$`));
      has(one({ 'env-file': '.env', values: { [name]: 'x' } }), new RegExp(`\\[0\\]\\.values variable ${q} must match`));
      has(one({ command: 'x', values: { [name]: 'x' } }), new RegExp(`\\[0\\]\\.values variable ${q} must match`));
    }
    for (const name of ['FORGE_JOB', 'FORGE_X', 'PORT']) has(one({ env: { [name]: 'x' } }), new RegExp(`\\[0\\]\\.env variable "${name}" can't start with FORGE_ or be PORT`));
    has(one({ env: { A: 1 } }), /\[0\]\.env\.A must be a string \(got 1\)/);
    has(one({ 'env-file': '.env', values: { A: true } }), /\[0\]\.values\.A must be a string \(got true\)/);
    // `A: {port}` unquoted: a YAML parser reads a flow map (lib/yaml.ts refuses the form; a full parser gives `{ port: null }`).
    has(one({ env: { A: { port: null } } }), /\[0\]\.env\.A must be a string; quote the expression \("\{port\}"\)/);
    has(one({ file: { path: 'c.json', format: 'json', mode: 'merge' }, values: { list: [1, 2] } }), /\[0\]\.values\.list must be a string, number, boolean, null or a map of those/);
    has(one({ file: { path: 'c.json', format: 'json', mode: 'merge' }, values: { deep: { list: [{ a: 1 }] } } }), /\[0\]\.values\.deep\.list must be a string, number, boolean, null or a map of those/);
    has(one({ file: { path: 'c.json', format: 'json', mode: 'merge' }, values: JSON.parse('{"__proto__": {"a": 1}}') }), /\[0\]\.values\.__proto__ is not an allowed key/);
    has(one({ env: { A: '{nope}' } }), /\[0\]\.env\.A uses unknown expression \{nope\}; known roots are \{job\}/);
    has(one({ 'env-file': '.env', values: { A: 'x-{typo.x}' } }), /\[0\]\.values\.A uses unknown expression \{typo\.x\}/);
    has(one({ file: { path: 'c.json', format: 'json', mode: 'merge' }, values: { a: { b: '{what}' } } }), /\[0\]\.values\.a\.b uses unknown expression \{what\}/);
    // Non-identifier braces are literal, and reserved roots pass validation (they fail at render).
    assert.deepEqual(one({ env: { A: '{"a":1}', B: '{secret.db}' } }), []);
    has(problems([{ env: { A: 'x' } }], { repo: 'engine' }), /^components "api"\.config is only for a root-repo component; this one sets repo "engine"/);
    has(one({ command: '' }), /\[0\]\.command must be a non-empty shell command \(got ""\)/);
    has(one({ command: 7 }), /\[0\]\.command must be a non-empty shell command/);
    // Every sink is reported, each under its own index.
    const many = problems([{}, { env: { A: 1 } }, { command: '' }]);
    assert.equal(many.length, 3, many.join('\n'));
    assert.match(many[1], /\[1\]\.env\.A/);
    assert.match(many[2], /\[2\]\.command/);
    assert.deepEqual(sinkProblems([{ env: {} }], 'x', {}), []);
    assert.deepEqual(sinkProblems([{ env: {} }], 'x', { repo: null }), []);
  });

  test('a valid config with every sink kind has no problems', () => {
    assert.deepEqual(problems(VALID), []);
    assert.deepEqual(problems([]), []);
    assert.deepEqual(validateConfig({ ...loadDefaults(), components: [component(VALID)] }, process.cwd()), []);
  });

  test('a v19 config migrates to v20 unchanged', async () => {
    assert.equal(CONFIG_SCHEMA_VERSION, 21);
    const v19 = { schemaVersion: 19, components: [component(VALID)] };
    const m = migrateConfig(structuredClone(v19));
    assert.equal(m.from, 19);
    assert.deepEqual(m.config, { ...v19, schemaVersion: 21 });
    // Through the backing bump (#272) too: v18 → v19 → v20 is two no-ops.
    assert.deepEqual(migrateConfig({ ...structuredClone(v19), schemaVersion: 18 }).config, { ...v19, schemaVersion: 21 });
    const repo = tempRepo();
    try {
      const cfg = path.join(repo.dir, '.forge', 'config.yml');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, yaml.stringify({ schemaVersion: 19, tracker: { kind: 'none' }, components: [component(VALID)] }));
      const loaded = loadConfig(repo.dir);
      assert.equal(loaded.migratedFrom, 19);
      assert.deepEqual(loaded.config.components, [component(VALID)]);
      const r = await forgeAsync(repo.dir, ['config', 'validate']);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.deepEqual(JSON.parse(r.stdout).problems, []);
    } finally {
      repo.cleanup();
    }
  });
});

function loadDefaults() {
  const repo = tempRepo();
  try {
    return loadConfig(repo.dir).config;
  } finally {
    repo.cleanup();
  }
}

describe('config sink expressions', { concurrency: 4 }, () => {
  test('expressions resolve with types', () => {
    assert.equal(resolveValue('{port}', CTX), 4123);
    assert.equal(resolveValue('http://localhost:{port}', CTX), 'http://localhost:4123');
    assert.equal(resolveValue('{port}', NO_PORT), null);
    assert.equal(resolveValue('http://localhost:{port}/', NO_PORT), 'http://localhost:/');
    assert.equal(resolveString('{port}', NO_PORT), '');
    assert.equal(resolveString('{port}', CTX), '4123');
    const all = { job: 'j1', port: 4123, worktree: '/wt/j1', branch: 'forge/j1', base: 'main', 'component.name': 'api', 'component.path': 'services/api', 'component.dir': '/wt/j1/services/api' };
    assert.deepEqual(Object.keys(all).sort(), [...EXPRESSION_ROOTS].sort());
    for (const [root, v] of Object.entries(all)) assert.equal(resolveValue(`{${root}}`, CTX), v, root);
    // Braces around anything that isn't an identifier path are literal; an unknown root throws.
    assert.equal(resolveValue('{"a":1} {job}', CTX), '{"a":1} j1');
    assert.equal(resolveValue('{ port }', CTX), '{ port }');
    assert.throws(() => resolveValue('{nope}', CTX), /unknown expression \{nope\}/);
    assert.throws(() => resolveValue('{job.x}', CTX), /unknown expression \{job\.x\}/);
  });

  test('reserved namespaces name their issue', () => {
    assert.throws(() => resolveValue('{secret.db}', CTX), { message: '{secret.db} needs secret references (#197), which this Forge does not support yet' });
    assert.throws(() => resolveValue('x={endpoint.api.url}', CTX), { message: '{endpoint.api.url} needs endpoints (#195), which this Forge does not support yet' });
    assert.throws(() => resolveString('{backing.postgres.host}', CTX), { message: '{backing.postgres.host} needs backing services (#193), which this Forge does not support yet' });
    assert.throws(() => fillTemplate('"{secret}"', CTX), /\{secret\} needs secret references \(#197\)/);
    // A root that merely starts with a namespace's letters is unknown, not reserved.
    assert.throws(() => resolveValue('{secrets.x}', CTX), /unknown expression/);
  });

  test('templates escape values and keep other braces', () => {
    const ctx = { ...CTX, job: 'q"uo\\te\nline', branch: 'b' };
    const text = '{"job": "{job}", "port": {port}, "obj": {"a": 1}, "tbl": { x = 1 }, "{unknown}": "{ job }", "n": {nope.root}}';
    assert.equal(fillTemplate(text, ctx), '{"job": "q\\"uo\\\\te\\nline", "port": 4123, "obj": {"a": 1}, "tbl": { x = 1 }, "{unknown}": "{ job }", "n": {nope.root}}');
    assert.equal(fillTemplate('port = {port}', NO_PORT), 'port = null');
    assert.equal(fillTemplate('dir = "{component.dir}"', CTX), 'dir = "/wt/j1/services/api"');
    assert.equal(fillTemplate('{{job}}', CTX), '{j1}');
  });
});

describe('config sink renderers', { concurrency: 4 }, () => {
  test('env-file quoting', () => {
    const values = { A: 'plain', B: 'http://localhost:{port}/x@y%z+,.-_:', C: 'has space', D: 'q"uote', E: 'back\\slash', F: 'two\nlines', G: '{port}', H: '' };
    assert.equal(
      renderEnvFile(values, CTX),
      ['A=plain', 'B=http://localhost:4123/x@y%z+,.-_:', 'C="has space"', 'D="q\\"uote"', 'E="back\\\\slash"', 'F="two\\nlines"', 'G=4123', 'H=', ''].join('\n'),
    );
    assert.equal(renderEnvFile({ P: '{port}' }, NO_PORT), 'P=\n');
    assert.equal(renderEnvFile({}, CTX), '');
    assert.equal(renderEnvFile({ X: "it's $HOME" }, CTX), 'X="it\'s $HOME"\n');
  });

  test('json merge semantics', () => {
    const base = JSON.stringify({ server: { host: 'h', port: 1, tags: ['a'] }, list: [1, 2], keep: true });
    const values = { server: { port: '{port}', name: '{job}', tags: 'x' }, list: '{job}', added: null, flag: false };
    const out = renderMerge('json', base, values, CTX);
    assert.equal(out, `${JSON.stringify({ server: { host: 'h', port: 4123, tags: 'x', name: 'j1' }, list: 'j1', keep: true, added: null, flag: false }, null, 2)}\n`);
    assert.deepEqual(JSON.parse(renderMerge('json', null, { a: { b: 'c' } }, CTX)), { a: { b: 'c' } });
    assert.deepEqual(JSON.parse(renderMerge('json', '', { a: 1 }, CTX)), { a: 1 });
    assert.deepEqual(JSON.parse(renderMerge('json', '{"port": 1}', { port: '{port}' }, NO_PORT)), { port: null });
    // Neither base nor values are touched, and a base array under a values map is replaced.
    const v = { a: { b: 1 } };
    const copy = structuredClone(v);
    assert.deepEqual(JSON.parse(renderMerge('json', '{"a": [1]}', v, CTX)), { a: { b: 1 } });
    assert.deepEqual(v, copy);
    // Prototype keys are refused on either side and never merged.
    assert.throws(() => renderMerge('json', '{"__proto__": {"x": 1}}', { a: 1 }, CTX), /merge base key "__proto__" is not allowed/);
    assert.throws(() => renderMerge('json', '{}', JSON.parse('{"a": {"constructor": {"y": 1}}}'), CTX), /values key "constructor" is not allowed/);
    assert.equal(({} as any).x, undefined);
    // A parse failure keeps the parser's message (it quotes the text) as `cause` only.
    assert.throws(() => renderMerge('json', '{"a":', { a: 1 }, CTX), (e: Error) => e.message === 'the merge base does not parse as json' && e.cause instanceof SyntaxError);
    assert.throws(() => renderMerge('json', '[1]', { a: 1 }, CTX), /the merge base is not a map/);
    assert.throws(() => renderMerge('toml', null, { a: 1 }, CTX), /toml supports mode template only/);
  });

  test('yaml merge', () => {
    const base = 'server:\n  host: h\n  port: 1\nkeep: true\n';
    const out = renderMerge('yaml', base, { server: { port: '{port}', name: '{job}' }, extra: { on: false } }, CTX);
    assert.deepEqual(yaml.parse(out), { server: { host: 'h', port: 4123, name: 'j1' }, keep: true, extra: { on: false } });
    assert.equal(out, yaml.stringify({ server: { host: 'h', port: 4123, name: 'j1' }, keep: true, extra: { on: false } }));
    assert.deepEqual(yaml.parse(renderMerge('yaml', null, { a: 'x' }, CTX)), { a: 'x' });
    assert.throws(() => renderMerge('yaml', 'a: &anchor x\n', { a: 1 }, CTX), (e: Error) => e.message === 'the merge base does not parse as yaml' && /YAML/.test((e.cause as Error).message));
  });

  test('json template must parse', () => {
    assert.equal(renderTemplate('json', '{"job": "{job}", "port": {port}}', CTX, 'services/api/c.json.template'), '{"job": "j1", "port": 4123}');
    assert.throws(() => renderTemplate('json', '{"port": "{port}", "bad": {nope}}', CTX, 'services/api/c.json.template'), {
      message: 'config sink template services/api/c.json.template does not fill to valid JSON; check the quoting around its expressions',
    });
    // Unquoted `{port}` on a job without a port is `null`, which still parses.
    assert.equal(renderTemplate('json', '{"port": {port}}', NO_PORT, 'f'), '{"port": null}');
  });

  test('toml template', () => {
    const text = '[server]\nport = {port}\nname = "{job}"\ntable = { x = 1 }\n';
    assert.equal(renderTemplate('toml', text, CTX, 'app.toml.template'), '[server]\nport = 4123\nname = "j1"\ntable = { x = 1 }\n');
    assert.equal(renderTemplate('yaml', 'job: "{job}"\n', CTX, 'a.yml'), 'job: "j1"\n');
  });
});
