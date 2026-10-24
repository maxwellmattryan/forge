// The main update `npm run release` pushes to the release PR's branch (scripts/release.ts), also runnable by hand:
//   node scripts/main-update.ts commit --main <sha> --develop <sha> --dist <dir>
//     prints the sha of one new commit: the release commit's tree (`--develop`: develop's tip plus the bump)
//     plus the built dashboard/dist/, parents [main, release commit]
// The release PR carries it into main. The dist comes from main-update.yml's build of the release branch
// in CI, with node_modules, so it is checked here before any of it reaches a commit (docs/RELEASES.md
// "Releasing"). A resume of `npm run release` re-derives it (`isMainUpdate`) before it vouches for a branch tip
// someone may have pushed, and again for the head a release PR merged before it lands anything on develop.
// Built-ins only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distHash, sourceHash, STAMP } from '../dashboard/build-stamp.mjs';
import { gitSync } from './git.ts';

export const ASSET = /^assets\/[\w.-]+\.(js|css|woff2)$/;
const SHA = /^[0-9a-f]{40}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const FIXED = ['index.html', 'manifest.json', STAMP];
/**
 * A release commit's subject, or a main-update PR's from before them, as a squash leaves it: `Release 1.2.3`,
 * optionally `(#n)`. Only the whole subject counts, so `Release Forge in one command` or a hotfix titled
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
  if (git(['cat-file', '-t', sha]).trim() !== 'commit') throw new Refusal(`${what} ${sha} is not a commit`);
}

/** develop's package.json version, X.Y.Z only: it becomes a PR title and a commit subject. */
function developVersion(develop: string): string {
  let v: unknown;
  try {
    v = JSON.parse(git(['cat-file', 'blob', `${develop}:package.json`]))?.version;
  } catch (e) {
    throw new Refusal(`cannot read develop's package.json: ${(e as Error).message}`);
  }
  if (typeof v !== 'string' || !SEMVER.test(v)) throw new Refusal(`develop's package.json version ${JSON.stringify(v)} is not X.Y.Z`);
  return v;
}

/** `Release <v>`, refused once v<v> is tagged: main moves only to release a new version. */
function title(develop: string): string {
  const v = developVersion(develop);
  // Any rev-parse failure reads as "no tag", so this needs the tags in the checkout (release.ts fetches them).
  const tagged = gitSync(['rev-parse', '-q', '--verify', `refs/tags/v${v}`]).status === 0;
  if (tagged) throw new Refusal(`v${v} is already tagged: bump the version on develop to release again`);
  return `Release ${v}`;
}

/** sourceHash of develop's dashboard/ and package-lock.json, read from its tree rather than the checkout. */
function developSourceHash(develop: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-main-update-src-'));
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

/** The main update's commit; `subjectOf` gives its subject, and may refuse (see `title`). */
function buildMain(main: string, develop: string, dist: string, subjectOf: (develop: string) => string): string {
  requireCommit(main, '--main');
  requireCommit(develop, '--develop');
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
  const subject = subjectOf(develop);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-main-update-index-'));
  try {
    // A temporary index, so the checkout's index and working tree are never touched.
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, 'index') };
    git(['read-tree', develop], { env });
    for (const rel of files) {
      // Hashed from the file as built, with no clean filter or attribute that could reshape it.
      const blob = git(['hash-object', '-w', '--no-filters', '--', path.join(dir, ...rel.split('/'))], { env }).trim();
      if (!SHA.test(blob)) throw new Refusal(`git hash-object printed ${JSON.stringify(blob)}`);
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},dashboard/dist/${rel}`], { env });
    }
    const tree = git(['write-tree'], { env }).trim();
    if (!SHA.test(tree)) throw new Refusal(`git write-tree printed ${JSON.stringify(tree)}`);
    // Authored by whoever runs the release, from their git config: they push it.
    const sha = git(['commit-tree', '--no-gpg-sign', tree, '-p', main, '-p', develop, '-F', '-'], { env, input: `${subject}\n` }).trim();
    if (!SHA.test(sha)) throw new Refusal(`git commit-tree printed ${JSON.stringify(sha)}`);
    return sha;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function mainCommit(main: string, develop: string, dist: string): string {
  return buildMain(main, develop, dist, title);
}

/**
 * Whether `commit` has exactly the tree `mainCommit(main, develop, dist)` builds: the release commit's tree plus the
 * checked dist, and nothing else. Commit shas differ by timestamp, but trees are deterministic. Whoever can push
 * the release branch can push a commit shaped like a main update, so a resume compares trees before it vouches for one,
 * and `npm run release` compares the merged head again before it lands the release. By then `v<version>` is tagged,
 * which only stops `mainCommit` from making another main update: the subject is not part of the tree.
 */
export function isMainUpdate(main: string, develop: string, commit: string, dist: string): boolean {
  if (!SHA.test(commit)) return false;
  const tree = (c: string) => git(['rev-parse', '--verify', `${c}^{tree}`]).trim();
  return tree(buildMain(main, develop, dist, (d) => `Release ${developVersion(d)}`)) === tree(commit);
}

/** One line of commit text, safe to print: no control characters, bounded length. */
export const oneLine = (s: string) => {
  const flat = s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
};

/**
 * Non-merge commits on main's first-parent line since its last merge (the last release), that develop
 * doesn't have and that aren't release commits: hotfixes a release undoes unless they were ported.
 */
export function mainOnlyCommits(main: string, develop: string): { sha: string; subject: string }[] {
  requireCommit(main, '--main');
  requireCommit(develop, '--develop');
  const last = git(['log', '--first-parent', '--merges', '-1', '--format=%H', main]).trim();
  const range = last ? [`${last}..${main}`] : [main];
  const log = git(['log', '--first-parent', '--no-merges', '--format=%h%x09%s', ...range, '--not', develop, '--']);
  return log
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const tab = l.indexOf('\t');
      return { sha: l.slice(0, tab).replace(/[^0-9a-f]/g, ''), subject: oneLine(l.slice(tab + 1)) };
    })
    .filter((c) => !isReleaseSubject(c.subject));
}

/** `--name value` pairs, each named flag exactly once; unknown, repeated or missing flags exit 2. */
function flags(args: string[], required: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const [k, v] = [args[i], args[i + 1]];
    const name = k.startsWith('--') ? k.slice(2) : '';
    if (!name || !required.includes(name) || name in out || v === undefined) usage();
    out[name] = v;
  }
  for (const k of required) if (!(k in out)) usage();
  return out;
}

function usage(): never {
  process.stderr.write('usage: node scripts/main-update.ts commit --main <sha> --develop <sha> --dist <dir>\n');
  process.exit(2);
}

function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  const f = cmd === 'commit' ? flags(rest, ['main', 'develop', 'dist']) : usage();
  // Checked before any git call, so `-rf` or `--output=x` never reaches git's argv as an option.
  for (const k of ['main', 'develop']) if (!SHA.test(f[k])) throw new Refusal(`--${k} must be a 40-character lowercase hex sha, got ${JSON.stringify(f[k])}`);
  process.stdout.write(`${mainCommit(f.main, f.develop, f.dist)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`main-update: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
