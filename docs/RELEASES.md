# Releases

How Forge is versioned, which releases get fixes, how a release is cut, and how to pin, verify and roll back an install.

## Versioning

Forge follows [semver](https://semver.org). Below 1.0, a minor release (`0.x` → `0.x+1`) may break any surface below, and a patch release never does. From 1.0, only a major release may. A breaking change is always called out in [CHANGELOG.md](../CHANGELOG.md).

| Surface | What counts as breaking |
|---|---|
| CLI JSON | Renaming or removing a JSON field, an error code or an exit number ([CLI.md](CLI.md#stability)). New commands, flags and fields are additive. |
| `/api/state` and the other `/api/*` endpoints | Removing or renaming a field. Every shape change, additive or not, bumps `API_VERSION`, and a dashboard refuses data from a newer server. |
| The `job.json`, config and event schemas | Dropping a migration, so an older job or config no longer loads, or changing what a field means. New versions migrate older files on read. |
| Config keys | Removing or renaming a key, or changing what a default does. A key is deprecated first (see Deprecation). |
| The agent/skill contract | `/forge` arguments, `forge:<role>` agent names, agents' reply contracts, job file names and spec headers, review lens names, and the tracker adapter contract with `lib/trackers/status.mjs`. |

## Support

Only the latest minor release line gets fixes, security fixes included, as patch releases. Older lines get no backports: upgrade with `forge update`. [SECURITY.md](../SECURITY.md#supported-versions) has the reporting process.

## Deprecation

A config key or CLI flag on its way out is announced in CHANGELOG.md at least one minor release before it is removed. While it still works:

- it is listed in `DEPRECATED_CONFIG_KEYS` in `lib/deprecations.ts`, with the release that deprecated it, the release that removes it and what to use instead, and in [CONFIG.md](CONFIG.md#deprecated-keys) "Deprecated keys";
- `forge doctor` (and Settings › Diagnostics) shows a warning row, `deprecated config key <key>`, whenever it is set in `.forge/config.yml`. A warning never fails the report.

## Releasing

A release is a commit on `main` that changes the `version` in `package.json` and `.claude-plugin/plugin.json` and adds that version's `## <version>` section to CHANGELOG.md. Forge jobs never make that change: the release commit at the end of a wave does.

1. On a branch, bump both versions together and write the CHANGELOG section.
2. Run `npm run release:check`. It fails unless both versions are equal and `X.Y.Z`, CHANGELOG.md has an exact `## <version>` heading with notes and no AI attribution line, the working tree is clean, and `dashboard/dist/` matches its build stamp. CI's `release check` job runs the same check on every PR and push.
3. Open the PR and merge it once CI is green.
4. The merge runs `.github/workflows/release.yml`:
   - **detect** reads the pushed commit. It is a release only when the version differs from the first parent's and no `v<version>` tag exists. Any other push stops here.
   - **verify** runs all of `ci.yml` again on that commit, with a read-only token.
   - **release** builds `forge-<version>.tar.gz` with `git archive` and refuses it unless its `COMMIT` file holds the pushed sha, creates the annotated tag `v<version>` (message `Forge <version>`) on the pushed commit, and publishes the GitHub Release `Forge <version>` with the CHANGELOG section as its body and the archive and its `.sha256` as assets.

**Recovery.** If a run fails, fix the cause and use "Re-run failed jobs" on the same run: detect still sees the version change, and the tag does not exist yet. If a bad tag or Release was published, delete both by hand (`gh release delete v<version> --cleanup-tag`) and ship the fix as the next patch version. Never move a published tag.

## Provenance and pinning

`forge version --json` prints `{"version","commit","installedAs","node"}`. `commit` comes from the first source that has one: the `COMMIT` file a release archive carries (`git archive` stamps it through `.gitattributes` `export-subst`), Claude Code's own install record for a plugin install, then `git rev-parse HEAD` for a clone. Settings › About shows the same commit and install kind. The output is self-reported, so anything that can edit the install can make it claim any commit. The audit anchors are the annotated tag and the archive's `.sha256` in the GitHub Release.

**Verify an archive.** Download `forge-<version>.tar.gz` and `forge-<version>.tar.gz.sha256` from the Release, then run `sha256sum -c forge-<version>.tar.gz.sha256` in that directory (`shasum -a 256 -c` on macOS without coreutils). Extracted, its `COMMIT` file is the tagged commit, and `forge version --json` run from it reports that commit with `installedAs: "unknown"`.

**Pin a version.** Either:

- clone the tag, `git clone --branch v<x.y.z> https://github.com/maxwellmattryan/forge.git`, or
- extract the release archive,

and then load that directory with `claude --plugin-dir <dir>`, or add it as a local marketplace with `claude plugin marketplace add <dir>`. A pinned clone sits on a detached tag, which `forge update` refuses to move.

A marketplace install added from GitHub (`claude plugin marketplace add maxwellmattryan/forge`) follows `main` and cannot pin a version: `claude plugin marketplace add` (Claude Code 2.1.299) takes a URL, a path or a GitHub repo, with no ref.

**Roll back.** In a pinned clone, `git fetch --tags` and `git checkout v<older>`; with an archive, extract the older one. Then start a new Claude Code session (and restart `forge dash`). Jobs and configs written by a newer Forge may not load in an older one; `forge doctor` flags jobs from a newer Forge.

## Release checklist

1. Every job of the wave is merged and CI on `main` is green.
2. On a branch, bump `version` in `package.json` and `.claude-plugin/plugin.json` to the same `X.Y.Z`.
3. Add `## X.Y.Z` to CHANGELOG.md: behaviour changes first, the versions bumped (`API_VERSION`, schemas), deprecations and removals.
4. Run `npm run release:check` and the AGENTS.md verify list.
5. Open the PR, wait for CI (including `release check`), and merge.
6. Watch the `Release` run on `main`: detect, verify, release.
7. Check the Release page: tag `vX.Y.Z` on the merge commit, the CHANGELOG body, `forge-X.Y.Z.tar.gz` and its `.sha256`.
8. Run `forge update` on an install and confirm `forge version --json` and `forge doctor` (no "behind the latest release" warning).
