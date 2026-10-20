# Releases

How Forge is versioned, which releases get fixes, how a release is cut, and how to pin, verify and roll back an install.

## Versioning

Forge follows [semver](https://semver.org). Below 1.0, a minor release (`0.x` → `0.x+1`) may break any surface below, and a patch release never does. From 1.0, only a major release may. A breaking change is always called out in [CHANGELOG.md](../CHANGELOG.md).

In the general form any repo can declare, [CONFIG.md "Release strategy"](CONFIG.md#release-strategy), this is `versioning: semver`, `mechanism: tag`, `registry: none` and `cadence: on-merge`.

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

**Branches.** `develop` is the working branch: jobs and PRs branch from it and merge into it. `main` is what plugin installs follow (`.claude-plugin/marketplace.json` pins the plugin source to `main`, whatever the GitHub default branch is), so it takes only the main-update PR and hotfixes. `dashboard/dist/` is gitignored and absent on `develop`, and nobody builds or commits it by hand for a release: CI adds it in the main-update PR, because an install never builds. Never merge `main` back into `develop`: it would bring `dist/` with it.

**The main-update PR.** Every push to `develop` runs `.github/workflows/main-update.yml`:
- **verify** runs all of `ci.yml` on the develop commit.
- **build**, with a read-only token, runs `npm ci` and `npm run build:dashboard` and uploads `dashboard/dist/` as an artifact.
- **publish**, which holds the only write token and runs no `npm`, downloads the artifact and checks it with `node scripts/main-update.ts commit`: only `index.html`, `manifest.json`, `build-stamp.json` and the `assets/*.js|css|woff2` files the manifest names, no symlinks, and a build stamp that matches both the files and develop's dashboard sources. It refuses, and pushes nothing, when develop already tracks a `dashboard/dist/` path. It then builds one commit, develop's tree plus `dashboard/dist/` with parents `[main, develop]`, force-pushes it to `ci/main-update`, opens the PR `ci/main-update` → `main` or updates the open one, and dispatches `ci.yml` on `ci/main-update`, because a push made with `GITHUB_TOKEN` starts no PR checks of its own.

There is never more than one main-update PR: a later develop push replaces its head commit. Its title is `Release <version>` while `package.json`'s version has no `v<version>` tag, and otherwise `Update main to develop <sha7>`. Its body names the develop commit, the workflow run and the number of dist files, and lists the **main-only commits**: commits on `main` that develop doesn't have, leaving out merges and the bot's own. Each one is a hotfix this PR undoes unless it was ported to `develop` (`No main-only commits.` when there are none). After `main` moves, re-run the workflow on `develop` from the Actions tab (`workflow_dispatch`) to refresh the PR.

**Merge it with a merge commit** ("Create a merge commit"). That keeps develop's history on `main`, which the main-only list relies on. A squash still releases correctly, because detect compares with the first parent. A merge takes the head the PR shows, so look at the head again after a push to `develop`.

**Hotfixes** branch from `main`, carry a rebuilt `dist/` (`npm ci`, `npm run build:dashboard`, then `git add --force dashboard/dist`), merge into `main` through a PR whose `release check` runs `--dist present`, and are then ported to `develop` in a PR without `dist/`. Until the port lands, the main-update PR lists the hotfix as a main-only commit.

1. Every PR merged into `develop` updates the main-update PR. To release, bump both versions together and write the CHANGELOG section in a PR into `develop`; the next main-update PR is titled `Release <version>`.
2. CI runs on the PR head. Its `release check` job runs `npm run release:check -- --dist present` there and on `main`, and `--dist absent` on `develop`. It fails unless both versions are equal and `X.Y.Z`, CHANGELOG.md has an exact `## <version>` heading with notes and no AI attribution line, the working tree is clean, and `dashboard/dist/` is tracked and matches its build stamp (`present`) or is not tracked at all (`absent`).
3. Merge the main-update PR once CI is green.
4. The merge runs `.github/workflows/release.yml`:
   - **detect** reads the pushed commit. It is a release only when the version differs from the first parent's and no `v<version>` tag exists. Any other push stops here.
   - **verify** runs all of `ci.yml` again on that commit, with a read-only token.
   - **release** builds `forge-<version>.tar.gz` with `git archive` and refuses it unless its `COMMIT` file holds the pushed sha, creates the annotated tag `v<version>` (message `Forge <version>`) on the pushed commit, and publishes the GitHub Release `Forge <version>` with the CHANGELOG section as its body and the archive and its `.sha256` as assets.

**Recovery.** If a run fails before the tag step, fix the cause and use "Re-run failed jobs" on the same run: detect still sees the version change, and the tag does not exist yet. If only the publish step failed, the tag already exists, so a re-run stops at the tag step with "Reference already exists". Publish by hand instead, in a clone checked out at the tag: build the notes with `node scripts/release-plan.ts notes > notes.md`, the archive and its `.sha256` as the release job does, then run `gh release create v<version> --verify-tag --title "Forge <version>" --notes-file notes.md forge-<version>.tar.gz forge-<version>.tar.gz.sha256`. If a bad tag or Release was published, delete both by hand (`gh release delete v<version> --cleanup-tag`) and ship the fix as the next patch version. Never move a published tag.

**Repository settings** a maintainer keeps, because the main-update workflow adds no secret and only `github.token`:
- Settings › Actions › General: Workflow permissions "Read repository contents", with "Allow GitHub Actions to create and approve pull requests" ticked, so `publish` can open the PR.
- The `main` branch protection or ruleset requires a PR and the `CI` checks by name, allows merge commits, and turns on "Dismiss stale pull request approvals when new commits are pushed", so an approval never carries over to a replaced head. `ci/main-update` must stay pushable by `github-actions[bot]`.

**Workflow changes.** GitHub can refuse a `GITHUB_TOKEN` push whose commit creates or changes a file under `.github/workflows/` ("refusing to allow a GitHub App to create or update workflow … without `workflows` permission"), and no `permissions:` key grants that scope. The main-update commit has `main` as its first parent, so this can happen whenever `develop` holds a workflow edit that `main` doesn't yet have: the first run after `main-update.yml` lands, and any later PR into `develop` that touches a workflow. `publish` then fails at "Push ci/main-update" with a `Push refused` error, and the open main-update PR keeps its old head. To get past it, a maintainer whose credentials carry the `workflow` scope (`gh auth refresh -s workflow`) builds and pushes the same commit from a clone. Use the run's develop commit and the failed run's URL:

```bash
git fetch origin main develop && git checkout --detach <develop sha>
npm ci && npm run build:dashboard
main="$(git rev-parse --verify 'refs/remotes/origin/main^{commit}')" develop="$(git rev-parse HEAD)"
sha="$(node scripts/main-update.ts commit --main "$main" --develop "$develop" --dist dashboard/dist)"
git push --force origin "$sha:refs/heads/ci/main-update"
node scripts/main-update.ts body --main "$main" --develop "$develop" --run-url <run url> --dist dashboard/dist > body.md
tail -n +2 body.md > pr-body.md
gh pr create --base main --head ci/main-update --title "$(head -n 1 body.md | cut -d= -f2-)" --body-file pr-body.md   # or: gh pr edit <n> --title … --body-file pr-body.md
gh workflow run ci.yml --ref ci/main-update
```

Once that PR merges, `main` holds the workflow files and the workflow pushes on its own again. The alternative, a fine-grained token or GitHub App token with the `workflows` permission stored as a secret, would put a long-lived write credential in the publish job, which this workflow avoids on purpose.

## Releasing a project

`forge release` releases the repos of a project that uses Forge, single- or multi-repo, from each repo's declared [release strategy](CONFIG.md#release-strategy). A human runs it from the CLI; the Foreman never does, though it may approve a job's plan when the project hands it the `release` gate class (Confirmation, below). (Forge's own release is [Releasing](#releasing) above.)

1. `forge release plan` picks the repos, orders them dependencies first and writes the plan to `.forge/runtime/release/`: `release.md` for you to read (steps, checks, rollback) and `release.json` for `run`. It runs nothing: no release command, no registry command, no `git fetch`.
2. `forge release run` runs the steps in order, checking each one, and records each step in `state.json` as it goes. It stops at the first failure. Run it again to resume at the first step not done; finished steps never run again.
3. `forge release status` shows each step's status, the tags and versions its checks recorded (what a rollback needs), the next step, `stale: true` when config or the repos have moved since planning, and `approval: {owner, status}`: who decides the publish steps (`human` or `foreman`) and whether the Foreman has approved this plan (`pending` or `approved`, with `actor` and `at`).

**Which repos.** With no flag, the root repo and every `repos` entry. `--job <id>` takes the job's PR repos (not its verify-only members) whose PR merged (`forge pr sync <id>` records it). An unmerged PR repo that is the consumer of an interim edge is listed under "Not released" with `PR not merged: it waits on its dependencies' release`; any other unmerged PR refuses the plan, and so does a job with no merged PR at all. `--since <tag>` takes the repos where the tag resolves and has commits after it, and refuses when no repo has the tag. A repo with no `release.mechanism`, or (without `--job`) a member whose clone fails doctor's `repo <name>` check, is listed under "Not released" with the reason. A config with problems, or a build cycle between the repos' components, refuses the plan; a cycle that only runtime edges close is ordered by build edges and noted.

**Consumers after a release.** On a `--job` plan, `forge release run` records the release of each dependency repo whose last step reaches done in that run: it logs `interim-released` on the job, as `forge job interim release` would (CONFIG.md "Interim strategies"), which resumes a job waiting on `pr-review` so verify bumps the consumers to it. The version comes only from the checks that run ran, never from `state.json`: a registry check's version, else a tag `<link name>@<version>`, else a tag that is a version itself (`v1.2.0`, `1.2.0`). Several versions at the first level that has any, or none at all, record nothing. The result lists `released: [{ repo, version, recorded, hint? }]`; when `version` is null, `hint` is the `forge job interim release <id> <repo>|--root <version>` command to run by hand. A whole-project or `--since` run records nothing on any job.

**Steps.** Every repo starts with `preflight`: the clone is on its base (`git.base` for the root, `defaultBranch` for a member), has nothing uncommitted, and after `git fetch` equals `<git.remote>/<base>`. Then, by mechanism (**publish** marks an outward-facing step):

| Mechanism | Steps after preflight |
|---|---|
| `tag` | `release`: `release.command`, through the POSIX shell as `forge run` runs commands (**publish**, checked by tag-pushed); then the registry step |
| `cargo-release` | `publish`: `cargo release publish --execute --no-confirm` (**publish**, registry, no check with `registry: none`); `tag`: `cargo release tag --execute --no-confirm` (tagged); `push`: `cargo release push --execute --no-confirm` (**publish**, tag-pushed) |
| `changesets` | `version`: `changeset version`; `stage`: `git add --all`; `commit`: `git commit --message "Version packages"` (clean); `publish`: `changeset publish` (**publish**, tagged); `push`: `git push --follow-tags <remote> HEAD:refs/heads/<base>` (**publish**, tag-pushed) |
| `release-please` | `merge`: you merge the open release PR on GitHub (**publish**, manual, remote-tagged); `sync`: `git merge --ff-only <remote>/<base>` (at-remote); then the registry step |

The registry step, for `tag` and `release-please`: `npm publish` with `registry: npm`, `cargo publish` with `registry: crates.io`, none otherwise. Programs are found on PATH (relative PATH entries are skipped), `changeset` and `release-please` in the clone's `node_modules/.bin` first, and run without a shell in the clone; output goes to your terminal and to `.forge/runtime/release/logs/`. There is no timeout, and stdin is yours, so npm's one-time-password prompt works.

**Checks.** A step with a check is done only when its check passes after the command exits 0: clean (nothing uncommitted), tagged (HEAD carries a tag), tag-pushed (tagged, and the remote has the base at HEAD and every tag at HEAD), remote-tagged (after a fetch, `<remote>/<base>` carries a tag), at-remote (HEAD equals `<remote>/<base>`), registry (`npm view <name>@<version> version`, or `cargo search <name>`, finds the version in the root `package.json` or `Cargo.toml`). A workspace root or a private package has no registry check, and `release.md` says to check by hand. On a resume, and before every step, the check runs first: when it already passes, the step is marked done without running, so a step that published but crashed before its checkpoint never publishes twice. CI that already released (cadence `on-merge` or `scheduled`) is skipped the same way.

**Confirmation.** Each publish step asks `Run it? [y/N]` on the terminal, unless that repo sets `release.publish: allow`. Without a terminal on stdin and stderr, the run stops with `needs_confirmation`, so an agent session stops there too; with `allow`, it does not. The release-please merge always needs a terminal: it prints the instruction and asks `Done? [y/N]`. There is no flag or environment variable that skips the question.

**The Foreman's approval.** A project can hand the decision to the Foreman by moving the `release` gate class: add `release` to `foreman.decides` and remove `gate:release` from `foreman.reserved` (CONFIG.md "Foreman"; the defaults keep it with a human). Then `forge release plan --job <id>` logs a `release-planned` event with the full plan hash and queues one `release` gate request for the office session, once per job and hash; its output's `approval` says who owns the decision. The Foreman's assistant reads `release.md` and the release strategy, and the office records `forge job human <id> approve-release --actor foreman --note "<reason>"`, which re-plans and refuses unless the plan is unchanged, is the job's latest, has a queued request and isn't approved yet, and nothing reserved shows in the job or the note. Without a terminal, `forge release run` then passes each publish step without asking and reports `approvedBy: "foreman"`, but only while that approval is for the plan it just recomputed and the Foreman still decides `release` with nothing reserved; a re-plan with a different hash, or taking the class back, leaves the approval unused. On a terminal it still asks at every publish step, the release-please merge still needs a terminal, and the run itself is still started by a human or CI, never a daemon session. A person approves a release by answering the prompt, not with `approve-release`. The question guards against an accidental publish, for example an agent session that runs `forge release run` by mistake; it is not a security boundary, since a process that fakes a terminal can answer it, and such a process could run the publish command itself anyway.

**Safety.** `forge release run` and `forge release plan --force` are refused in a daemon session, and `run` on native Windows (use WSL2, [SUPPORT.md](SUPPORT.md)). `run` recomputes the plan from config and the clones and refuses when it differs from `release.json` or `state.json`; commands always come from that recomputation, never from the file. One run at a time: `.forge/locks/release/` holds it (exit 3 while another run is alive). `plan` refuses to replace an unfinished run of a different plan unless `--force`, which discards its checkpoints.

**Rollback** is written in `release.md`, last released first, and Forge never runs it. A pushed tag can be deleted (`git push <remote> --delete refs/tags/<tag>`, plus its GitHub Release); a pushed version commit is reverted. Registries limit what can be undone: npm allows `npm unpublish` only within 72 hours and when no other public package depends on the version (otherwise `npm deprecate`), and crates.io never deletes a version, only `cargo yank`s it so new lockfiles skip it.

## Provenance and pinning

Every commit on `main` comes from a merged main-update PR or a hotfix PR, so its `dashboard/dist/` was built by CI (the main-update `build` job) or by the hotfix's author, and checked by `release check` either way.

`forge version --json` prints `{"version","commit","installedAs","node"}`. `commit` comes from the first source that has one: the `COMMIT` file a release archive carries (`git archive` stamps it through `.gitattributes` `export-subst`), Claude Code's own install record for a plugin install, then `git rev-parse HEAD` for a clone. Settings › About shows the same commit and install kind. The output is self-reported, so anything that can edit the install can make it claim any commit. The audit anchors are the annotated tag and the archive's `.sha256` in the GitHub Release.

**Verify an archive.** Download `forge-<version>.tar.gz` and `forge-<version>.tar.gz.sha256` from the Release, then run `sha256sum -c forge-<version>.tar.gz.sha256` in that directory (`shasum -a 256 -c` on macOS without coreutils). Extracted, its `COMMIT` file is the tagged commit, and `forge version --json` run from it reports that commit with `installedAs: "unknown"`. The checksum sits in the same Release as the archive, so it proves integrity, not authenticity: anyone who can edit the Release can replace both. For authenticity, compare the archive with `git archive --format=tar.gz --prefix=forge-<version>/ v<version>` run in a clone, or check that the tag `v<version>` points at the commit in `COMMIT`.

**Pin a version.** Either:

- clone the tag, `git clone --branch v<x.y.z> https://github.com/maxwellmattryan/forge.git`, or
- extract the release archive,

and then load that directory with `claude --plugin-dir <dir>`, or add it as a local marketplace with `claude plugin marketplace add <dir>`. A pinned clone sits on a detached tag, which `forge update` refuses to move.

A marketplace install added from GitHub (`claude plugin marketplace add maxwellmattryan/forge`) follows `main`, through the plugin source in `.claude-plugin/marketplace.json`, and cannot pin a version: `claude plugin marketplace add` (Claude Code 2.1.299) takes a URL, a path or a GitHub repo, with no ref.

**Roll back.** In a pinned clone, `git fetch --tags` and `git checkout v<older>`; with an archive, extract the older one. Then start a new Claude Code session (and restart `forge dash`). Jobs and configs written by a newer Forge may not load in an older one; `forge doctor` flags jobs from a newer Forge.

## Release checklist

1. Every job of the wave is merged into `develop`, each after a green CI run on its PR.
2. In a PR into `develop`, bump `version` in `package.json` and `.claude-plugin/plugin.json` to the same `X.Y.Z`, and add `## X.Y.Z` to CHANGELOG.md: behaviour changes first, the versions bumped (`API_VERSION`, schemas), deprecations and removals. Run `npm run release:check -- --dist absent` and the AGENTS.md verify list, then merge it.
3. Watch the `Main update` run on `develop`, and check that the main-update PR is titled `Release X.Y.Z` and lists no main-only commit that wasn't ported to `develop`.
4. Wait for CI on the PR head (including `release check`), then merge it with a merge commit.
5. Watch the `Release` run on `main`: detect, verify, release.
6. Check the Release page: tag `vX.Y.Z` on the merge commit, the CHANGELOG body, `forge-X.Y.Z.tar.gz` and its `.sha256`.
7. Run `forge update` on an install and confirm `forge version --json` and `forge doctor` (no "behind the latest release" warning).
