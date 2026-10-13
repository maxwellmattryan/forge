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
1. **Review panel**: offer three presets built from `suggestions["review.panel"]` and the catalog (`${CLAUDE_PLUGIN_ROOT}/reviewers/`: code, tests, security, ui, ux, accessibility, performance, realtime, infra, api, docs): "Recommended: <detected list>" · "Lean: code + tests" · "Thorough: recommended + <2-3 extra relevant lenses>". Lenses not marked `always` get a `when:` scope in plain words (e.g. ui → "user-visible UI changes").
2. **Model profile** (provider from `runtime.provider`, default anthropic/Claude Code):
   - Balanced (Recommended): planner/spec-writer/builder/retro/judge `opus`, approver `sonnet` (a different family from the builder, so the last gate doesn't share its blind spots), designer/reviewer/integrator `sonnet`, security lens `opus`
   - Economy: builder/approver `sonnet`, everything else `haiku` except security `sonnet`
   - Max quality: everything `opus`; spec-writer/builder `fable` if available

   Any profile: set `runtime.diversity: true` to have `forge roster` and init warn when the approver or a lens shares the builder's model family.
3. **Design** (only when UI was detected): "No design step" · "Reference existing designs (Figma/docs)" · "Generate HTML mockups for approval". For "reference", ask for the Figma file/frame URLs (or take detected ones) and add them to `resources`.
4. **Infrastructure** (only when infra signals or cloud CLIs exist): "Human performs all infra steps (Recommended)" · "Agents may run plan/read-only commands" · "Agents may apply (still escalates)". For the latter two, ask which commands go in `infra.allowed`.

## 4. Ask (batch 3: only what's still unknown)
- Untracked files to copy into worktrees (`suggestions["worktrees.copy"]`, e.g. gitignored CLAUDE.md files and `.env`). Confirm. Never copy secrets the human doesn't want duplicated.
- Rust repos: share one Cargo target dir across worktrees? "Yes, separate shared dir (Recommended)" · "Yes, reuse the main checkout's target/" · "No".
- Monorepo / multiple services: confirm `services` (name, path, per-service commands).
- Repo-specific reviewers: for each `repoAgents` entry that is a review/audit agent (e.g. a realtime-safety checker), offer a lens. Create `.forge/reviewers/<name>.md` whose checklist says to follow that agent's instructions file, and add it to the panel.
- E2E (only when `commands.e2e` was detected): confirm the command, then "Run in verify when UI paths change (Recommended)" · "Always" · "Never" → `verifyE2e.when`. Offer the repo's UI dirs as `verifyE2e.paths` additions when they aren't covered by the default extensions.
- Daemon (advanced, default off): `forge dash` supervises a headless orchestrator session that handles dashboard requests on its own. Explain that it spends tokens with no human at the keyboard, runs with `--permission-mode dontAsk` (anything not in `daemon.allowedTools` is refused, never asked), and that the default allows Bash only for `forge`, `git` and `gh`. Offer to add `Bash(<cmd>:*)` entries to `daemon.allowedTools` for the detected `commands.*` (first word of each). Write `daemon.enabled: true` only on an explicit yes.

## 5. Write
Assemble an answers JSON containing only keys that differ from defaults (`${CLAUDE_PLUGIN_ROOT}/docs/CONFIG.md` documents every key). Write it to a scratch file, then:
```bash
forge init write --answers <file>      # merges into an existing config; --force to start fresh
forge config validate
forge doctor
```
Relay any `warnings` from `forge init write`. Fix anything `validate`/`doctor` reports (e.g. `gh auth refresh -s project` for Projects sync. Tell the human, don't run auth commands yourself).

## 6. Hand over
Tell the human: the files written; to commit `.forge/` (it's designed to be committed, while runtime state is gitignored inside it); `forge dash --background` for the dashboard; and how to start (`/forge <feature>`, `/forge next`). If instruction files lacked commands, suggest adding them.
