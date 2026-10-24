# Initialise Forge in a repo

Goal: write `.forge/config.yml` (plus `.gitignore`, `README.md`, `notes/learnings.md`, and a backlog for the local tracker) from what the repo already tells us, asking the human only what detection can't answer. Use the AskUserQuestion tool, with up to 4 questions per call and the recommended option first.

## 1. Detect
```bash
forge init detect
```
Read the JSON. Also skim the repo's instruction files (`instructions.tracked` / `instructions.ignored`) for build/test/dev commands and conventions that detection missed. If the instruction files don't say how to set up, build, test and run the project, note it. The agents rely on that.

Show the human a 5-8 line summary: stack/kinds, base branch, tracker candidates (GitHub repo, `.github/project-config.yml` project and status options), detected commands (including the e2e command, if any), UI/design signals, infra signals, untracked instruction/env files.

## 2. Ask (batch 1: workflow)
1. **Base branch & PRs**: base = detected (e.g. `develop` when it exists). Options: "Open PRs against <base> (Recommended)", "Draft PRs", "No PRs (branches only)".
2. **Tracker**: "GitHub Issues" (if a GitHub remote) · "Local backlog.md" · "None". When GitHub: a follow-up on status sync: "GitHub Project field (Recommended when project-config exists)" · "Labels" · "Both" · "None (assignment + comments only)".
3. **Spec approval**: "Always (Recommended)" · "Only large jobs" · "Never".
4. **Auto-merge**: "Off (Recommended)" · "On for docs/tests-only changes" · "On whenever the approver allows".

