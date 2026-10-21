# Second-opinion review C: gates, merge path, CI templates, environment, supply chain

Reviewer: Opus (second opinion). Repo `/Users/maxwellmattryan/dev/repos/forge`, `develop` @ `36cb66f1` (the audit cites `c57e6884`; every line I checked below still matched or is re-cited at its current position). Read-only; nothing ran against the repo's `.forge/`.

Defaults that decide the preconditions (`lib/config.ts` `defaults()`): `merge.auto: false` (l.158), `merge.autoWhen: []`, `foreman.enabled: false`, `foreman.ship: 'propose'` (l.261), `daemon.enabled: false`, `verifyIntegrity: 'warn'` (l.61), `worktrees.copy: []`, `policy.protectedPaths` with escalate on CI, Docker/tf, migrations, lockfiles, `**/.env*`, and refuse on `.forge/config.yml|secrets-allow.txt|trackers/**|ci/**` (l.264-273). `autoMerge(config)` = `merge.auto === true || (foreman.enabled && foreman.ship === 'merge')` (`lib/config.ts:409-411`).

---

## F-03 — Job commands run branch-authored code with the human's full environment

**Verdict: CONFIRMED, and it reaches further than the audit says.**

What's in the code:
- `lib/worktree.ts:436-440` `envFor`: `const env = { ...base }` with `base = process.env`. It deletes only `DAEMON_MARKER` (`/^FORGE_DAEMON(_|$)/`) and `JOB_VARS` (`/^FORGE_(PORT|ENDPOINT|BACKING)_/`). `jobEnv` (l.443-445) adds backing and endpoint vars. Every configured command goes through this: setup at l.188, database commands at l.460, run/verify at l.585-607, background at l.1076.
- `lib/worktree.ts:474-477` `shell()` and `:499` `shellAsync()` spawn `posixShell()` with `['-lc', cmd]`. `posixShell()` (`lib/platform.ts:113`) is `$SHELL`, so this is a **login** shell. zsh `-l` sources `~/.zshenv` and `~/.zprofile`, and bash `-l` sources `~/.bash_profile`. Any token the user exports there is put back into the environment **after** whatever Forge removes. Any env-scrubbing fix has to deal with this.
- `lib/daemon.ts:446-452` `sessionEnv`: `{ ...env, PATH, FORGE_DAEMON: '1', … }` and it deletes only `API_KEY_VARS = ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN']` (l.433). The comment says this is about billing, not secrecy.
- Missed by the auditor: a **declared** secret with source `env` (`secrets.X: { env: MYAPP_DB_PASSWORD }`) is read from `opts.env ?? process.env` (`lib/secret-refs.ts:116-120`), and `envFor` never removes that variable. So it reaches every command of every component, not only the component whose config sink names it. This contradicts what `docs/CONFIG.md` "Secret references" › Briefs promises builders: "values reach commands only through config sinks".
- `docs/CONFIG.md:24` lists `.env` as an example under `worktrees.copy`. The default is `[]`, so nothing is copied unless a human opts in.
- `test/command-env.test.ts:16` pins the current behaviour: "command env drops the daemon markers and keeps everything else".

Where it matters. In an interactive session the builder already has unrestricted Bash with the same environment, so verify adds almost nothing. Under the daemon the session's own Bash is limited to `forge` and a few git/gh forms, and `env`/`export` are not allowed (`docs/ARCHITECTURE.md` "Daemon security"). But `Edit`/`Write` are unscoped and `forge verify` is `Bash(forge:*)`. Writing a test file and running `forge verify` therefore takes a session from narrow Bash to arbitrary code with the human's full environment. That escalation is the real issue. The code can also read `~/.config/gh/hosts.yml`, `~/.npmrc` and `~/.aws/credentials` directly, so env hygiene narrows the exposure but does not bound it.

**Severity: Medium. I agree.** It needs `daemon.enabled` (opt-in) to be more than "the builder could have run `env` anyway". With the daemon on it turns tracker-text injection into secret exfiltration before any reviewer runs.

