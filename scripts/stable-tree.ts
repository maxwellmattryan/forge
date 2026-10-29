// The stable tree release.yml's build job checks, also runnable by hand (docs/RELEASES.md "Recovery"):
//   node scripts/stable-tree.ts --develop <sha> --dist <dir>
//     prints `tree=<sha>`: the released develop commit's tree, minus .github/workflows/, plus the built
//     dashboard/dist/ (each file at 100644, its bytes as built)
// It prints the tree only once `releaseProblems(<checkout of it>, {dist: 'present'})` passes. The release job
// then rebuilds the same tree through the GitHub API and commits it onto stable with parents [stable, develop
// commit]; it must reach this sha. The dist comes from the build job's `npm run build:dashboard`, with
// node_modules, so it is checked here before any of it reaches a tree. stable drops .github/workflows/ because
// GITHUB_TOKEN can't move a ref across a change to workflow files. Built-ins only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distHash, sourceHash, STAMP } from '../dashboard/build-stamp.mjs';
import { gitEnv } from '../lib/integrations/git/runner.ts';
import { gitSync } from './git.ts';
import { releaseProblems } from './release-check.ts';

export const ASSET = /^assets\/[\w.-]+\.(js|css|woff2)$/;
const SHA = /^[0-9a-f]{40}$/;
const FIXED = ['index.html', 'manifest.json', STAMP];
/** What the stable tree leaves out of the develop commit's tree. */
export const STABLE_DROPS = ['.github/workflows'];
/**
 * A release commit's subject, or a main-update PR's from before them, as a squash leaves it: `Release 1.2.3`,
 * optionally `(#n)`. Only the whole subject counts, so `Release Forge in one command` or a fix titled
 * `Release 1.2.4: fix x` is still a change of its own.
 */
export const isReleaseSubject = (s: string) => /^(?:Release \d+\.\d+\.\d+|Update main to develop [0-9a-f]{7,40})(?: \(#\d+\))?$/.test(s.trim());

export class Refusal extends Error {}

/** Every file name the manifest points at (file, css[] and assets[] of each entry). */
export function manifestFiles(distDir: string): Set<string> {
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Refusal('manifest.json is not an object');
  const out = new Set<string>();
  const add = (f: unknown) => {
    if (typeof f !== 'string') throw new Refusal(`manifest.json names a non-string file: ${JSON.stringify(f)}`);
    out.add(f);
  };
  for (const entry of Object.values(manifest)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.file !== undefined) add(e.file);
    for (const k of ['css', 'assets']) {
      if (e[k] === undefined) continue;
      if (!Array.isArray(e[k])) throw new Refusal(`manifest.json ${k} is not a list`);
      for (const f of e[k] as unknown[]) add(f);
    }
  }
  return out;
}

/** Every entry under `dir` as a posix-relative path, refusing anything but plain files and directories. */
function distEntries(dir: string): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(path.join(dir, r));
      if (st.isSymbolicLink()) throw new Refusal(`dashboard/dist holds a symlink: ${r}`);
      if (st.isDirectory()) visit(r);
      else if (st.isFile()) out.push(r);
      else throw new Refusal(`dashboard/dist holds something other than a file: ${r}`);
    }
  };
  const top = fs.lstatSync(dir);
  if (top.isSymbolicLink() || !top.isDirectory()) throw new Refusal(`${dir} is not a directory`);
  visit('');
  return out.sort();
}

/** The dist's files when they are exactly the build's: index, manifest, stamp and the manifest's assets. */
export function checkedDistFiles(dir: string): string[] {
  const files = distEntries(dir);
  let named: Set<string>;
  try {
    named = manifestFiles(dir);
  } catch (e) {
    throw e instanceof Refusal ? e : new Refusal(`cannot read dashboard/dist/manifest.json: ${(e as Error).message}`);
  }
  for (const f of named) if (!ASSET.test(f)) throw new Refusal(`manifest.json names a file outside assets/*.js|css|woff2: ${JSON.stringify(f)}`);
  const allowed = new Set([...FIXED, ...named]);
  for (const f of files) if (!allowed.has(f)) throw new Refusal(`dashboard/dist holds a file the build does not name: ${f}`);
  for (const f of allowed) if (!files.includes(f)) throw new Refusal(`dashboard/dist is missing ${f}`);
  return files;
}

