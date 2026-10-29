// The two decisions .github/workflows/release.yml takes from the repo on a push to develop, run in the checkout of
// its read-only jobs:
//   node scripts/release-plan.ts detect   (detect) prints `version=<v>` and `release=<true|false>` for $GITHUB_OUTPUT:
//                                         a release when the version differs from the first parent's and is untagged
//   node scripts/release-plan.ts notes    (build) prints the version's CHANGELOG section of the merged commit,
//                                         the Release body, frozen in the release commit and reviewed in the PR diff
// Repo text reaches the workflow only through these, and only after validation (docs/RELEASES.md).
import fs from 'node:fs';
import path from 'node:path';
import { findAttribution } from '../lib/engine/guard/attribution.ts';
import { gitSync } from './git.ts';
import { changelogSection, hasNotes } from './release-check.ts';

const SEMVER = /^\d+\.\d+\.\d+$/;

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const git = (...args: string[]) => gitSync(args);

/** The version as a plain X.Y.Z, or exit before anything reaches stdout (it becomes a step output). */
function currentVersion(): string {
  let v: unknown;
  try {
    v = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))?.version;
  } catch (e) {
    fail(`cannot read package.json: ${(e as Error).message}`);
  }
  if (typeof v !== 'string' || !SEMVER.test(v)) fail(`package.json version ${JSON.stringify(v)} is not X.Y.Z`);
  return v;
}

/** A release is a push whose version differs from its first parent's and has no tag yet. */
function detect(): void {
  const version = currentVersion();
  let previous: unknown = null;
  const parent = git('show', '--no-textconv', 'HEAD^:package.json');
  if (parent.status === 0) {
    try {
      previous = JSON.parse(parent.stdout)?.version ?? null;
    } catch {
      previous = null;
    }
  }
  const changed = previous !== version;
  const tagged = git('rev-parse', '-q', '--verify', `refs/tags/v${version}`).status === 0;
  const release = changed && !tagged;
  const why = !changed ? `version ${version} is unchanged` : tagged ? `v${version} is already tagged` : `version ${JSON.stringify(previous)} -> ${version} and v${version} is not tagged`;
  process.stdout.write(`version=${version}\nrelease=${release}\n`);
  process.stderr.write(`${release ? 'release' : 'no release'}: ${why}\n`);
}

function notes(): void {
  const version = currentVersion();
  let text = '';
  try {
    text = fs.readFileSync(path.join(process.cwd(), 'CHANGELOG.md'), 'utf8');
  } catch {
    fail('CHANGELOG.md is missing');
  }
  const section = changelogSection(text, version);
  if (section === null) fail(`CHANGELOG.md has no "## ${version}" heading`);
  if (!hasNotes(section)) fail(`CHANGELOG.md "## ${version}" has no notes`);
  if (findAttribution(section).length) fail(`CHANGELOG.md "## ${version}" has an AI attribution line`);
  process.stdout.write(`${section}\n`);
}

const [cmd, ...extra] = process.argv.slice(2);
if (cmd === 'detect' && !extra.length) detect();
else if (cmd === 'notes' && !extra.length) notes();
else fail('usage: node scripts/release-plan.ts detect|notes', 2);
