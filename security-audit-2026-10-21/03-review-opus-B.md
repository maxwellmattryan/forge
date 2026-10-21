# Second-opinion review B: daemon authority, persistence, cost control

Repo `/Users/maxwellmattryan/dev/repos/forge`, `develop` @ `36cb66f1` (the audit cites `c57e6884`; the cited lines still match). Read-only on the repo. The Claude Code behaviour claims below were checked with throwaway `claude -p --model haiku --permission-mode default` runs (Claude Code 2.1.302 locally; CI pins 2.1.299) in a scratch cwd under the scratchpad and a scratch dir under `$HOME`, which was deleted afterwards. Nothing ran against the repo's `.forge/`.

**What the probes showed.** With `--allowedTools Write,Edit,Read` (bare names, as in `defaults().daemon.allowedTools`), `permission_denials` came back empty, and the following were written with no prompt:
- inside the cwd: `CLAUDE.md`, `.forge/notes/learnings.md`, `.forge/reviewers/security.md`, `.forge/ci/release-gate.mjs` and `.githooks/pre-push`;
- outside the cwd: a plain file under `$HOME/...`, `<dir>/.ssh/config`, `<dir>/Library/LaunchAgents/x.plist`, `<dir>/.config/gh/config.yml`, `<dir>/.gitattributes` and another repo's `<dir>/repo/.forge/config.yml`.

Claude Code treated these as "sensitive files" and refused them (in the daemon they would become a dashboard prompt through `--permission-prompt-tool stdio`): `.gitconfig`, `.config/git/config`, `.npmrc`, `.zshenv`, `repo/.git/config` and `.claude/settings.json`.

A scoped allow `Edit(//<abs>/cwd/**),Edit(//<abs>/wt/**)` (no bare `Write`) allowed `Write` inside both trees and refused it outside. Edit rules cover the Write tool, and absolute rules need the `//` prefix.

---

## F-02: Daemon `Write`/`Edit` can persist into the main checkout's learnings, notes, checklists, evals, CI gate and `CLAUDE.md`

**Verdict: CONFIRMED in substance. Two details are off.**

The cited code is as quoted:
- `lib/daemon.ts:227-235` `DENY_TOOLS` lists only `Edit(.forge/config.yml)`, `Edit(.forge/trackers/**)`, `Edit(.forge/secrets-allow.txt)`, `Edit(.forge/verifiers/**)`, `Edit(.forge/runtime/spend.json)` and `Edit(.forge/runtime/audit.jsonl)`.
- `lib/config.ts:203-218` lists bare `'Edit'` and `'Write'`.
- `lib/config.ts:753-790` `trustDigest` hashes the root realpath, config, `secrets-allow.txt`, `trackers/` and `verifiers/` only.
- The main checkout supplies `readLearnings` (`lib/learnings.ts:147`, `paths(root).notes`), the brief's `learnings`/`notesDir` (`lib/brief.ts:55-56`) and `reviewerChecklist` (`lib/config.ts:929-934`, `paths(root).reviewers` before `PLUGIN_ROOT`).
- The probe wrote every one of these targets silently.

