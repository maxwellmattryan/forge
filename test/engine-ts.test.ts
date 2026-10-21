// The engine's TypeScript toolchain: compiler flags, package scripts, imports and the hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tempRepo } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const readJson = (rel: string): any => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

// The compiler flags are the invariant (strict types; only syntax Node's type stripping can erase),
// and no public function exposes them, so this reads tsconfig.json (docs/TESTING.md exception).
test('engine tsconfig is strict and erasable-only', () => {
  const { compilerOptions } = readJson('tsconfig.json');
  assert.equal(compilerOptions.strict, true);
  assert.equal(compilerOptions.erasableSyntaxOnly, true);
});

test('package.json: Node >= 22.18, typecheck and test scripts', () => {
  const pkg = readJson('package.json');
  assert.deepEqual(pkg.engines, { node: '>=22.18' });
  assert.equal(pkg.scripts.test, 'node --test "test/*.test.ts"');
  assert.equal(
    pkg.scripts.typecheck,
    'tsc -p tsconfig.json --incremental --tsBuildInfoFile node_modules/.cache/forge/tsc-engine.tsbuildinfo && tsc -p test/tsconfig.json --incremental --tsBuildInfoFile node_modules/.cache/forge/tsc-test.tsbuildinfo',
  );
  assert.equal(pkg.devDependencies['@types/node'], '22.18.13');
  assert.equal(pkg.devDependencies.typescript, '6.0.3');
  assert.equal(pkg.dependencies, undefined);
  const lock = readJson('package-lock.json');
  assert.equal(lock.packages['node_modules/@types/node']?.version, '22.18.13');
  assert.deepEqual(lock.packages[''].engines, pkg.engines);
});

// The build info and svelte-check's cache live in the checkout, so verify's worktree-clean gate
// would fail on them if git saw them.
test('incremental typecheck caches stay out of git', () => {
  const pkg = readJson('package.json');
  const infos = [...pkg.scripts.typecheck.matchAll(/--tsBuildInfoFile (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(infos, ['node_modules/.cache/forge/tsc-engine.tsbuildinfo', 'node_modules/.cache/forge/tsc-test.tsbuildinfo']);
  for (const f of infos) assert.ok(f.startsWith('node_modules/'), f);
  for (const f of ['dashboard/.svelte-check/manifest.json', ...infos]) {
    const r = spawnSync('git', ['check-ignore', '-q', '--', f], { cwd: ROOT });
    assert.equal(r.status, 0, `${f} is ignored`);
  }
});

test('lib/types.ts is type-only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'types.ts'), 'utf8');
  // What Node would run after stripping types: nothing but the module marker.
  const ts = createRequire(path.join(ROOT, 'package.json'))('typescript');
  const out = ts.transpileModule(src, {
    fileName: 'types.ts',
    compilerOptions: { removeComments: true, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, verbatimModuleSyntax: true },
  }).outputText;
  assert.equal(out.replace(/export\s*\{\s*\};?/g, '').trim(), '');
});

// Custom tracker adapters still import status.mjs; it must stay the same functions as status.ts.
test('the status.mjs re-export is lib/trackers/status.ts', async () => {
  const shim = await import('../lib/trackers/status.mjs');
  const real = await import('../lib/trackers/status.ts');
  assert.deepEqual(Object.keys(shim).sort(), ['STATUS_KEYS', 'statusKey']);
  assert.deepEqual(Object.keys(real).sort(), ['STATUS_KEYS', 'statusKey']);
  assert.equal(shim.statusKey, real.statusKey);
  assert.equal(shim.STATUS_KEYS, real.STATUS_KEYS);
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
// fixtures in dashboard-svelte.test.ts hold import lines that are data, not code).
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
