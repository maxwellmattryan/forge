// Component suggestions for `forge init detect`: one per npm/yarn/pnpm/bun workspace package, Cargo
// workspace member and CMake subproject, with the build edges their manifests make obvious. The
// manifests are repo files, so every read stays inside the repo, skips anything that is not a plain
// file, and gives up on that component or edge rather than failing detection.
import fs from 'node:fs';
import path from 'node:path';
import { isMap } from '#core/shape.ts';
import type { ComponentConfig, ComponentKind } from '#core/types.ts';
import { SAFE_REF } from '#core/text.ts';

/** What detect already worked out about the root: the package manager, UI packages and root manifests. */
export interface ComponentDetectInput {
  pm: string | null;
  ui: readonly string[];
  pkg: any;
  cargo: string;
}


/** Manifests are small; a larger file is skipped so a hostile one can't make detection slow. */
export const MAX_MANIFEST_BYTES = 1024 * 1024;

/** A repo file's text, or null when it is missing, not a plain file (a FIFO would block), over `MAX_MANIFEST_BYTES`, or resolves outside `root`. */
function readRepoFile(root: string, rel: string): string | null {
  const abs = path.join(root, rel);
  try {
    const real = fs.realpathSync(abs);
    const top = fs.realpathSync(root);
    if (real !== top && !real.startsWith(top + path.sep)) return null;
    const stat = fs.lstatSync(abs);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** A repo JSON file, or null when it cannot be read or does not parse. */
function readRepoJson(root: string, rel: string): any {
  const text = readRepoFile(root, rel);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** package.json `workspaces`, an array or `{ packages }`, as written. */
export function npmWorkspaces(pkg: any): string[] {
  const ws = pkg?.workspaces;
  const list = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
  return list.filter((p: unknown): p is string => typeof p === 'string');
}

/** Cargo.toml `members = [...]`, as written. */
export function cargoMembers(cargo: string): string[] {
  return cargo.match(/members\s*=\s*\[([^\]]*)\]/)?.[1]?.match(/"[^"]+"/g)?.map((m) => m.slice(1, -1)) ?? [];
}

/** A repo-relative POSIX directory, or null when it leaves the repo or names the root itself. */
function repoDir(base: string, rel: string): string | null {
  if (rel.includes('\\') || path.posix.isAbsolute(rel)) return null;
  const p = path.posix.normalize(path.posix.join(base, rel)).replace(/\/+$/, '');
  return p === '.' || p === '' || p === '..' || p.startsWith('../') ? null : p;
}

/** A member pattern's directories that hold `manifest`: an exact path, or `<dir>/*` for its direct subdirectories. */
function expand(root: string, pattern: string, manifest: string): string[] {
  const star = pattern.endsWith('/*');
  const stem = star ? pattern.slice(0, -2) : pattern;
  if (pattern.startsWith('!') || /[*?[{]/.test(stem)) return [];
  const dir = repoDir('.', stem || '.');
  let dirs: string[];
  if (!star) dirs = dir ? [dir] : [];
  else {
    try {
      // Dirent.isDirectory() is false for a symlink, so expansion never walks out through one.
      dirs = fs
        .readdirSync(path.join(root, dir ?? '.'), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => (dir ? `${dir}/${d.name}` : d.name));
    } catch {
      dirs = [];
    }
  }
  return dirs.filter((d) => readRepoFile(root, `${d}/${manifest}`) !== null);
}

interface Found {
  path: string;
  kind: ComponentKind;
  commands?: Record<string, string>;
  /** Paths of the components this one builds against. */
  deps: Set<string>;
}

function npmComponents(root: string, input: ComponentDetectInput): Found[] {
  const runScript = (s: string) => (input.pm === 'npm' || !input.pm ? `npm run ${s}` : `${input.pm} ${s}`);
  const pkgs: { dir: string; pkg: any }[] = [];
  for (const dir of new Set(npmWorkspaces(input.pkg).flatMap((p) => expand(root, p, 'package.json')))) {
    const pkg = readRepoJson(root, `${dir}/package.json`);
    if (isMap(pkg)) pkgs.push({ dir, pkg });
  }
  const byName = new Map<string, string>();
  for (const { dir, pkg } of pkgs) if (typeof pkg.name === 'string' && !byName.has(pkg.name)) byName.set(pkg.name, dir);
  return pkgs.map(({ dir, pkg }) => {
    const deps = ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((k) => (isMap(pkg[k]) ? Object.keys(pkg[k]) : []));
    const scripts = isMap(pkg.scripts) ? pkg.scripts : {};
    const kind: ComponentKind = deps.some((d) => input.ui.includes(d)) ? 'app' : scripts.start || scripts.dev ? 'service' : 'library';
    const commands: Record<string, string> = {};
    if (scripts.build) commands.build = runScript('build');
    if (scripts.test) commands.test = runScript('test');
    if (scripts['lint:check']) commands.lint = runScript('lint:check');
    else if (scripts.lint) commands.lint = runScript('lint');
    if (scripts.check) commands.typecheck = runScript('check');
    else if (scripts.typecheck) commands.typecheck = runScript('typecheck');
    const edges = new Set(deps.map((d) => byName.get(d)).filter((d): d is string => Boolean(d) && d !== dir));
    return { path: dir, kind, ...(Object.keys(commands).length ? { commands } : {}), deps: edges };
  });
}

/** Lines of the TOML sections whose header satisfies `want`, e.g. `[dependencies]`. */
function tomlSections(text: string, want: (header: string) => boolean): string[] {
  const out: string[] = [];
  let on = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\[?([^\]]*)\]/.exec(line);
    if (header) on = !line.trim().startsWith('[[') && want(header[1].trim());
    else if (on) out.push(line);
  }
  return out;
}

/** Inline-table dependencies: `name = { path = "…", workspace = true, … }`. */
function inlineDeps(lines: string[]): { name: string; path: string | null; workspace: boolean }[] {
  return lines.flatMap((line) => {
    const m = /^\s*([\w-]+)\s*=\s*\{([^}]*)\}/.exec(line);
    if (!m) return [];
    return [{ name: m[1], path: /\bpath\s*=\s*"([^"]+)"/.exec(m[2])?.[1] ?? null, workspace: /\bworkspace\s*=\s*true\b/.test(m[2]) }];
  });
}

function cargoComponents(root: string, input: ComponentDetectInput): Found[] {
  if (!/^\[workspace\]/m.test(input.cargo)) return [];
  const dirs = [...new Set(cargoMembers(input.cargo).flatMap((p) => expand(root, p, 'Cargo.toml')))];
  const members = new Set(dirs);
  const shared = new Map<string, string>();
  for (const d of inlineDeps(tomlSections(input.cargo, (h) => h === 'workspace.dependencies')))
    if (d.path) {
      const p = repoDir('.', d.path);
      if (p) shared.set(d.name, p);
    }
  return dirs.flatMap((dir) => {
    const toml = readRepoFile(root, `${dir}/Cargo.toml`);
    if (toml === null) return [];
    const deps = inlineDeps(tomlSections(toml, (h) => /^(dev-|build-)?dependencies$/.test(h)));
    const isFile = (rel: string) => readRepoFile(root, `${dir}/${rel}`) !== null;
    const hasTauri = deps.some((d) => d.name === 'tauri') || /^[ \t]*tauri[ \t]*=/m.test(tomlSections(toml, (h) => h === 'dependencies').join('\n'));
    const kind: ComponentKind = hasTauri ? 'app' : isFile('src/lib.rs') && !isFile('src/main.rs') && !/^[ \t]*\[\[bin\]\]/m.test(toml) ? 'library' : 'service';
    const edges = new Set<string>();
    for (const d of deps) {
      const target = d.path ? repoDir(dir, d.path) : d.workspace ? shared.get(d.name) ?? null : null;
      if (target && target !== dir && members.has(target)) edges.add(target);
    }
    return [{ path: dir, kind, commands: { build: 'cargo build', test: 'cargo test', lint: 'cargo clippy -- -D warnings' }, deps: edges }];
  });
}

/**
 * The argument text of each `target_link_libraries(…)` call, which may span lines. One forward scan:
 * a regex over the whole file rescans to the end for every unclosed call, which is quadratic.
 */
function linkArgs(text: string): string[] {
  const out: string[] = [];
  const call = /target_link_libraries\(/gi;
  for (let m = call.exec(text); m; m = call.exec(text)) {
    const close = text.indexOf(')', call.lastIndex);
    // No `)` after this call means none after any later one either.
    if (close === -1) break;
    out.push(text.slice(call.lastIndex, close));
    call.lastIndex = close + 1;
  }
  return out;
}

function cmakeComponents(root: string): Found[] {
  const top = readRepoFile(root, 'CMakeLists.txt');
  if (top === null) return [];
  const dirs = [...new Set([...top.matchAll(/add_subdirectory\(\s*([^\s)]+)/gi)].map((m) => repoDir('.', m[1].replace(/^"|"$/g, ''))).filter((d): d is string => Boolean(d)))];
  const subs = dirs.flatMap((dir) => {
    const text = readRepoFile(root, `${dir}/CMakeLists.txt`);
    return text === null ? [] : [{ dir, text, libs: [...text.matchAll(/add_library\(\s*([^\s)]+)/gi)].map((m) => m[1]) }];
  });
  const libOwner = new Map<string, string>();
  for (const s of subs) for (const l of s.libs) if (!libOwner.has(l)) libOwner.set(l, s.dir);
  return subs.map((s) => {
    const edges = new Set<string>();
    for (const args of linkArgs(s.text)) {
      for (const word of args.trim().split(/\s+/).slice(1)) {
        const owner = libOwner.get(word);
        if (!/^(PUBLIC|PRIVATE|INTERFACE)$/.test(word) && owner && owner !== s.dir) edges.add(owner);
      }
    }
    const kind: ComponentKind = s.libs.length && !/add_executable\(/i.test(s.text) ? 'library' : 'app';
    return { path: s.dir, kind, deps: edges };
  });
}

/** A name that passes SAFE_REF: `[A-Za-z0-9._-]` only, starting with a letter or digit. */
function safeName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 200);
}

/** The suggested components, sorted by path; a directory two ecosystems both claim is suggested once. */
export function detectComponents(root: string, input: ComponentDetectInput): ComponentConfig[] {
  const found = new Map<string, Found>();
  for (const f of [...npmComponents(root, input), ...cargoComponents(root, input), ...cmakeComponents(root)]) if (!found.has(f.path)) found.set(f.path, f);
  const all = [...found.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const base = new Map(all.map((f) => [f.path, safeName(path.posix.basename(f.path))]));
  const counts = new Map<string, number>();
  for (const n of base.values()) counts.set(n, (counts.get(n) ?? 0) + 1);
  const names = new Map(all.map((f) => [f.path, base.get(f.path) && counts.get(base.get(f.path)!) === 1 ? base.get(f.path)! : safeName(f.path.replace(/\//g, '-'))]));
  // Two path-derived names can still meet (`a-b/c`, `a/b-c`): the first keeps it, the other is dropped.
  const kept = new Map<string, Found>();
  for (const f of all) if (SAFE_REF.test(names.get(f.path)!) && !kept.has(names.get(f.path)!)) kept.set(names.get(f.path)!, f);
  const keptPaths = new Set([...kept.values()].map((f) => f.path));
  return [...kept].map(([name, f]) => {
    const dependsOn = [...new Set([...f.deps].filter((d) => keptPaths.has(d)).map((d) => names.get(d)!))].sort().map((component) => ({ component, type: 'build' as const }));
    return { name, path: f.path, kind: f.kind, ...(f.commands ? { commands: f.commands } : {}), dependsOn };
  });
}