function git(args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): string {
  const r = gitSync(args, { env: opts.env, input: opts.input });
  if (r.error || r.status !== 0) throw new Refusal(`git ${args[0]} failed: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout;
}

function gitBuffer(args: string[]): Buffer {
  const r = gitSync(args, { encoding: 'buffer' });
  if (r.error || r.status !== 0) throw new Refusal(`git ${args[0]} failed: ${(r.stderr?.toString() || r.error?.message || '').trim()}`);
  return r.stdout;
}

function requireCommit(sha: string, what: string): void {
  if (!SHA.test(sha)) throw new Refusal(`${what} must be a 40-character lowercase hex sha, got ${JSON.stringify(sha)}`);
  if (git(['cat-file', '-t', sha]).trim() !== 'commit') throw new Refusal(`${what} ${sha} is not a commit`);
}

/** sourceHash of develop's dashboard/ and package-lock.json, read from its tree rather than the checkout. */
function developSourceHash(develop: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-stable-tree-src-'));
  try {
    const listing = git(['ls-tree', '-r', '-z', '--full-tree', develop, '--', 'dashboard', 'package-lock.json']);
    for (const line of listing.split('\0')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      const [mode, type, blob] = line.slice(0, tab).split(' ');
      const rel = line.slice(tab + 1);
      // Regular files only, as the hash walks them: links and submodules are skipped there too.
      if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) continue;
      if (rel.split('/').some((s) => !s || s === '.' || s === '..')) throw new Refusal(`develop's tree holds an unsafe path: ${JSON.stringify(rel)}`);
      const file = path.join(tmp, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, gitBuffer(['cat-file', 'blob', blob]));
    }
    const lock = path.join(tmp, 'package-lock.json');
    if (!fs.existsSync(lock)) throw new Refusal("develop's tree has no package-lock.json");
    const dashboard = path.join(tmp, 'dashboard');
    fs.mkdirSync(dashboard, { recursive: true });
    return sourceHash(dashboard, lock);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The checked dist's files, refused unless the stamp matches them and was built from `develop`'s dashboard sources. */
function checkedDist(develop: string, dist: string): { dir: string; files: string[] } {
  const tracked = git(['ls-tree', '-r', '--name-only', '-z', '--full-tree', develop, '--', 'dashboard/dist']);
  if (tracked.replace(/\0/g, '')) throw new Refusal(`develop already tracks dashboard/dist (${tracked.split('\0')[0]}): develop never commits the build`);
  const dir = path.resolve(dist);
  const files = checkedDistFiles(dir);
  let stamp: any;
  try {
    stamp = JSON.parse(fs.readFileSync(path.join(dir, STAMP), 'utf8'));
  } catch (e) {
    throw new Refusal(`cannot read dashboard/dist/${STAMP}: ${(e as Error).message}`);
  }
  if (stamp?.dist !== distHash(dir)) throw new Refusal(`dashboard/dist does not match its ${STAMP} (dist)`);
  if (stamp?.source !== developSourceHash(develop)) throw new Refusal(`dashboard/dist was not built from develop's sources (${STAMP} source)`);
  return { dir, files };
}

/** `develop`'s tree with every path under `drops` removed and the dist files added under dashboard/dist/, written to the object store. */
function writeTree(develop: string, dir: string, files: string[], drops: string[]): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-stable-tree-index-'));
  try {
    // A temporary index, so the checkout's index and working tree are never touched.
    const env = { ...gitEnv(), GIT_INDEX_FILE: path.join(tmp, 'index') };
    git(['read-tree', develop], { env });
    // -f: the temporary index need not match HEAD or the working tree; --cached: never the working tree.
    if (drops.length) git(['rm', '-r', '-q', '-f', '--cached', '--ignore-unmatch', '--', ...drops], { env });
    for (const rel of files) {
      // Hashed from the file as built, with no clean filter or attribute that could reshape it.
      const blob = git(['hash-object', '-w', '--no-filters', '--', path.join(dir, ...rel.split('/'))], { env }).trim();
      if (!SHA.test(blob)) throw new Refusal(`git hash-object printed ${JSON.stringify(blob)}`);
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},dashboard/dist/${rel}`], { env });
    }
    const tree = git(['write-tree'], { env }).trim();
    if (!SHA.test(tree)) throw new Refusal(`git write-tree printed ${JSON.stringify(tree)}`);
    return tree;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The stable tree for `develop` (a 40-hex commit) and the built `dist`: develop's tree minus STABLE_DROPS plus the checked dist. */
export function stableTree(develop: string, dist: string): string {
  requireCommit(develop, '--develop');
  const { dir, files } = checkedDist(develop, dist);
  return writeTree(develop, dir, files, STABLE_DROPS);
}

// Fixed, so the throwaway check commit is the same object on every run.
const CHECK_ENV = {
  GIT_AUTHOR_NAME: 'stable-tree',
  GIT_AUTHOR_EMAIL: 'stable-tree@invalid',
  GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'stable-tree',
  GIT_COMMITTER_EMAIL: 'stable-tree@invalid',
  GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z',
};

/**
 * `stableTree(develop, dist)`, returned only once a checkout of it passes `releaseProblems(…, {dist: 'present'})`:
 * a throwaway commit of the tree (parent `develop`, never on any ref) is checked out in a temporary worktree, which
 * is always removed. Throws a Refusal listing the problems.
 */
export function checkStable(develop: string, dist: string): string {
  const tree = stableTree(develop, dist);
  const commit = git(['commit-tree', '--no-gpg-sign', tree, '-p', develop, '-F', '-'], { env: { ...gitEnv(), ...CHECK_ENV }, input: 'stable tree check\n' }).trim();
  if (!SHA.test(commit)) throw new Refusal(`git commit-tree printed ${JSON.stringify(commit)}`);
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-stable-tree-')));
  const checkout = path.join(tmp, 'tree');
  let added = false;
  try {
    // No hook runs on the checkout: it is a check, not a working copy.
    git(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--quiet', '--detach', checkout, commit]);
    added = true;
    const problems = releaseProblems(checkout, { dist: 'present' });
    if (problems.length) throw new Refusal(`the stable tree fails the release check:\n${problems.join('\n')}`);
    return tree;
  } finally {
    if (added) gitSync(['worktree', 'remove', '--force', checkout]);
    fs.rmSync(tmp, { recursive: true, force: true });
    gitSync(['worktree', 'prune']);
  }
}

/** One line of commit text, safe to print: no control characters, bounded length. */
export const oneLine = (s: string) => {
  const flat = s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
};

const USAGE = 'usage: node scripts/stable-tree.ts --develop <sha> --dist <dir>\n';

function usage(): never {
  process.stderr.write(USAGE);
  process.exit(2);
}

/** `--develop <40-hex> --dist <dir>`, each exactly once; anything else is a usage error (exit 2), before any git call. */
function parseFlags(args: string[]): { develop: string; dist: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const [k, v] = [args[i], args[i + 1]];
    const name = k.startsWith('--') ? k.slice(2) : '';
    if ((name !== 'develop' && name !== 'dist') || name in out || v === undefined) usage();
    out[name] = v;
  }
  if (!('develop' in out) || !('dist' in out)) usage();
  // Checked before any git call, so `-rf` or `--output=x` never reaches git's argv as an option.
  if (!SHA.test(out.develop)) usage();
  return { develop: out.develop, dist: out.dist };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { develop, dist } = parseFlags(process.argv.slice(2));
  try {
    const tree = checkStable(develop, dist);
    process.stdout.write(`tree=${tree}\n`);
  } catch (e) {
    process.stderr.write(`stable-tree: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