## 3. Ask (batch 2: team)
1. **Review panel**: offer three presets built from `suggestions["review.panel"]` and the catalog (`${CLAUDE_PLUGIN_ROOT}/reviewers/`: code, tests, security, design, ui, ux, accessibility, performance, realtime, infra, api, docs): "Recommended: <detected list>" · "Lean: code + tests" · "Thorough: recommended + <2-3 extra relevant lenses>". Lenses not marked `always` get a `when:` scope in plain words (e.g. design → "user-visible UI changes") and, when `suggestions["review.panelPaths"][<lens>]` has globs, those as the lens's `paths:` list: `forge job panel` adds the lens to a round whose diff touches one. For UI repos `design` is one lens covering visual, flow/copy and accessibility; offer `ui + ux + accessibility` instead when the user wants them split.
2. **Model profile** (provider from `runtime.provider`, default anthropic/Claude Code):
   - Balanced (Recommended): planner/spec-writer/builder/retro/judge `opus`, approver `sonnet` (a different family from the builder, so the last gate doesn't share its blind spots), designer/reviewer/integrator `sonnet`, security lens `opus`
   - Economy: builder/approver `sonnet`, everything else `haiku` except security `sonnet`
   - Max quality: everything `opus`; spec-writer/builder `fable` if available

   Any profile: set `runtime.diversity: true` to have `forge roster` and init warn when the approver or a lens shares the builder's model family.
3. **Design** (only when UI was detected): "No design step" · "Reference existing designs (Figma/docs)" · "Generate HTML mockups for approval". For "reference", ask for the Figma file/frame URLs (or take detected ones) and add them to `resources`.
4. **Infrastructure** (only when infra signals or cloud CLIs exist): "Human performs all infra steps (Recommended)" · "Agents may run plan/read-only commands" · "Agents may apply (still escalates)". For the latter two, ask which commands go in `infra.allowed`.

## 4. Ask (batch 3: only what's still unknown)
- Untracked files to copy into worktrees (`suggestions["worktrees.copy"]`, e.g. gitignored CLAUDE.md files). Confirm. Don't suggest `.env*` files (`untracked.env` lists them): offer to declare their values under `secrets` and pass them through a config sink instead, and `forge doctor` warns on a copy that matches one.
- Committed build output (only when `suggestions["worktrees.generated"]` is non-empty): confirm the globs as `worktrees.generated`, so `forge integrate` rebuilds them on conflict instead of calling the integrator. Then ask whether `commands.build` is safe to run in the middle of a merge (it must not fail just because its output differs from git, as a `git status` check would). If not, add a regenerate-only command (e.g. `commands.dist`) and set `worktrees.generatedBy` to its name.
- Command environment: configured commands get only an allowlist of Forge's environment, under `/bin/sh -c` (docs/CONFIG.md "Command environment"). Show `suggestions["commandEnv.inherit"]` (names from `.env.example` and the build tool), confirm the names the commands need, and write them as `commandEnv.inherit`. Credentials go under `secrets` with a config sink, never in `inherit`. Ask whether the commands need the login profile (`commandEnv.loginShell: true`; default no).
- Protected paths: show `suggestions["policy.protectedPaths"]` as a table (paths, escalate or refuse, reason). It is the default policy with the lockfile rule narrowed to this repo's ecosystems. The CLI refuses `refuse` paths and parks `escalate` paths on a human before a PR ships (docs/CONFIG.md "Protected paths"). Confirm or edit, then write the list as `policy.protectedPaths` in the answers.
- Rust repos: share one Cargo target dir across worktrees? "Yes, separate shared dir (Recommended)" · "Yes, reuse the main checkout's target/" · "No".
- Monorepo / multiple components: confirm `suggestions.components` (name, path, kind, commands, build dependencies) and write the confirmed list as `components`.
- Member repos (other repos in the same project) are hand-edited under `repos:` with each clone's path in `.forge/local.yml`, which init gitignores (docs/CONFIG.md "Repos"). Don't ask about them unless the human brings them up.
- Repo-specific reviewers: for each `repoAgents` entry that is a review/audit agent (e.g. a realtime-safety checker), offer a lens. Create `.forge/reviewers/<name>.md` whose checklist says to follow that agent's instructions file, and add it to the panel.
- Faster verify: when `build` comes first and the later checks (lint, typecheck, test) neither write files another one reads or writes nor bind `{port}`, offer grouping them so they run at the same time: `verify: [build, [lint, typecheck, test]]` (docs/CONFIG.md "Verify groups"). A Forge older than config schema 3 skips a group instead of running it, so confirm every machine that runs verify is updated. Leave `verify` a plain list otherwise.
- Targeted tests: when the test runner takes file arguments, offer `{args}` in `commands.test` so builders can run just the files they touched (`forge run <job> test -- <files>`). With `{args}` empty the command must still run the whole suite, as `set -- {args}; [ $# -gt 0 ] || set -- '<glob>'; <runner> "$@"` does. Only a template with `{args}` takes arguments; write it unquoted, as its own word (docs/CONFIG.md placeholders).
- E2E (only when `commands.e2e` was detected): confirm the command, then "Run in verify when UI paths change (Recommended)" · "Always" · "Never" → `verifyE2e.when`. Offer the repo's UI dirs as `verifyE2e.paths` additions when they aren't covered by the default extensions.
- Daemon (advanced, default off): `forge dash` supervises headless orchestrator sessions (an inbox plus one per job, up to `daemon.maxConcurrent`, default 3) that handle dashboard requests on their own. Explain that they spend tokens with no human at the keyboard, that spend scales with the number of live sessions, that a tool call outside `daemon.allowedTools` waits for them to allow or deny it in the dashboard (with `--permission-mode dontAsk` in `daemon.command` it is refused instead, and each session's Permissions button in the dashboard can switch it to Auto or Refuse while `forge dash` runs), and that the default allows Bash only for `forge` and the specific git/gh subcommands the agents use. Checks run through `forge run`/`forge verify`, so build tools need no entry; don't offer first-word entries like `Bash(npm:*)`, which reach arbitrary execution. If the human wants more, write the complete `daemon.allowedTools` list (the defaults from CONFIG.md plus `Bash(<cmd> <sub>:*)` additions), because a list in the answers replaces the default rather than merging, and validation refuses blanket git/gh entries. Write `daemon.enabled: true` only on an explicit yes. Daemon sessions run on the human's Claude login: an `ANTHROPIC_API_KEY` exported in their shell is dropped unless they set `daemon.auth: api-key`, so mention it only if they ask about billing.

## 5. Write
Assemble an answers JSON containing only keys that differ from defaults (`${CLAUDE_PLUGIN_ROOT}/docs/CONFIG.md` documents every key). Write it to a scratch file, then:
```bash
forge init write --answers <file>      # merges into an existing config; --force to start fresh
forge config validate
forge doctor
```
Relay any `warnings` from `forge init write`. A `git-ref` or `canary` `release.interim` (root or any member) seeds the release gate (`.forge/ci/release-gate.mjs` and `.github/workflows/forge-release-gate.yml`, docs/CONFIG.md "Release gate"); its warning tells the human to commit both and make the `release gate` check required in branch protection, which they do themselves. Fix anything `validate`/`doctor` reports (e.g. `gh auth refresh -s project` for GitHub Projects sync. Tell the human, don't run auth commands yourself).

## 6. Hand over
Tell the human: the files written; to commit `.forge/` (it's designed to be committed, while runtime state is gitignored inside it); `forge dash --background` for the dashboard; and how to start (`/forge <feature>`, `/forge next`). If instruction files lacked commands, suggest adding them.
