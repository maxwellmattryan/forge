// Forge release gate: fails while a tracked manifest still points a dependency at a Forge interim
// reference (a pinned commit or a canary pre-release), so a consumer can't merge before its
// dependency is released, whoever merges it. Seeded by `forge init write`; plain Node (>= 18), no
// dependencies. Run it from the repo root: node .forge/ci/release-gate.mjs
//
// Exit 0: no interim reference. Exit 1: at least one, each printed as
// `<path>:<line>: <ecosystem>: <why>: <text>`. Exit 2: it could not check (it fails closed).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ---------- edit to match your project ----------
// One rule per ecosystem. `files(path)` picks the manifests a rule reads; `scan(text, path)` returns
// its findings as `{ line, why }` (1-based line). Remove a rule, or change its patterns, to suit the
// pins your project really uses. A scan may throw to say the file can't be checked (exit 2).
const RULES = [
  {
    // edit to match your project: the [patch] block Forge's git-ref strategy writes into Cargo.toml.
    ecosystem: 'cargo',
    files: (p) => path.posix.basename(p) === 'Cargo.toml',
    scan: (text) => lines(text).flatMap((l, i) => (l.trim() === '# forge:interim begin' ? [{ line: i + 1, why: 'a Forge interim [patch] block' }] : [])),
  },
  {
    // edit to match your project: a FetchContent GIT_TAG set to a full commit id.
    ecosystem: 'cmake',
    files: (p) => path.posix.basename(p) === 'CMakeLists.txt' || p.endsWith('.cmake'),
    scan: (text) => lines(text).flatMap((l, i) => (/\bGIT_TAG\s+"?[0-9a-f]{40}(?:[0-9a-f]{24})?"?(?=[\s)]|$)/.test(l) ? [{ line: i + 1, why: 'a GIT_TAG pinned to a commit' }] : [])),
  },
  {
    // edit to match your project: a git dependency at a commit, or a canary pre-release.
    ecosystem: 'npm',
    files: (p) => path.posix.basename(p) === 'package.json',
    scan: (text, p) => {
      let doc;
      try {
        doc = JSON.parse(text);
      } catch {
        throw new Error(`${p} is not valid JSON`);
      }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${p} is not a JSON object`);
      const all = lines(text);
      const lineOf = (name) => {
        const i = all.findIndex((l) => l.includes(JSON.stringify(name)));
        return i < 0 ? 1 : i + 1;
      };
      const out = [];
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const deps = doc[section];
        if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
        for (const [name, spec] of Object.entries(deps)) {
          if (typeof spec !== 'string') continue;
          if (/^git\+.*#[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(spec)) out.push({ line: lineOf(name), why: 'a git dependency pinned to a commit' });
          else if (/-canary\./.test(spec)) out.push({ line: lineOf(name), why: 'a canary pre-release' });
        }
      }
      return out;
    },
  },
];

// edit to match your project: tracked paths never scanned (regexes over the repo-relative path).
const IGNORE = [/(^|\/)node_modules\//];
// ---------- end of the editable part ----------

function lines(text) {
  return text.split(/\r?\n/);
}

function cannotCheck(reason) {
  process.stderr.write(`release gate: cannot check: ${reason}\n`);
  process.exit(2);
}

function trackedFiles() {
  // Tracked files only: untracked and ignored files never reach a merge.
  const r = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) cannotCheck(`git ls-files could not run (${r.error.message})`);
  if (r.status !== 0) cannotCheck(`git ls-files exited ${r.status}: ${String(r.stderr).trim().slice(0, 200)}`);
  return r.stdout.split('\0').filter(Boolean);
}

const findings = [];
let manifests = 0;
for (const file of trackedFiles()) {
  if (IGNORE.some((re) => re.test(file))) continue;
  const rules = RULES.filter((r) => r.files(file));
  if (!rules.length) continue;
  let text;
  try {
    // Never follow a tracked symlink: its target, if tracked, is scanned on its own.
    if (!fs.lstatSync(file).isFile()) continue;
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') continue;
    cannotCheck(`${file} could not be read (${e && e.code ? e.code : e})`);
  }
  manifests++;
  const all = lines(text);
  for (const rule of rules) {
    let found;
    try {
      found = rule.scan(text, file);
    } catch (e) {
      cannotCheck(e && e.message ? e.message : String(e));
    }
    for (const f of found) findings.push(`${file}:${f.line}: ${rule.ecosystem}: ${f.why}: ${(all[f.line - 1] ?? '').trim().slice(0, 200)}`);
  }
}

if (!findings.length) {
  console.log(`release gate: no interim references in ${manifests} manifests`);
  process.exit(0);
}
for (const f of findings) console.log(f);
console.log(`release gate: ${findings.length} interim references; replace them with released versions before merging`);
process.exit(1);