What is off:
- **`.forge/ci/release-gate.mjs` in the main checkout has no runtime effect.** The engine never reads it (CI runs the PR branch's copy), and committing it is refused by the default `policy.protectedPaths` (`lib/config.ts`, the `.forge/ci/**` refuse rule). It is harmless to include in a fix, but it is not a persistence vector.
- **`AGENTS.md` and other `project.instructions` are read from `job.worktree ?? root`** (`lib/brief.ts:57`). A main-checkout edit therefore reaches only jobs without a worktree, which is F-01's territory.
- **The strongest vector is under-weighted: `CLAUDE.md` in the main checkout.** Claude Code loads it as instructions, not as fenced data, into every new daemon session (cwd = root) and its subagents. The inbox, the office and every job session are reached, and so is the human's next interactive session in that checkout.

No legitimate daemon-time writer of these files exists: `forge init write` (the only CLI writer of `notes/learnings.md`, `lib/commands/init.ts:101`) already refuses under the daemon, and retro edits happen in a worktree. No test pins the gap. `test/daemon.test.ts:146,160,383,394` pin the argv tail as `DENY_TOOLS.join(',')`, so those tests change with any fix.

**Severity: High (agree).** One injected turn durably weakens every later review and approval, and nothing but `git status` shows it.

| # | Fix | Verdict | Notes | Effort |
|---|---|---|---|---|
| A1 | Extend `DENY_TOOLS` with `.forge/notes/**`, `.forge/reviewers/**`, `.forge/evals/**`, `.forge/ci/**` and the instruction files; add them to `trustDigest` | **KEEP, AMEND** | Add `CLAUDE.md`, `CLAUDE.local.md` and `**/CLAUDE.md` (Claude Code loads nested ones), plus `AGENTS.md`. The configured `project.instructions` can't sit in a frozen constant: build them in `buildArgv` from config, as `allowedTools` already is. The digest addition is defence in depth: the session's only Bash route is `forge`, and no `forge` command writes these under the daemon. Cost: a human `git pull` that brings in a merged retro stops the daemon, which is the same price config.yml already pays. Update `docs/ARCHITECTURE.md` "Daemon security" (the three-layer list) and `daemonTrust`'s refusal text (`lib/config.ts:838-841`). | S |
| A2 | Read learnings, notes, checklists and instruction files from `HEAD` (`git show HEAD:<path>`) | **KEEP** | This makes "retro changes ship as a PR" true by construction. It does not stop `CLAUDE.md`, which Claude Code reads itself, so it can't stand alone. UX: a local edit to learnings needs a commit before it applies; docs. | M |
| A3 | Scope the write tools to the job dir and worktrees root | **KEEP, AMEND** | Verified to work (see the probes), but only with `//`-prefixed absolute rules. Scoping to the job dir alone breaks nothing, because the session writes only job-dir files in the main checkout. This is the same change as F-09's B1; do it once. | M |
| A4 (new) | A plugin `PreToolUse` hook on `Edit\|Write\|NotebookEdit`, active when `FORGE_DAEMON=1`, that denies the repo-layer paths and anything outside `{root/.forge/jobs, worktrees.root}`. It resolves realpaths and refuses symlink escapes. | **Recommended belt** | Independent of Claude Code rule-syntax drift between versions, testable with `node:test`, inherited by subagents. `hooks/hooks.json` already runs a `PreToolUse` hook, so it fits zero-deps. | S-M |
| A5 (new) | After each `result`, the supervisor runs `git status --porcelain -- .forge/notes .forge/reviewers .forge/evals CLAUDE.md AGENTS.md <instructions>` on the main checkout; on any change it stops the session with an error, like the trust check does | KEEP | Catches every route, including a human-approved prompt. Costs one cheap git call per turn. | S |

**Recommendation:** A1 (amended) now, with A4 or A3 as the structural fix, then A2.

**Tests:**
- `test/daemon.test.ts`: the argv tail contains the new deny entries and the configured instruction files.
- `test/config-daemon.test.ts`: `trustDigest` changes when `.forge/notes/learnings.md`, `.forge/reviewers/x.md` or `CLAUDE.md` change, and `daemonTrust` then refuses.
- A hook unit test: `FORGE_DAEMON=1` plus `.forge/notes/learnings.md` gives deny; a job worktree path gives allow; a symlink out of the worktree gives deny.

---

## F-04: Per-job budget limits and acks can be raised by the session they bound

**Verdict: CONFIRMED, and worse than stated.**

- `lib/budget.ts:156-190` `budgetCmd` writes `j.budget.limits` and `j.budget.ack` with no `FORGE_DAEMON` check. It is routed at `lib/commands/job.ts:950-951`, while effort (`:390-391`) and force (`:397`) do refuse.
- **A second route the audit missed: `budget` is not in `LOCKED_FIELDS`** (`lib/commands/job.ts:419-446`). `forge job set <id> --field budget.limits.usd=null` or `--field budget.ack.usd=...` goes through `setJob` too. Only `usage` and `effort` are locked.
- **Setting any one spend key drops the whole daemon backstop.** `effectiveLimits` (`lib/budget.ts:44-47`) applies `daemon.jobBudget` only when `SPEND_KEYS.every(k => limits[k] === null && !Object.hasOwn(own, k))`, so `--set minutes=1e9` silently removes the $150/600M caps as well. This is documented (`docs/CONFIG.md:518`), but it makes the self-raise a one-word change.
- **The audit's "looks human" claim is right, and the cause is `lib/actor.ts`.** `resolveActor` returns `source: 'dashboard'` when `FORGE_DAEMON === '1'` (around `lib/actor.ts:69`), so `logHumanEvent` (`lib/jobs.ts:198`) records a session's `budget-ack` as a dashboard human.
- `--tokens`: `lib/commands/job.ts:819-823` imports only when `--import` *and* `--agent-id` are both passed. Otherwise it uses `--tokens`, and when neither is given it records no usage at all. See "Missed" item 1.
- The repo caps are `null` by default (`lib/config.ts:285-288`).

**Important side effect the audit missed.** The documented daemon flow *needs* the session to ack. A dashboard Approve on a `budget` gate enqueues an `approve` request, which is never held (`lib/daemon.ts:210-211`). The session then runs `forge job budget <job> --ack` per `skills/forge/reference/commands.md:15`. Refusing the command under the daemon without a replacement breaks that flow.

**Severity: Medium (agree).** This is cost, not authority, and it needs a misled or confused session, but no control in code stops it.

| # | Fix | Verdict | Notes | Effort |
|---|---|---|---|---|
| B1 | Refuse `forge job budget --set\|--ack` under `FORGE_DAEMON=1`, and stop recording a daemon ack as human | **KEEP, AMEND** | (a) Add `budget: 'forge job budget'` to `LOCKED_FIELDS`, or the refusal is bypassed. (b) Add a server-side `POST /api/jobs/:id/budget {ack \| set}` behind `guardPost`, recording `actor.source: dashboard`, mirroring `/api/jobs/:id/effort`. Make the dashboard's Approve on a budget gate call it before enqueueing `approve`, and change the `commands.md` budget row for daemon sessions to "the dashboard acked it; check `stillExceeded`". (c) Make `resolveActor` return a distinct `source: 'daemon'`. That adds a value to the `EventActor.source` union in `lib/types.ts` and `dashboard/src/lib/types.ts` (parity test). It is a normaliser-tolerant addition, but bump `API_VERSION` if the dashboard filters on it. | S-M |
| B2 | A default daily repo cap when the daemon is on, computed at check time | **KEEP, AMEND** | Compute it in `repoBudgetStatus` the way `effectiveLimits` does, not in `defaults()`, so no config shape changes. It shares the same self-reported ledger (`lib/spend.ts:64-79` counts only `agent-end` usage), so it limits blast radius only once metering is fixed (B4). Document it in `docs/CONFIG.md` "Repo budget". | S |
| B3 | Make `--import` mandatory in daemon sessions | **KEEP, AMEND** | Under the daemon, refuse `--tokens`, `--tool-uses` and `--duration-ms`, and refuse `end` without `--agent-id`. When the transcript isn't found, record `usage: unmeasured` and log it rather than hold the job: transcripts of background agents can lag, and holding would stall honest jobs. | S-M |
| B4 (new) | A supervisor-side meter: sum `total_cost_usd` and `usage` from every child `result` event per scope (`onResult`, `lib/daemon.ts:1434`, currently discards them) into supervisor memory. Stop the job's session and park it `waiting: budget` when it passes `effectiveLimits` | **Recommended** | This is the only number a session can't forge: it comes from claude's own stdout. It also counts the orchestrator's own turns, which nothing counts today. Check whether `total_cost_usd` is cumulative per process or per turn before summing. | M |
| B5 (new) | `buildArgv` appends `--max-budget-usd <remaining>`, where remaining = the job's usd limit minus the supervisor meter. Claude enforces it itself | KEEP | The flag exists in 2.1.302 (`claude --help`: "only works with --print"); confirm it exists in the pinned 2.1.299. It is per process, hence the "remaining". Extend the `wideningFlags` checks so `daemon.command` can't pass its own. | S |

**Recommendation:** B1 with all three amendments, plus B5, with B4 as the durable fix. B1 alone still leaves the job's `usage` self-reported.

**Tests:**
- `test/budget.test.ts`: `forge job budget <id> --set usd=1` and `--ack` exit 1 under `FORGE_DAEMON=1` with the trust env set.
- `forge job set --field budget.limits.usd=null` is refused.
- A server test: `POST /api/jobs/:id/budget` needs the token, Origin and JSON, and records `actor.source: dashboard`.
- `test/daemon.test.ts`: `buildArgv` appends `--max-budget-usd`.
- A supervisor test: a fake child emitting `result` events over the limit is stopped.

---

## F-09: Unscoped `Write`/`Edit` reaches outside the repo; `~/.gitconfig` and `core.sshCommand`

**Verdict: PARTIALLY CORRECT.** The premise is confirmed, the example is wrong, and the real route is worse.

How the session is spawned:
- `lib/daemon.ts:1293-1301` spawns `claude -p ... --permission-mode default --allowedTools {allowedTools}` with `cwd: root`, no `--add-dir`, and `--disallowedTools DENY_TOOLS --permission-prompt-tool stdio` appended (`:484`).
- `wideningFlags` forbids `--add-dir` (`lib/config.ts:887`).
- `docs/ARCHITECTURE.md` "Daemon security" assumes only `.git/` and `~/.gitconfig` can define drivers, and says nothing about writes outside the checkout.

**Can a bare-`Write` session write outside its cwd without a prompt?** Yes, as the probes showed: any absolute path under `$HOME` or `/tmp` was written silently.

**But `~/.gitconfig` and `~/.config/git/config` are Claude Code sensitive files.** Under the daemon they become a dashboard prompt, not a silent write. So the audit's exact scenario needs a human click. The pins half of the finding is also moot for that file: a planted `~/.gitconfig` is read by the human's own git anyway.

The silent routes that do exist:
- **`~/.ssh/config`** was written silently. `Host github.com` plus `ProxyCommand sh -c '...'` (or `Match exec`) runs on the next ssh `git push` from `forge pr open` (`lib/pr.ts` `pushBranch`). It also runs on the human's own pushes, outside any sandbox. **Pinning `core.sshCommand` does not stop this**, because ssh reads its own config.
- **`~/Library/LaunchAgents/*.plist`** was written silently: arbitrary code at the next login on macOS (the probe used a look-alike path under a scratch dir; the real directory's treatment is likely the same, but was not tested).
- **`~/.config/gh/config.yml`** was written silently. It holds `aliases` and `http_unix_socket`, which steer the human's `gh`.
- **Another Forge repo's `.forge/config.yml`** was written silently. Its own daemon blesses it at the next human Start, because the digest is taken at Start.

**Are `GIT_PINS` applied to every git the daemon path makes?** Yes, for everything the session itself spawns:
- `sessionEnv` (`lib/daemon.ts:446-460`) puts them in `GIT_CONFIG_COUNT/KEY/VALUE`, which every child inherits: `forge`, `lib/pr.ts`, `lib/worktree.ts` and the verify commands (`envFor` keeps them, `lib/worktree.ts:434-437`).
- `forge git` re-applies them (`lib/commands/git.ts:143-148`).
- Member checkouts pass them as `-c` (`lib/job-repos.ts:150-154`).
- `gh` calls inherit the same env.

The exception is the pool's periodic `forge sync` child (`lib/daemon-pool.ts:61-67`), which deletes `FORGE_DAEMON` and gets no pins. See "Missed" item 2.

**Severity: High (agree on the level, for a different reason).** Persistent code execution with the human's credentials via `~/.ssh/config`, written silently. The cited `~/.gitconfig` path alone would be Medium, since it needs a prompt.

| # | Fix | Verdict | Notes | Effort |
|---|---|---|---|---|
| B1 | Replace bare `Edit`/`Write` with `Edit(//<root>/**)` and `Edit(//<worktrees.root>/**)`, built in `buildArgv`; have validation refuse bare `Edit`/`Write` | **KEEP, AMEND** | Verified working, but only with the `//` prefix, and one `Edit(...)` rule covers `Write`. Don't make existing configs invalid: keep the list as is and have `buildArgv` swap bare `Edit`/`Write` for the scoped forms (no shape change, no migration). If validation refusal is wanted later, it needs a config schema bump and migration per `AGENTS.md`. Out-of-scope writes then become dashboard prompts. Document it in `docs/CONFIG.md` "Daemon". | S-M |
| B2 | Pin `core.sshCommand`, `credential.helper`, `gpg.program`, `diff.external`, `core.pager` and `url.*.insteadOf`; set `GIT_SSH_COMMAND=ssh` | **AMEND (mostly DROP)** | It doesn't stop the `~/.ssh/config` route. Blanking `credential.helper` breaks HTTPS pushes for anyone who ran `gh auth setup-git`, which sets that key in `~/.gitconfig`. `url.*.insteadOf` can't be unset through `GIT_CONFIG_*` (no wildcard). `GIT_SSH_COMMAND='ssh -F /dev/null'` would stop it, but breaks host aliases and `IdentityFile` setups. Keep only `gpg.program`, `diff.external` and `core.pager` as cheap hardening (they cost nothing in a non-TTY session that doesn't sign). | S |
| B3 | A per-repo scratch `HOME` for sessions | **DROP** | It breaks claude's own login and gh's config lookup (credentials resolve through `HOME`), and needs per-tool shims. Effort L for a weaker result than B1 or B4. | L |
| B4 (new) | The F-02 A4 `PreToolUse` hook: deny file-tool writes outside `{root, worktrees.root}` when `FORGE_DAEMON=1` | **Recommended belt** | Version-independent of rule semantics; covers subagents. | S-M |
| B5 (new) | Spawn with `--restricted --tools <list>` plus `--add-dir <worktrees.root>` from `buildArgv` | KEEP, verify | Per `claude --help` (2.1.302), this confines the file tools to the working directories and makes settings, git and tool-configuration writes need the permission handler. Confirm it exists in the pinned 2.1.299, and that `--tools` keeps `Bash(forge:*)` working. It ignores user, project and local settings, which is a behaviour change for the daemon. | M |
| B6 (new) | Correct `docs/ARCHITECTURE.md` "Daemon security": state that `Edit`/`Write` reach the whole filesystem apart from Claude Code's sensitive files, and name `~/.ssh/config` | KEEP | S |

**Recommendation:** B1 (amended: built in `buildArgv`, no validation break), with B4 as a belt and B6. Of B2, keep only the three harmless pins.

**Tests:**
- `test/daemon.test.ts`: the `buildArgv` output has `Edit(//<realpath root>/**)` and `Edit(//<worktrees root>/**)` and no bare `Edit` or `Write`.
- Hook tests: `$HOME/.ssh/config` is denied under `FORGE_DAEMON=1` and allowed without it.
- `test/config-daemon.test.ts`: a config listing bare `Edit` still validates (no break).

---

## F-18: Interactive sessions get none of the daemon's protections

**Verdict: CONFIRMED (by design).**
- `lib/commands/git.ts:148` reads `return env.FORGE_DAEMON === '1' ? sessionEnv(base) : base;` (the audit's "≈186" is line 148 at this commit).
- `DENY_TOOLS`, the trust digest and the prompt tool exist only on the daemon spawn path (`lib/daemon.ts:484`, `lib/config.ts:821`).
- `README.md` has no Security section stating the split.

**Severity: Info (agree).**

| # | Fix | Verdict | Notes | Effort |
|---|---|---|---|---|
| D1 | A README "Security" note on which guarantees are daemon-only, plus suggested `disallowedTools` | **KEEP, AMEND** | Prefix deny rules on Bash (`git push`, `gh api`) are speed bumps: compound commands and other interpreters get past them. Say so. Better to suggest the same `Edit(...)` denies as `DENY_TOOLS` in `.claude/settings.json`. Seeding that file from `forge init write` is persistent config, so it must stay an explicit opt-in prompt. | S |
| D2 | A `PreToolUse` hook refusing `git push`, `git config`, `gh api` and `gh auth` for Forge-role subagents | **AMEND** | Whether the hook input carries the subagent type was not verified for the pinned version. Key it instead on an explicit opt-in env (`FORGE_GUARD=1`) or on `FORGE_DAEMON`, and reuse the F-02 A4 hook. | M |
| D3 (new) | A `forge doctor` warning when the repo's `.claude/settings.json` allows `Bash(git:*)`, `Bash(gh:*)` or bare `Bash` | KEEP | Read-only; it tells the human where interactive guarantees are thinnest. | S |
| D4 (new) | Let an interactive user opt into the daemon guard set (`FORGE_GUARD=1` turns on the A4 hook and the git pins in `gitEnv`) | KEEP | S-M |

**Recommendation:** D1 (amended) plus D4 once A4 exists. **Tests:** `test/doctor*.test.ts` for D3; a hook test with `FORGE_GUARD=1`.

---

## F-22: One dashboard token for permission prompts and auto mode

**Verdict: CONFIRMED (documented).**
- `lib/server.ts:424` (`/api/daemon/permission`) and `:440` (`/api/daemon/mode`) use `guardPost` (`:1237-1242`): token, `Origin` and `content-type` only.
- `docs/ARCHITECTURE.md` "Permission mode" already says "Auto on one session reaches the whole daemon".
- Precondition: a session that can issue an HTTP request with no human. The default allowlist has no `curl` and no `WebFetch`, so this means Auto, or a human allowing one.

**Severity: Info (agree).**

| # | Fix | Verdict | Notes | Effort |
|---|---|---|---|---|
| E1 | A second token, held only in the page's memory after a user gesture | **DROP** | Whatever page JS can fetch, a same-uid process can fetch the same way. On loopback no gesture can be proven. | M |
| E2 | Refuse those routes without `Sec-Fetch-Site`/`Sec-Fetch-Mode` | **DROP** | A non-browser client (`curl -H 'Sec-Fetch-Site: same-origin'`) sets any header it likes. It stops nothing in the stated threat and only breaks tests. | S |
| E3 (new) | Add loopback-reaching tools to the deny list: `WebFetch(domain:127.0.0.1)`, `WebFetch(domain:localhost)`, `Bash(curl:*)`, `Bash(wget:*)`, `Bash(nc:*)` | KEEP (partial) | Deny beats Auto. Interpreters (`node -e`) still go through the classifier, so this narrows the route rather than closing it. | S |
| E4 (new) | A peer-process check on the two routes: map the client's source port to a pid (`lsof -nP -iTCP` on macOS, `/proc/net/tcp` plus `/proc/*/fd` on Linux) and refuse when that pid descends from a supervised child | KEEP (if wanted) | Deterministic and zero-deps, but platform-specific and racy at the margins. Fail closed. | M-L |
| E5 (new) | When a human picks Auto, have the dashboard require a typed confirmation that names the cross-session reach. Log `permission-mode` changes to all sessions' logs | KEEP | Makes the documented trust jump visible. It is UX, not a control. | S |

**Recommendation:** E3 plus E5. E4 only if Auto becomes a common mode. **Tests:** `test/daemon.test.ts` (the argv deny list includes the loopback denies); `test/dashboard-daemon.test.ts` for the confirm flow.

---

## Missed by the auditor

### M-1: The orchestrator's own spend is never metered, and subagent spend is self-reported, so neither per-job nor repo budgets bound a daemon session
**Severity: Medium.**
- **Location:** `lib/spend.ts:64-79` (the ledger counts only `agent-end` events carrying `usage`); `lib/budget.ts:54-60` (`measureBudget` reads `job.usage`, fed only by `recordAgent`); `lib/commands/job.ts:819-823` (no `--import`/`--agent-id` and no `--tokens` means no usage recorded); `lib/daemon.ts:1434-1461` (`onResult` ignores the `result` event's `total_cost_usd` and `usage`).
- **Reconciler:** the resume loop (`lib/reconcile.ts:146-162`) has a "resume once, then escalate" rule, but `PROGRESS_EVENTS` (`:16`) counts `agent-start`, `agent-end` and `human` as progress. A session that starts and ends one agent per turn, with no usage, is resumed indefinitely. Its memory lives in session-writable `.forge/runtime/reconcile.json` (`:79`), which is not in `DENY_TOOLS`.
- **Failure strikes:** `MAX_FAILURES = 3` (`lib/daemon.ts:399`) catches failed turns, not "successful" unproductive ones.
- **Attack scenario:** a confused or injected job session loops through `forge job agent start/end` without `--import`, or its orchestrator context grows large. The real spend never reaches `job.usage` or `spend.json`, so `daemon.jobBudget` and `budget.usdPerDay` never trip. Each reconcile resume is another paid turn.
- **Fixes:**
  1. The F-04 B4 supervisor meter, from `result` events.
  2. `--max-budget-usd` per spawn (F-04 B5).
  3. Add `Edit(.forge/runtime/reconcile.json)` to `DENY_TOOLS`, give the reconciler an absolute ceiling of N resumes per job per stage regardless of the mark, and drop `agent-start` and `human` from `PROGRESS_EVENTS`, or require an `agent-end` with usage.

  Effort S-M each.

### M-2: The pool's periodic `forge sync` runs git in the main checkout every 2 minutes as the human, with no git pins
**Severity: Low.**
- **Location:** `lib/daemon-pool.ts:61-67` (`runSyncChild`: `{ ...env, FORGE_ROOT, FORGE_MODE }` with `FORGE_DAEMON` deleted and no `sessionEnv`); `lib/pr.ts:1149` (`git fetch <remote> --prune`, `cwd: root`, from `syncPr`).
- **Attack scenario:** the repo sets `core.hooksPath` to a tracked dir (`.githooks/`, which the probe wrote silently). A session `Edit`s an existing executable hook there (`reference-transaction`, which `git fetch` runs on ref updates; `Edit` keeps the file mode). Within 2 minutes the sync child runs it outside the session's pins, as the human, with the full environment. Preconditions are narrow: `Write` creates new files without the exec bit, so an executable hook must already exist.
- **Fixes:**
  1. Give `runSyncChild` the git pins (export a `gitPinsEnv` from `lib/util.ts` and apply it in the child env), since the pool runs it unattended. S.
  2. Add `Edit(<core.hooksPath>/**)` to the argv deny list when `core.hooksPath` resolves inside the checkout. S.
  3. The F-02 A5 post-turn `git status` check, extended to the hooks dir. S.

### M-3: `API_KEY_VARS` misses the other variables that make claude bill a non-subscription account
**Severity: Low (cost control).**
- **Location:** `lib/daemon.ts:433` lists only `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`. `sessionEnv` (`:452`) deletes only those.
- **Attack scenario (misconfiguration):** `forge dash` is started from a shell that exports `CLAUDE_CODE_USE_BEDROCK=1` or `CLAUDE_CODE_USE_VERTEX=1` (with `AWS_*`/`GOOGLE_*` credentials) for other work, or `ANTHROPIC_BASE_URL` for a proxy. Every unattended session then bills that cloud account or routes through that proxy, which is the exact surprise the scrub exists to prevent, and `daemon.auth: subscription` reports nothing.
- **Fixes:**
  1. Under `auth: subscription`, also drop `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` and `ANTHROPIC_BASE_URL`. S.
  2. Have `forge doctor` and the dashboard Start warn when any of these are set. S.
  3. Add an `auth: inherit` value for people who want them. That changes the config enum: `docs/CONFIG.md` and a `lib/config-fields.ts` entry, which already exists for `daemon.auth`. S.

  **Test:** `test/daemon.test.ts` `sessionEnv` cases.

Also checked, with nothing to report:
- `forge config set`, `forge init write` and `forge migrate` refuse under the daemon (doc, and `lib/cli.ts:76,100`).
- `daemon.jobBudget` and `allowedTools` are non-editable in `config-fields`.
- Permission prompts and mode have no CLI route.
- Effort is refused.

The trust digest does miss `.forge/notes`, `.forge/reviewers` and instruction files (F-02), and anything a tracker module imports from outside `.forge/trackers/` (documented).

## Notes for the synthesizer

ID | auditor severity | my severity | verdict | recommended fix
---|---|---|---|---
F-02 | High | High | CONFIRMED (CI gate copy is inert; instruction files come from the worktree; `CLAUDE.md` is the strongest vector) | Extend `DENY_TOOLS` and `trustDigest` with notes, reviewers, evals, `CLAUDE.md`, `AGENTS.md` and configured instructions; add a `FORGE_DAEMON` PreToolUse write-guard hook; later read from `HEAD`
F-04 | Medium | Medium | CONFIRMED, worse (`forge job set --field budget.*` unlocked; any spend key drops `jobBudget`; daemon actor recorded as `dashboard`) | Refuse under the daemon, lock `budget` in `LOCKED_FIELDS`, add `POST /api/jobs/:id/budget` for the Approve flow, actor `daemon`; `--max-budget-usd` and a supervisor-side meter
F-09 | High* | High | PARTIALLY CORRECT (out-of-cwd writes silent, verified; `~/.gitconfig` prompts; the real silent route is `~/.ssh/config`, which pins can't stop; pins do reach every session git) | `buildArgv` swaps bare `Edit`/`Write` for `Edit(//root/**)` and `Edit(//worktrees/**)`; write-guard hook; drop most of the extra pins (`credential.helper` would break HTTPS push)
F-18 | Info | Info | CONFIRMED (by design) | README Security note; opt-in `FORGE_GUARD` reusing the daemon hook; doctor warning
F-22 | Info | Info | CONFIRMED (documented) | Both proposed fixes ineffective on same-uid loopback (DROP); add loopback deny rules and an Auto confirmation; optional peer-pid check
M-1 | — | Medium | NEW | Supervisor meters `result` cost; `--max-budget-usd`; reconciler absolute ceiling; deny `reconcile.json`
M-2 | — | Low | NEW | Git pins for `runSyncChild`
M-3 | — | Low | NEW | Scrub the Bedrock, Vertex and Foundry switches and `ANTHROPIC_BASE_URL` under `auth: subscription`
