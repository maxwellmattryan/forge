// The engine's TypeScript toolchain: configs, package scripts, the converted modules and the hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tempRepo } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const readJson = (rel: string): any => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const FOUNDATION = ['util', 'paths', 'yaml', 'schema', 'config', 'jobs', 'attribution', 'roster', 'requests'];
const DOMAIN = ['worktree', 'scope', 'integrity', 'acs', 'delta', 'deps', 'budget', 'e2e', 'evals', 'retro', 'stats', 'usage', 'detect', 'pr'];
const DOMAIN_TESTS = ['acs', 'budget', 'delta', 'deps', 'detect', 'integrity', 'pr', 'scope', 'verify-e2e', 'background'];

test('engine tsconfig is strict, erasable-only, with interim allowJs', () => {
  assert.deepEqual(readJson('tsconfig.json'), {
    compilerOptions: {
      strict: true,
      noEmit: true,
      verbatimModuleSyntax: true,
      erasableSyntaxOnly: true,
      allowImportingTsExtensions: true,
      isolatedModules: true,
      module: 'nodenext',
      moduleResolution: 'nodenext',
      target: 'es2023',
      lib: ['es2023'],
      types: ['node'],
      skipLibCheck: true,
      allowJs: true,
      checkJs: false,
    },
    include: ['lib/**/*', 'hooks/**/*', 'test/types-parity.ts'],
  });
});

test('test tsconfig extends the engine config with strict off', () => {
  // dom: the dashboard suites import dashboard/src/lib helpers, which use browser globals.
  assert.deepEqual(readJson('test/tsconfig.json'), {
    extends: '../tsconfig.json',
    compilerOptions: { strict: false, lib: ['es2023', 'dom'] },
    include: ['**/*'],
  });
});

test('package.json: Node >= 22.18, typecheck and dual-glob test scripts', () => {
  const pkg = readJson('package.json');
  assert.deepEqual(pkg.engines, { node: '>=22.18' });
  assert.equal(pkg.scripts.test, 'node --test "test/*.test.mjs" "test/*.test.ts"');
  assert.equal(pkg.scripts.typecheck, 'tsc -p tsconfig.json && tsc -p test/tsconfig.json');
  assert.equal(pkg.devDependencies['@types/node'], '22.18.13');
  assert.equal(pkg.devDependencies.typescript, '6.0.3');
  assert.equal(pkg.dependencies, undefined);
  const lock = readJson('package-lock.json');
  assert.equal(lock.packages['node_modules/@types/node']?.version, '22.18.13');
  assert.deepEqual(lock.packages[''].engines, pkg.engines);
});

test('foundation modules are TypeScript and lib/types.ts is type-only', () => {
  for (const m of FOUNDATION) {
    assert.ok(fs.existsSync(path.join(ROOT, 'lib', `${m}.ts`)), `lib/${m}.ts exists`);
    assert.ok(!fs.existsSync(path.join(ROOT, 'lib', `${m}.mjs`)), `lib/${m}.mjs is gone`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'hooks', 'no-ai-attribution.ts')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'hooks', 'no-ai-attribution.mjs')));

  const src = fs.readFileSync(path.join(ROOT, 'lib', 'types.ts'), 'utf8');
  const imports = src.split('\n').filter((l) => /^\s*import\b/.test(l));
  assert.ok(imports.length > 0);
  for (const l of imports) assert.match(l, /^import type /, `type-only import: ${l}`);
  assert.doesNotMatch(src, /^\s*export\s+(const|let|var|function|class|enum|default|namespace)\b/m);
  // What Node would run after stripping types: nothing but the module marker.
  const ts = createRequire(path.join(ROOT, 'package.json'))('typescript');
  const out = ts.transpileModule(src, {
    fileName: 'types.ts',
    compilerOptions: { removeComments: true, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, verbatimModuleSyntax: true },
  }).outputText;
  assert.equal(out.replace(/export\s*\{\s*\};?/g, '').trim(), '');
});

test('domain modules and their tests are TypeScript', () => {
  for (const m of DOMAIN) {
    assert.ok(fs.existsSync(path.join(ROOT, 'lib', `${m}.ts`)), `lib/${m}.ts exists`);
    assert.ok(!fs.existsSync(path.join(ROOT, 'lib', `${m}.mjs`)), `lib/${m}.mjs is gone`);
  }
  for (const t of DOMAIN_TESTS) {
    assert.ok(fs.existsSync(path.join(ROOT, 'test', `${t}.test.ts`)), `test/${t}.test.ts exists`);
    assert.ok(!fs.existsSync(path.join(ROOT, 'test', `${t}.test.mjs`)), `test/${t}.test.mjs is gone`);
  }
});

function filesUnder(rel: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(mjs|ts)$/.test(e.name)) out.push(full);
    }
  };
  walk(path.join(ROOT, rel));
  return out;
}

// Parsed rather than matched: a regex cannot tell an import from the same text inside a string (the Svelte
// fixtures in dashboard-svelte.test.mjs hold import lines that are data, not code).
function relativeSpecifiers(ts: any, file: string, text: string): string[] {
  const kind = file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const out: string[] = [];
  const visit = (n: any) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push(n.moduleSpecifier.text);
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      out.push(n.arguments[0].text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out.filter((s) => s.startsWith('./') || s.startsWith('../'));
}

test('every relative import resolves to an existing file', () => {
  const ts = createRequire(path.join(ROOT, 'package.json'))('typescript');
  const files = [...filesUnder('lib'), ...filesUnder('hooks'), ...filesUnder('test'), path.join(ROOT, 'bin', 'forge')];
  let checked = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const spec of relativeSpecifiers(ts, f, text)) {
      const target = path.resolve(path.dirname(f), spec);
      assert.ok(fs.existsSync(target), `${path.relative(ROOT, f)} imports ${spec}, which does not exist`);
      checked++;
    }
  }
  assert.ok(checked > 100, `checked ${checked} specifiers`);
});

test('hooks.json runs the TypeScript hook', () => {
  const hooks = readJson('hooks/hooks.json');
  const [entry] = hooks.hooks.PreToolUse[0].hooks;
  assert.equal(entry.command, 'node');
  assert.deepEqual(entry.args, ['${CLAUDE_PLUGIN_ROOT}/hooks/no-ai-attribution.ts']);
  const args = entry.args.map((a: string) => a.replace('${CLAUDE_PLUGIN_ROOT}', ROOT));
  assert.ok(fs.existsSync(args[0]), `${args[0]} exists`);
  const repo = tempRepo();
  try {
    const res = spawnSync(process.execPath, args, {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"' }, cwd: repo.dir }),
      encoding: 'utf8',
      env: { ...process.env, FORGE_AI_ATTRIBUTION: '' },
    });
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /Blocked by Forge/);
  } finally {
    repo.cleanup();
  }
});