| # | Fix | Verdict | Notes | Effort |
|---|---|---|---|---|
| A1 | Env allowlist for configured commands plus `commands.env.inherit` | AMEND | Right shape, but by itself it does not work: `sh -lc` re-sources the login profile, so the allowlisted env gets refilled. It also needs `-l` dropped (or a `commands.loginShell` switch defaulting to off), which breaks repos that rely on profile-set `PATH` (nvm, rustup, pyenv). The UX cost is high: `JAVA_HOME`, `ANDROID_HOME`, `SSH_AUTH_SOCK`, `HTTP(S)_PROXY`, `CARGO_HOME`, `GOPATH` and more. A new config key needs a `CONFIG_SCHEMA_VERSION` bump, a migration, `docs/CONFIG.md` and a `config-fields.ts` entry (locked: it widens what commands get). Ship it as an opt-in strict mode, not the default. | M |
| A2 | Pattern denylist plus `HOME` pointed at a scratch dir | AMEND | KEEP the denylist (`*_TOKEN`, `*_SECRET*`, `*PASSWORD*`, `*_API_KEY`, `AWS_*` except `AWS_REGION`/`AWS_PROFILE`, `GH_TOKEN`, `GITHUB_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `CARGO_REGISTRY_TOKEN`). DROP the `HOME` redirect: it breaks git identity, rustup/cargo/nvm caches and `gh`, and a login shell reads the real home's profile before `HOME` matters anyway. Note that the denylist is also undone by `-lc` for profile-exported vars, so document that. | S |
| A3 | Never copy `.env*` unless listed explicitly; doctor warns | KEEP (docs) | The default is already `[]`. The change is to take `.env` out of the `docs/CONFIG.md:24` example and add a doctor warning when `worktrees.copy` matches `**/.env*`. `**/.env*` is already escalate-protected on commit. | S |
| A4 (new) | Strip the source variables of declared `secrets.*.env` entries in `envFor`, so a declared secret reaches a command only through its sink | — | Makes the code match the documented promise. Nothing in config changes. Resolution still reads `process.env` in the forge process, which is unaffected. | S |
| A5 (new) | Under `FORGE_DAEMON=1` only, apply A2's denylist and run commands with `sh -c` (no `-l`); the human's own interactive verify keeps today's behaviour | — | Targets exactly the escalation above. The daemon already changes git behaviour (hooks off), so a different command env there fits. The cost: daemon verify can't rely on profile-set PATH. `daemon.command`'s PATH is inherited anyway because the supervisor started from the human's shell. | S |
| A6 (new) | Opt-in OS sandbox for verify (`sandbox-exec` on macOS, `bwrap` on Linux) with no network and read-only `$HOME` | — | The only fix that also covers dotfile credentials. Platform-specific, with no new dependencies. | L |

**Recommended:** A4 plus A5 now (both S, no shape change, aimed at the daemon escalation), with A3 as docs and doctor. Keep A1 as a later opt-in strict mode, and only together with dropping `-l`.

**Tests:** extend `test/command-env.test.ts`: (1) a declared `secrets.X.env` source variable is absent from `envFor`/`jobEnv` output but still resolves through a sink; (2) under `FORGE_DAEMON=1`, `GH_TOKEN`/`NPM_TOKEN`/`AWS_SECRET_ACCESS_KEY` are absent from a `forge run` child's env and `AWS_REGION` stays; (3) under the daemon the spawned argv is `-c`, not `-lc`. The existing "keeps everything else" test has to be narrowed in the same PR.

---

## F-05 — Auto-merge decided by agent-written decision.md; `merge.autoWhen` never evaluated

**Verdict: CONFIRMED. The real gap is wider than the audit describes (see M1 and M2 below).**

What's in the code:
- `lib/step/input.ts:111`: `autoMerge: /^\s*(?:[-*]\s*)?Auto-merge eligible:\s*yes\b/im.test(read('decision.md') ?? '')`. This is re-read from the **live file** on every step.
- `lib/step/stages/pr.ts:98-105` `mergeable()`: `!local && !held && !draft && x.decision.autoMerge && autoMerge(x.config) && !j.protectedPaths?.hits?.length && <no merge event since the last open>`. It does **not** check that the decision is `APPROVE`, and `j.protectedPaths` comes from `job.json`.
- `lib/step/stages/pr.ts:172` PR4 runs `forge pr merge <id>`.
- `lib/pr.ts:1561-1615` `mergeOne` checks, in order: PR state (MERGED/CLOSED); the **head pin** (`head !== pushedSha` while `policyRules(config).length`, l.1569-1576, skipped by `--now`); the CI rollup through `mergeAction` (l.1501-1515: `passing` merges, `failing` is refused, `none` without workflows on the base merges, everything else is auto or deferred); no `--auto` while a policy exists (l.1584); `--match-head-commit` (l.1595). It does **not** check `merge.auto`, `decision.md`, the decision event, review verdicts, the security lens, `alwaysEscalate` or `autoWhen`.
- `lib/brief.ts:300-301`: `alwaysEscalate` and `autoWhen` reach the approver only as brief lines. `agents/approver.md` "Decide" holds the rule in prose.
- The auditor's precondition holds: opt-in only (`merge.auto: false`, `foreman.ship: 'propose'` by default).
- Two attack-scenario details. The `package.json` `scripts` edit *is* detected by `lib/integrity.ts:162-186` (`packageJsonDetail`) and shown to the approver in `verify/round-N.md`, but only as `warn` by default. And `alwaysEscalate` already lists "new or upgraded dependencies" by default. So the scenario needs an approver that ignores visible evidence. That is plausible under injection, but it is not the silent path the audit implies.

**Severity: Medium. I agree** for this finding as scoped (opt-in). M1 below is the same class of problem without needing the approver at all.

| # | Fix | Verdict | Notes | Effort |
|---|---|---|---|---|
| B1 | Machine-form `autoWhen` (`paths`, `maxChangedLines`, `lenses`) evaluated in `step` | AMEND | Right long-term design. A migration that turns old string entries into "never auto" silently switches off auto-merge for every current user. Instead, keep strings as approver prose and add machine conditions as an extra AND when present. Evaluate them in `pr merge` (B5), not only in step, or a direct `forge pr merge` skips them. Needs a `CONFIG_SCHEMA_VERSION` bump, a migration and `docs/CONFIG.md` "Merge". | M–L |
| B2 | Require the security lens on the panel and PASS in the final round | AMEND | The default security lens is conditional (`when: input handling, auth, …`, `lib/config.ts:131`), so requiring it ends auto-merge for docs-only changes, which is the main use of `autoWhen`. Better: require that **every lens selected for the final round passed on the head being merged** (bind the verdicts to the sha), and require `security` only when the diff touches non-doc paths. Note that verdict files are also job-dir files the session can write. | S–M |
| B3 | A built-in escalate floor in `pr merge`: `.forge/**`, instruction files, `package.json` scripts, lockfiles, CI | KEEP | Code-enforced, and costs nothing in the common case. Reuse `integrity.ts` `configEdits` for the "scripts/test config changed" signal instead of a second path list. Lockfiles and CI are already escalate defaults, so B3 mainly adds `.forge/**`, `CLAUDE.md`/`AGENTS.md`, and script or test-config edits, and it holds even if a human removed them from `protectedPaths`. | S |
| B4 (new) | Bind eligibility to the **recorded** decision: `forge job decision` logs `{decision, autoMerge, head}`, and PR4 needs the last `decision` event to be `APPROVE` with `autoMerge: true` and `head` equal to the PR head being merged; any later commit (a PR rework) clears it | — | Closes M2. It is an event-shape addition, so per AGENTS.md add it to `lib/types.ts`, keep normalisers tolerant and bump the version if events are versioned there. Older events without `head` read as "not eligible", which fails closed. | S–M |
| B5 (new) | Move the eligibility predicate into `mergePr` itself: without `--now`, `pr merge` refuses unless `autoMerge(config)` and B4 hold, with protected hits **recomputed** rather than read from `job.json`; under `FORGE_DAEMON=1` (any scope, not only office) refuse `--now` outright | — | Closes M1. It follows the existing pattern of daemon refusals (`lib/commands/budget.ts:41`, `job.ts:391/397/764`, `release.ts:71`). Step's PR4 runs in-process in the daemon session, so the predicate, not the scope, has to be what lets it through. | S |
| B6 (new) | Document required reviews and required status checks in branch protection as the backstop: GitHub then refuses `gh pr merge` without a human review | — | Out of Forge's code, but it is the only control a misled session cannot touch. Goes in `docs/CONFIG.md` "Merge". | S |

**Recommended:** B5 plus B4 plus B3 now: all S, all code-enforced, closing M1 and M2 along with the audit's case. Add B6 to the docs. B1 is the follow-up design, with B2 folded in as "all selected lenses passed on this sha".

**Tests:** in `test/step.test.ts`, one row per rule: PR4 does not fire when (a) `decision.md` says `ESCALATE` plus `Auto-merge eligible: yes` and the escalation was cleared; (b) `decision.md` was edited to `yes` after the `decision` event recorded `no`; (c) a commit landed after the decision (PR rework). In `test/pr.test.ts` with the fake `gh`: `mergePr` under `FORGE_DAEMON=1` refuses `--now` and makes no `gh pr merge` call; `mergePr` without `--now` refuses when `merge.auto` is false or no eligible `decision` event exists; `job.json` `protectedPaths: null` does not bypass a recomputed hit.

---

## F-08 — The seeded CI release gate runs the PR's own copy of the gate script

**Verdict: CONFIRMED, but the severity is overstated, and fix 1 as written breaks two cases.**

What's in the code: `templates/release-gate/forge-release-gate.yml` has `on: pull_request: {}` and `merge_group: {}`, `permissions: contents: read`, a pinned `actions/checkout` with `persist-credentials: false`, and `run: node .forge/ci/release-gate.mjs`. The script and the workflow both come from the PR's merge ref. `.forge/ci/**` is a refuse default (`lib/config.ts:272`) and the workflow is under `.github/workflows/**` escalate, so Forge's own builders can't touch either one. `test/release-gate-init.test.ts:112-130` pins `run === 'node .forge/ci/release-gate.mjs'` and `checkout.with` deep-equal `{ 'persist-credentials': false }`.

Why the severity is lower: the gate exists to stop someone merging a consumer while an interim pin remains ("whoever merges it", per the script header). It guards against mistakes. A PR author who wants to defeat it can just as easily edit the **workflow file** in the same PR, which fix 1 cannot prevent, as the auditor notes. Only code-owner review or a ruleset-required workflow binds that author. No token or secret is exposed.

**Severity: Low** (the auditor said Medium). It is an integrity bypass of a mistake guard, it needs a deliberate PR author, and the fix that actually binds that author (CODEOWNERS or rulesets) lives in repository settings.

| # | Fix | Verdict | Notes | Effort |
|---|---|---|---|---|
| C1 | `git fetch origin "$GITHUB_BASE_REF" && git show …` and run from `$RUNNER_TEMP` | AMEND | (1) `GITHUB_BASE_REF` is empty on `merge_group`, so the gate fails or misbehaves in merge queues. (2) With `persist-credentials: false`, `git fetch` fails on **private** repos. Instead: a second `actions/checkout` step at the same pinned SHA with `ref: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}`, `path: .forge-gate-base`, `sparse-checkout: .forge/ci`, `persist-credentials: false`, then `node .forge-gate-base/.forge/ci/release-gate.mjs` with the cwd still at the PR checkout (the script reads `git ls-files` from cwd). The expression stays in `with:`, never in `run:`. If the base has no script (the first PR that adds the gate), fall back to the PR's copy with a warning. | S |
| C2 | Seed a `CODEOWNERS` line for `.forge/ci/**` and the workflow; tell the human to require code-owner review | AMEND | A seeded `CODEOWNERS` can collide with an existing one, and "only when it doesn't exist" means most repos get nothing. Better: print the two lines in `RELEASE_GATE_WARNING` and `docs/CONFIG.md` "Release gate", and have `forge doctor` warn when a CODEOWNERS file exists but covers neither path. | S |
| C3 | A reusable workflow in the Forge repo, pinned by SHA | DROP | It adds a cross-repo trust dependency on Forge's repo for every consumer, against the posture. The workflow file in the consumer is still PR-editable, so it fixes nothing that C1 doesn't. | M |
| C4 (new) | Document GitHub rulesets "Require workflows to pass" (org rulesets point at a workflow on a protected ref, which the PR can't edit) as the binding option for orgs | — | The only option that also stops edits to the workflow file. | S |
| C5 (new) | Under `pull_request`, also fail the gate if the PR's diff touches `.forge/ci/release-gate.mjs` or the gate workflow, unless a label a maintainer set is present | — | Turns a silent bypass into a visible red check, though a PR that rewrites the workflow avoids it. Plain JS in the template, no dependencies. | S |

**Recommended:** C1 as amended (base-ref script through a second checkout) plus C2 as doc and doctor guidance, mentioning C4 for orgs.

**Tests:** update `test/release-gate-init.test.ts`: two checkout steps, both pinned to the same SHA, both `persist-credentials: false`; the base checkout's `ref` expression covers both `pull_request` and `merge_group`; `run` executes the base path; no `${{` inside any `run`. Add a `test/release-gate-script.test.ts` case showing that run from a different cwd, the script scans the cwd's tracked files, not its own directory's.

---

## F-14 — The no-AI-attribution PreToolUse hook is bypassable

**Verdict: PARTIALLY CORRECT.** I ran the regex from `hooks/no-ai-attribution.ts:9` (`/\b(git\s+(commit|tag|notes|merge)|gh\s+(pr|issue|release|api|gist)|glab\s+…)\b/`):
- Bypasses: `git -c k=v commit`, `git -C dir commit`, `git --no-pager commit`, `gh -R o/r pr create`.
- Do **not** bypass: `command git commit`, `\git commit`, `/usr/bin/git commit`, `sh -c "git commit"`. All of these still contain `git commit` at a word boundary. The audit's `command git` and `\git` examples are wrong.
- Missed, and verified: `referencedFiles` (l.26) needs whitespace after the flag, so `git commit --file=msg.txt`, `-Fmsg.txt` and `gh pr create --body-file=b.md` match PUBLISHING but the file is never read. The message is unchecked.
- Missed, and verified: `repoAllows(cwd)` (l.11-21) walks up from the Bash cwd to the first `.forge/config.yml`. In a job worktree that is the **worktree's** copy, which the builder can edit without committing (the refuse rule binds only `forge git add|commit`). Writing `aiAttribution: allow` there turns the hook off for that session.

Backstops that hold: `forge pr open` scrubs commits and PR bodies (`lib/pr.ts:240-249, 504, 827`), and `forge git commit` checks the message. The unprotected surfaces are `gh pr comment`, `gh issue comment` and `gh release` from interactive agents.

**Severity: Info. I agree.** It is a policy aid. The daemon's allowlist already blocks raw `git commit` and `gh … comment`.

| # | Fix | Verdict | Notes | Effort |
|---|---|---|---|---|
| D1 | Match `git(\s+-[^\s]+(\s+\S+)?)*\s+(commit|…)` and strip `command`/backslash | AMEND | The global-option part is right. Also cover `gh` global flags (`-R`, `--repo`). The `command`/backslash part isn't needed: those forms already match. | S |
| D2 | Treat any command containing `git` or `gh` as publishing when the text matches | KEEP (as the simpler alternative) | `findAttribution` only fires on attribution text, so the false-positive cost is small: a `git log` whose output matches isn't the input. This is simpler and sturdier than D1. | S |
| D3 (new) | Accept `--flag=value` and attached `-Fvalue` in `referencedFiles` | — | Closes the file bypass. | S |
| D4 (new) | `repoAllows` reads `.forge/config.yml` from the **main checkout** (`git rev-parse --git-common-dir` → its parent), never a worktree's copy | — | Closes the worktree opt-out. Use a no-shell `git` call with a timeout. | S |

**Recommended:** D2 plus D3 plus D4 (all S).
**Tests:** in `test/attribution.test.ts`, which already spawns `HOOK`: rows for `git -c x=y commit -m "<attr>"`, `gh -R o/r pr comment 1 -b "<attr>"`, `git commit --file=<tmp with attr>`, and a worktree whose own `.forge/config.yml` says `aiAttribution: allow` while the main checkout's says forbid (blocked).

---

## F-19 — Plugin installs follow `main` with no signature or checksum

**Verdict: CONFIRMED as described.** `.claude-plugin/marketplace.json` has `"ref": "main"`. `lib/update.ts:133` runs `claude plugin marketplace update` and `claude plugin update`. `release.yml` `release` job: `permissions: contents: write`, with `actions/checkout` and `actions/setup-node` pinned and `node scripts/release-plan.ts notes` all running in the write-token job (`.github/workflows/release.yml:56-72`). One more detail: a hotfix PR merged into `main` reaches installs without a version change, tag or Release (`docs/RELEASES.md:55`), so "installs get released versions only" (`docs/RELEASES.md:34`) isn't strictly true.

**Severity: Info. I agree**, with the caveat that the threat that matters is a compromise of whoever can push `main` (maintainer credential or ruleset bypass), and no checksum published by the same pipeline helps against that.

| # | Fix | Verdict | Notes | Effort |
|---|---|---|---|---|
| E1 | Point the marketplace at the latest `v*` tag, or at a `release` branch moved only by `release.yml` | AMEND | The tag form works: the release commit can carry `"ref": "vX.Y.Z"` because the version is known at commit time. Installs fail to resolve during the CI window before the tag exists, and hotfixes then need a version bump, which is arguably good. The branch-moved-by-`release.yml` form likely **fails**: `GITHUB_TOKEN` can't update a ref to a commit that changes `.github/workflows/` (the same limit `docs/RELEASES.md:51` cites for pushes). Pick the tag form. | S |
| E2 | `forge update` verifies the fetched tree against the Release's `.sha256` | DROP | The checksum is published by the same token and pipeline it would "verify", so it adds nothing against the residual that matters. It also covers only `forge update`, not `/plugin update`. | M |
| E3 | Split the release job so tagging and publishing run in a job that runs nothing but `gh` | KEEP | Build the archive and notes in a `contents: read` job and pass them as an artifact (fetched with `gh run download`, not a third-party action). The write job then has no checkout and no setup-node, and does `gh release create vX --target $SHA --notes-file … archive sha256`. This closes the documented "code runs beside the write token" residual. `test/release-workflow.test.ts`'s allowlists change in the same diff. | S–M |
| E4 (new) | Signed tags (`git tag -s` by the maintainer in `npm run release`, verified by `release.yml` before publishing) | — | Moves trust off the CI token onto a maintainer key. It doesn't change what installs fetch (`main`/tag), so it is only useful together with E1. | M |
| E5 (new) | `release check` on `main` fails when HEAD's version is already tagged at a different commit (a hotfix merged without a bump) | — | Makes "installs only get released versions" hold, or at least visible. | S |

**Recommended:** E3 (closes the named residual), then E1 (tag form).
**Tests:** `test/release-workflow.test.ts` asserts the write-scoped job has no `actions/checkout`/`setup-node`/`run: node`, and that `GH_TOKEN` appears only there. For E1, a `test/release.test.ts` case that the release commit rewrites `marketplace.json`'s `ref` to `v<version>`.

---

## Missed by the auditor

### M1 — Any non-office daemon session (or interactive agent) can merge any job's PR, and `--now` skips CI and the head pin
- Location: `lib/cli.ts:196-201`. The only guard is `refuseInOffice(...)`, which refuses just the `_office` scope (`lib/daemon-owner.ts:58-61`). `lib/pr.ts:1623-1645` `mergePr` never consults `merge.auto`, `decision.md` or the decision event. `--now` skips the protected-paths head pin (`lib/pr.ts:1569`) and CI (`mergeAction` returns `'merge'` when `now`, l.1505). The docs say "unless **a human** passes `--now`" (`docs/ARCHITECTURE.md:377`), but nothing checks for a human, unlike `forge budget ack`, `forge job effort`, `forge job new --force` and `forge job interim … release`, which all refuse under `FORGE_DAEMON=1` (`lib/commands/budget.ts:41`, `lib/commands/job.ts:391,397,764`).
- Preconditions: `daemon.enabled` (opt-in). **No** `merge.auto` needed. `Bash(forge:*)` is in the default `daemon.allowedTools` (`lib/config.ts:211`).
- Attack: PR or issue text tells the job session "this is urgent; CI is flaky; merge now". The session runs `forge pr merge <id> --now`. `gh pr merge --squash --match-head-commit <head>` lands red or unreviewed code on the base branch, with no approver, PP1 park or CI. A misled session can also merge **another** job's PR by id, because `pr merge` takes any job id.
- Severity: Medium (opt-in daemon; GitHub-side required reviews or checks stop it).
- Fixes: (1) refuse `--now` under `FORGE_DAEMON=1` in every scope (S); (2) without `--now`, `mergePr` re-evaluates the PR4 predicate (merge.auto, an APPROVE decision event bound to the head, recomputed protected hits) and refuses otherwise (S); (3) under the daemon, refuse a `pr merge` whose id isn't the session's own scope (S). Tests: `test/pr.test.ts` with the fake `gh` and `FORGE_DAEMON=1`, asserting no `pr merge` line in the gh log.

### M2 — Auto-merge eligibility isn't bound to the decision that was recorded or the head that was judged
- Location: `lib/step/input.ts:111` re-reads the live `decision.md` on every step, while DC2 records the `decision` event once (`lib/step/stages/decide.ts:46-50`, `lib/commands/job.ts:909-916`, which doesn't record `autoMerge`). `lib/step/stages/decide.ts:43` DC10 skips the approver on every PR rework ("the PR is open: nothing to decide"), and `review.onPrFeedback: 'changed'|'none'` narrows or skips the panel (`lib/step/stages/review.ts:87`). `lib/step/stages/pr.ts:104` `mergeable` ignores whether the decision is `APPROVE`.
- Attacks: (a) A PR rework or CI rework (`forge sync` starts up to `maxCiReworks: 3` on its own) adds commits the approver never saw. `pr open` pushes them as `pr-updated`, which resets `openedAt`, and PR4 auto-merges on the original `Auto-merge eligible: yes`. (b) The session or a later agent edits `decision.md` to `yes` after the approver wrote `no`. (c) The approver writes `ESCALATE: … / Auto-merge eligible: yes`, a human clears the escalation intending to review the PR, and PR4 merges it.
- Preconditions: `autoMerge(config)` true (opt-in).
- Severity: Medium when auto-merge is on (unreviewed rework code merges unattended); otherwise none.
- Fixes: (1) record `{decision, autoMerge, head}` in the `decision` event and have PR4 require `APPROVE`, `autoMerge`, and `head ==` the head being merged (S–M); (2) when `autoMerge(config)`, a PR rework clears eligibility, so DC10 sends the job back to the approver instead of to `pr` (S); (3) PR4 requires `x.decision.decision === 'APPROVE'` (S, a one-liner). Tests: `test/step.test.ts` rows for (a), (b) and (c).

### M3 — The "no CI" heuristic only knows GitHub Actions, and a partial rollup counts as passing
- Location: `lib/pr.ts:1248` `summarizeChecks`: `state = failing ? 'failing' : pending ? 'pending' : rollup.length ? 'passing' : 'none'`, so one finished check with nothing pending is `passing`, however many checks haven't registered yet. `lib/pr.ts:1508-1510` `mergeAction`: `none` and `!hasWorkflows` gives `'merge'`. `lib/pr.ts:1523-1537` `hasCiWorkflows` looks only at `.github/workflows/*.y?ml`, even though Forge's own protected-paths defaults name `.gitlab-ci.yml`, `Jenkinsfile` and `.circleci/**` (`lib/config.ts:265`).
- Attack (no attacker needed, but a builder misled by injected text benefits): on a repo whose CI is CircleCI, Buildkite or Jenkins reporting commit statuses, PR3 pushes and PR4 runs `forge pr merge` straight after. The rollup is still empty, `hasWorkflows` is false, and the PR merges before CI starts. On an Actions repo with a fast job (the seeded `release gate`, a labeler) and a slower external status, the rollup reads `passing` once the fast one finishes.
- Preconditions: `autoMerge(config)` true, or an agent running `pr merge`; and no branch protection with required checks (which would make GitHub refuse).
- Severity: Low–Medium.
- Fixes: (1) `hasCiWorkflows` also treats `.circleci/`, `.gitlab-ci.yml`, `Jenkinsfile`, `.buildkite/` and `azure-pipelines.yml` on the base as "has CI" (S); (2) add a `merge.requiredChecks: [names]` config key that `mergeAction` needs all present and passing, falling back to the branch-protection required contexts from `gh api` (M; config bump); (3) never direct-merge on `none` unless the PR's head is older than N minutes with still no checks (S). Tests: `test/pr.test.ts` `hasCiWorkflows` rows for a base with `.circleci/config.yml`; `mergeAction` rows for a partial rollup once required checks exist.

Also checked, nothing found: `main-update.yml` builds only on a `develop` push, with `contents: read`, pinned actions and `persist-credentials: false`. `scripts/main-update.ts` re-checks the artifact against develop's sources and `head_sha` (`docs/RELEASES.md:44`). The one install-script devDependency is `fsevents` (macOS-only, inert on the Ubuntu runner). Unreviewed `dist/` can only reach `main` through a hotfix PR, whose `release check` is the documented control. Verifiers and lens checklists are read from the main checkout (`lib/step/input.ts:124`, `lib/member-panel.ts:151`), so a branch can't weaken them in its own worktree. Branch edits to `package.json` scripts or test config show up in the integrity report (`lib/integrity.ts:162-186`, `warn` by default), and the main-checkout and instruction-file side belongs to F-01/F-02.

---

## Notes for the synthesizer

| ID | Auditor severity | My severity | Verdict | Recommended fix |
|---|---|---|---|---|
| F-03 | Medium | Medium | CONFIRMED; wider (login shell `-lc` re-sources profile exports; declared `secrets.*.env` vars leak to every command) | Strip declared secret-source vars in `envFor`; under the daemon, denylist token-like vars and use `sh -c`; doc and doctor for `.env` copy; allowlist only as an opt-in strict mode |
| F-05 | Medium | Medium | CONFIRMED; the real gap is `pr merge` itself (M1) and decisions not bound to a head (M2) | Put the PR4 eligibility predicate inside `mergePr` (APPROVE decision event bound to the head, recomputed protected hits, built-in escalate floor); refuse `--now` under the daemon; machine-form `autoWhen` later |
| F-08 | Medium | Low | CONFIRMED, overstated (a mistake guard; the workflow file is equally PR-editable); fix 1 breaks `merge_group` and private repos | Second pinned checkout of the base sha with `sparse-checkout: .forge/ci`; CODEOWNERS and ruleset guidance in the warning and docs |
| F-14 | Info | Info | PARTIALLY CORRECT (`command git` and `\git` are not bypasses; missed `--file=`/`--body-file=` and the worktree `aiAttribution: allow` opt-out) | Match any git/gh command; parse `--flag=value`; read `aiAttribution` from the main checkout |
| F-19 | Info | Info | CONFIRMED; fix 2 adds nothing and the branch variant of fix 1 likely fails on workflow changes | Split the write-token job so it runs only `gh`; point the marketplace at `v<version>` tags |
| M1 (new) | — | Medium | `forge pr merge [--now]` callable by any non-office daemon session: no daemon refusal, `--now` skips CI and the head pin, and any job id works | Refuse `--now` under `FORGE_DAEMON=1`; `mergePr` re-evaluates the PR4 predicate; daemon merges only its own scope |
| M2 (new) | — | Medium (when auto-merge is on) | PR4 reads live `decision.md`, ignores ESCALATE, and keeps the yes across PR or CI reworks that skip the approver (DC10) | Record `{decision, autoMerge, head}` at DC2; PR4 requires APPROVE plus a head match; reworks clear eligibility |
| M3 (new) | — | Low–Medium | "No CI" is detected only for GitHub Actions; a partial rollup counts as passing | Recognise non-Actions CI configs on the base; optional `merge.requiredChecks` / branch-protection required contexts |
