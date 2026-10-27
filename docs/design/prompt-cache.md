# Design note: prompt-cache reuse across role runs

Status: measured 2026-10-27 on Claude Code 2.1.311 (`claude --version`), model `claude-haiku-5-5` (the `model` of every child's `system`/`init` event and the only key of its `result.modelUsage`). Haiku stands in for the shape, not the size: see [Limits](#limits).

## Why

#375 (cache-stable role children) and #376 (a context session that every role run forks from) both rest on guesses about what Claude Code's prompt cache shares between headless **role runs**. This note, the deliverable of #374, measures it: about seventy real `claude -p --model haiku` children, started with today's `roleArgv` ([`lib/integrations/claude/argv.ts`](../../lib/integrations/claude/argv.ts)) plus one change per configuration. It ends with a recommendation and the exact edits proposed for both issues.

## Method

**Scratch shape.** A throwaway git repo under a fresh `mktemp -d` root (`<scratch>`), outside both Forge checkouts:

- `AGENTS.md`: the first 20,436 bytes of Forge's `docs/DEVELOPING.md`, cut at a line end.
- `notes/learnings.md`: a copy of Forge's learnings file. `reviewers/{code,tests,security,docs}.md`: copies of Forge's checklists. `spec.md`: a copy of #374's spec.
- Branch `feature` adds a 438-line copy of `lib/integrations/claude/stream.ts`; `diff.patch` (`git diff main...feature`) is 444 lines.
- Worktrees `<wt-a>` on `feature` and `<wt-b>` on `feature-b` (same commit), `<wt-b>` with one extra untracked file, so the two worktrees differ in path and git status.
- Four lenses: code, tests, security, docs.
- Every child ran with `FORGE_ROOT` and `FORGE_HOME` inside `<scratch>`, so no real `.forge/` was touched. No Claude Code setting, credential or permission was changed; the nested launch worked without unsetting `CLAUDECODE`.

**Harness.** A Node script (built-ins only, not committed) imported `roleArgv`, `absRule` and `sessionEnv` from `argv.ts`, `briefLine` from `stream.ts` and `defaults` from `lib/core/config/load.ts`. Each child got exactly today's role-run argv (Appendix), its configuration's extra flags, and `--include-partial-messages --max-budget-usd 0.30`. The brief went to stdin as one `briefLine`, except configuration 7's argv arm. Every `can_use_tool` control request was answered with a deny, as `lib/integrations/claude/role.ts` does unattended; stdin closed after `result`.

**What a request is.** A distinct `message.id` among main-loop `assistant` events (`parent_tool_use_id` empty or absent). Its numbers are the first `message.usage` seen for that id: `cache_creation_input_tokens` (cache write), `cache_read_input_tokens` (cache read) and `input_tokens` (fresh input). A request's **start prefix** is the sum of the three. Cost is `result.total_cost_usd`.

**Seconds to first token.** From just before `spawn` to the first main-loop `stream_event` whose `event.type` is `content_block_delta`. For configuration 7's arm A also from the moment the brief was written to stdin.

**Ordering.** In a configuration with siblings, child 1 started alone and the others started together at child 1's first `content_block_delta`. The "started at" column is seconds after that configuration's child 1. Configurations ran in this order, offsets in seconds from configuration 1's child 1:

| Run | Start (s) | Notes |
|---|---|---|
| launch check | -110 | one reviewer child, brief "Reply with the word OK" |
| 1 | 0 | ends 48 |
| 2 | 79 | ends 120 |
| 3a, 3b | 139, 178 | ends 206 |
| 4a, 4d | 232, 302 | |
| 4b, 4c (run 1) | 354, 373 | ends 400 |
| 4b, 4c (run 2) | 463, 488 | rerun with the probe answer captured; ends 527 |
| 5 | 546 | both passes and the pair; ends 664 |
| 5 plain, pass 3 | 708 | `FORGE_DAEMON` unset, see configuration 5 |
| 6 first turns | 723, 724, 725 | resumes below |
| 7 | 731 | ends 979 |
| 1x, 2x | 1019 to 1026 | cross-cwd rows with one shared brief |
| 3x | 1079 | configuration 3b from `<wt-b>` |
| 6a resume | 1085 | |
| 6 late fork 1 | 1197 | |
| 6b resume | 2527 | |
| 6c resume | 4627 | |
| 6 late fork 2 | 5137 | |

All cache writes on this login were one-hour writes: summed over every child's `modelUsage`, `cacheCreationEphemeral1hInputTokens` was 2,701,212 and `cacheCreationEphemeral5mInputTokens` was 0.

**Spend.** The sum of `total_cost_usd` over every child's `result` was $0.75 over 67 recorded children, against a $6 cap.

## Results

Request 1's fresh input was 2 tokens in every child of every configuration, so the start prefix is cache write plus cache read plus 2. Cost is `total_cost_usd` in dollars.

### Baseline

Configuration 1: `roleArgv` as is.

| Child | Variant | Agent | Cwd | Started at (s) | Req 1 write | Req 1 read | Req 2 write | Req 2 read | Req 1 fresh | S to first token | Cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 code | - | forge:reviewer | wt-a | 0.0 | 14,615 | 15,062 | 515 | 29,677 | 2 | 2.36 | 0.0160 |
| 2 tests | - | forge:reviewer | wt-a | 2.4 | 14,617 | 15,062 | 1,109 | 29,679 | 2 | 2.83 | 0.0104 |
| 3 security | - | forge:reviewer | wt-a | 2.4 | 14,615 | 15,062 | 679 | 29,677 | 2 | 3.42 | 0.0147 |
| 4 docs | - | forge:reviewer | wt-a | 2.4 | 14,617 | 15,062 | 353 | 29,679 | 2 | 2.20 | 0.0155 |
| 5 code | - | forge:reviewer | wt-b | 2.4 | 14,615 | 15,062 | 644 | 29,677 | 2 | 3.37 | 0.0124 |
| 1x-1 | one brief | forge:reviewer | wt-a | 0.0 | 14,408 | 15,062 | n/a [^one] | n/a [^one] | 2 | 1.26 | 0.0030 |
| 1x-2 | one brief | forge:reviewer | wt-b | 2.0 | 13,914 | 15,556 | n/a [^one] | n/a [^one] | 2 | 2.10 | 0.0029 |

Child 1 read 15,062 because the launch check, the same agent 110 s earlier, had written it. Rows 1x ran later (offset 1019) and sequentially, with one brief for both, identical except for the cwd.

### Dynamic sections excluded

Configuration 2: configuration 1 plus `--exclude-dynamic-system-prompt-sections`.

| Child | Variant | Agent | Cwd | Started at (s) | Req 1 write | Req 1 read | Req 2 write | Req 2 read | Req 1 fresh | S to first token | Cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 code | - | forge:reviewer | wt-a | 0.0 | 14,615 | 15,062 | 551 | 29,677 | 2 | 3.13 | 0.0156 |
| 2 tests | - | forge:reviewer | wt-a | 3.1 | 14,617 | 15,062 | 543 | 29,679 | 2 | 2.10 | 0.0128 |
| 3 security | - | forge:reviewer | wt-b | 3.1 | 14,615 | 15,062 | 669 | 29,677 | 2 | 2.62 | 0.0131 |
| 4 docs | - | forge:reviewer | wt-b | 3.1 | 14,617 | 15,062 | 380 | 29,679 | 2 | 3.26 | 0.0154 |
| 2x-1 | one brief | forge:reviewer | wt-a | 4.8 | 0 | 29,470 | n/a [^one] | n/a [^one] | 2 | 2.03 | 0.0003 |
| 2x-2 | one brief | forge:reviewer | wt-b | 7.6 | 0 | 29,470 | n/a [^one] | n/a [^one] | 2 | 2.09 | 0.0003 |

Rows 2x ran straight after 1x-1 and 1x-2 (started at is from 1x-1) with the same brief. 2x-1 read all of 1x-1's prefix and 2x-2 all of 1x-2's: the flag changed nothing that reaches the cache under `--agent`.

[^one]: A one-line "Reply OK" brief: the child made one request.

### Trusted files in the system prompt

Configuration 3: configuration 2 plus `--append-system-prompt-file <file>`, with the brief cut to the lens, output, spec and diff lines (3b keeps the checklist line). All in `wt-a`. 3a's file is `AGENTS.md`, `notes/learnings.md` and that lens's checklist, so it differs per lens; 3b's is `AGENTS.md` and `notes/learnings.md`, the same for every lens.

| Child | Variant | Agent | Cwd | Started at (s) | Req 1 write | Req 1 read | Req 2 write | Req 2 read | Req 1 fresh | S to first token | Cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 code | 3a | forge:reviewer | wt-a | 0.0 | 38,698 | 0 | 685 | 38,698 | 2 | 1.63 | 0.0208 |
| 2 tests | 3a | forge:reviewer | wt-a | 1.6 | 25,675 | 13,452 | 470 | 39,127 | 2 | 3.51 | 0.0167 |
| 3 security | 3a | forge:reviewer | wt-a | 1.6 | 25,262 | 13,452 | 1,088 | 38,714 | 2 | 2.82 | 0.0148 |
| 4 docs | 3a | forge:reviewer | wt-a | 1.6 | 25,089 | 13,452 | 705 | 38,541 | 2 | 2.50 | 0.0144 |
| 1 code | 3b | forge:reviewer | wt-a | 0.0 | 24,959 | 13,452 | 10,394 | 38,411 | 2 | 1.40 | 0.0115 |
| 2 tests | 3b | forge:reviewer | wt-a | 1.4 | 14,503 | 23,910 | 7,803 | 38,413 | 2 | 3.30 | 0.0094 |
| 3 security | 3b | forge:reviewer | wt-a | 1.4 | 14,501 | 23,910 | 16,296 | 38,411 | 2 | 2.72 | 0.0104 |
| 4 docs | 3b | forge:reviewer | wt-a | 1.4 | 14,503 | 23,910 | 8,363 | 38,413 | 2 | 1.73 | 0.0075 |
| 3x code | 3b | forge:reviewer | wt-b | 0.0 | 14,498 | 23,910 | 439 | 38,408 | 2 | 2.38 | 0.0154 |

Row 3x ran at offset 1079, 15 minutes after 3b, from the other worktree with 3b's file.

### Context session

Configuration 4. A context child (pinned with `--session-id`, configuration 2's flags, `wt-a`) Reads `AGENTS.md`, `notes/learnings.md`, `spec.md` and `diff.patch` and replies `READY`. Forks are `--resume <ctx-id> --fork-session` with configuration 2's flags and only the lens and output lines as the new message; in 4b and 4c the message starts with the probe line "Before anything else, quote the first sentence of your system instructions." 4b and 4c ran twice: run 1 did not keep the probe answer (the harness kept only the last reply), so run 2 repeated them with a fresh context each.

| Child | Variant | Agent | Cwd | Started at (s) | Req 1 write | Req 1 read | Req 2 write | Req 2 read | Req 1 fresh | S to first token | Cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| context | 4a | forge:reviewer | wt-a | 0.0 | 14,422 | 15,062 | 29,364 | 29,484 | 2 | 1.69 | 0.0095 |
| fork 1 code | 4a | forge:reviewer | wt-a | 4.7 | 124 | 58,848 | 3,665 | 58,972 | 2 | 3.16 | 0.0166 |
| fork 2 tests | 4a | forge:reviewer | wt-a | 7.9 | 125 | 58,848 | 603 | 58,973 | 2 | 2.03 | 0.0144 |
| fork 3 security | 4a | forge:reviewer | wt-a | 7.9 | 124 | 58,848 | 1,787 | 58,972 | 2 | 2.58 | 0.0202 |
| fork 4 docs | 4a | forge:reviewer | wt-a | 7.9 | 125 | 58,848 | 733 | 58,973 | 2 | 4.65 | 0.0138 |
| fork code | 4d | forge:reviewer | wt-b | 70.2 | 257 | 58,848 | 933 | 59,105 | 2 | 4.36 | 0.0195 |
| context | 4b run 1 | forge:builder | wt-a | 0.0 | 31,579 | 0 | 29,239 | 31,579 | 2 | 2.75 | 0.0127 |
| fork 1 code | 4b run 1 | forge:reviewer | wt-a | 6.2 | 47,174 | 13,443 | n/a [^short] | n/a [^short] | 2 | 3.44 | 0.0226 |
| fork 2 tests | 4b run 1 | forge:reviewer | wt-a | 9.6 | 43,817 | 16,801 | n/a [^short] | n/a [^short] | 2 | 4.02 | 0.0220 |
| context | 4c run 1 | forge:builder | wt-a | 0.0 | 0 | 31,579 | 29,254 | 31,579 | 2 | 2.69 | 0.0067 |
| fork 1 code | 4c run 1 | forge:reviewer | wt-a | 6.4 | 43,305 | 15,570 | 3,171 | 58,875 | 2 | 2.59 | 0.0185 |
| fork 2 tests | 4c run 1 | forge:reviewer | wt-a | 9.0 | 43,306 | 15,570 | 2,443 | 58,876 | 2 | 2.74 | 0.0180 |
| context | 4b run 2 | forge:builder | wt-a | 0.0 | 0 | 31,579 | 29,406 | 31,579 | 2 | 3.41 | 0.0069 |
| fork 1 code | 4b run 2 | forge:reviewer | wt-a | 7.5 | 43,817 | 16,801 | 1,841 | 60,618 | 2 | 4.33 | 0.0179 |
| fork 2 tests | 4b run 2 | forge:reviewer | wt-a | 11.9 | 43,818 | 16,801 | n/a [^short] | n/a [^short] | 2 | 3.40 | 0.0162 |
| context | 4c run 2 | forge:builder | wt-a | 0.0 | 0 | 31,579 | 29,354 | 31,579 | 2 | 3.56 | 0.0068 |
| fork 1 code | 4c run 2 | forge:reviewer | wt-a | 6.3 | 43,312 | 15,570 | 2,491 | 58,882 | 2 | 2.93 | 0.0199 |
| fork 2 tests | 4c run 2 | forge:reviewer | wt-a | 9.3 | 43,313 | 15,570 | 1,824 | 58,883 | 2 | 2.35 | 0.0228 |

Started at is from the variant's context child. 4d is one 4a-style fork of 4a's context launched from `wt-b`, after 4a's forks ended. Every 4b and 4c fork listed 29 tools in `init` (no `Edit`, no `NotebookEdit`: the reviewer's frontmatter), while their builder context listed 31.

[^short]: The fork answered in one request.

Probe answers (one line each, as the fork wrote them):

| Variant | Fork | Answer |
|---|---|---|
| 4b run 1 (snapshot on) | 1 code | "I can tell you what I'm set up to do: I'm the Forge builder for this job." |
| 4b run 1 (snapshot on) | 2 tests | "I can tell you what I'm working from: the Forge builder role" |
| 4b run 2 (snapshot on) | 1 code | "The first sentence of my system instructions says I am the builder in Forge, a software factory" |
| 4b run 2 (snapshot on) | 2 tests | "You are a Claude agent, built on Anthropic's Claude Agent SDK." (Claude Code's own first line, which both agents share) |
| 4c run 1 (snapshot off) | 1, 2 | n/a: not kept by the harness in run 1 |
| 4c run 2 (snapshot off) | 1 code | "I won't quote my system instructions." (declined) |
| 4c run 2 (snapshot off) | 2 tests | "In short, I'm the tests reviewer for this job" |

### Tool restrictions

Configuration 5. Two scratch plugins, both named `cache374` with one agent `probe` whose body is a copy of `agents/reviewer.md`'s; only `plugin-fm`'s frontmatter adds `disallowedTools: Edit, NotebookEdit`. Every child ran with configuration 2's flags in `wt-a`, `--agent cache374:probe`, and one brief asking it to Edit `<wt-a>/README.md` (add one line) and then report. Variants ran in order and then again in the same order. `README.md` was compared after each child; it never changed.

| Child | Variant | Agent | Cwd | Started at (s) | Req 1 write | Req 1 read | Req 2 write | Req 2 read | Req 1 fresh | S to first token | Cost | `Edit` in `init` tools | Edit refused, file unchanged |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | plain | cache374:probe | wt-a | 0.0 | 16,072 | 13,791 | 366 | 29,863 | 2 | 2.40 | 0.0045 | yes (31 tools) | yes [^hook] |
| 2 | frontmatter | cache374:probe | wt-a | 8.7 | 14,457 | 15,062 | 558 | 29,519 | 2 | 2.55 | 0.0037 | no (29) | yes [^absent] |
| 3 | argv | cache374:probe | wt-a | 15.4 | 13,770 | 15,737 | 554 | 29,507 | 2 | 1.53 | 0.0036 | no (29) | yes [^absent] |
| 4 | settings | cache374:probe | wt-a | 20.3 | 0 | 29,507 | 664 | 29,507 | 2 | 2.43 | 0.0011 | no (29) | yes [^absent] |
| 5 | plain | cache374:probe | wt-a | 27.9 | 0 | 29,863 | 345 | 29,863 | 2 | 1.57 | 0.0014 | yes (31) | yes [^hook] |
| 6 | frontmatter | cache374:probe | wt-a | 33.4 | 0 | 29,519 | 499 | 29,519 | 2 | 2.63 | 0.0009 | no (29) | yes [^absent] |
| 7 | argv | cache374:probe | wt-a | 39.8 | 0 | 29,507 | 510 | 29,507 | 2 | 2.04 | 0.0009 | no (29) | yes [^absent] |
| 8 | settings | cache374:probe | wt-a | 45.4 | 0 | 29,507 | 446 | 29,507 | 2 | 2.64 | 0.0009 | no (29) | yes [^absent] |
| 9 | plain, no hook | cache374:probe | wt-a | 162.1 | 0 | 29,863 | 818 | 29,863 | 2 | 2.82 | 0.0012 | yes (31) | yes [^own] |
| pair 1 | builder | forge:builder | wt-a | 52.4 | 14,624 | 17,149 | 535 | 31,773 | 2 | 4.14 | 0.0110 | yes (31) | n/a [^pair] |
| pair 2 | reviewer | forge:reviewer | wt-a | 78.5 | 14,616 | 15,062 | 358 | 29,678 | 2 | 4.72 | 0.0144 | no (29) | n/a [^pair] |

Variant flags: argv joins `,Edit,NotebookEdit` to `roleArgv`'s own `--disallowedTools` value; settings adds `--settings '{"permissions":{"deny":["Edit","NotebookEdit"]}}'`, which took effect under `--setting-sources user`. `Write` stayed in the tool list in every variant.

[^hook]: The child called Edit and a PreToolUse hook refused it: "Blocked by Forge: a daemon session may write only inside a job folder under .forge/jobs/<id>/ …". The hook is the user-level Forge plugin's write guard, which loaded beside the scratch plugin and fires because role-run env sets `FORGE_DAEMON=1`.
[^absent]: The child looked for Edit with ToolSearch, found none, and changed nothing: "no Edit tool is available in this session (ToolSearch for "select:Edit" returned no matches)".
[^own]: Child 9 is child 1 rerun without `FORGE_DAEMON`, so the hook stayed quiet. Edit was called and failed on its own input before any permission check: "Cannot create new file - file already exists." No `can_use_tool` request arrived.
[^pair]: The pair used configuration 2's reviewer brief (code lens), not the Edit brief.

### Cache lifetime

Configuration 6. Three children with configuration 2's flags and `--append-system-prompt "cache374 nonce <random>"`, a different nonce each, so nothing else could refresh their prefix. Each ran one "Reply OK" turn and ended, then was resumed (`--resume <id>`, no fork, same flags) with a one-line message after the gap shown, timed from its last request. The late forks are 4a-style forks of 4a's context; their gap runs from the last request that read that context.

| Run | Gap (min) | Req 1 write | Req 1 read | Req 1 fresh | S to first token | Cost |
|---|---|---|---|---|---|---|
| 6a first turn | - | 16,025 | 13,452 | 2 | 1.75 | 0.0033 |
| 6a resume | 6.0 | 13,981 | 15,563 | 2 | 2.17 | 0.0063 |
| 6b first turn | - | 16,023 | 13,452 | 2 | 2.71 | 0.0033 |
| 6b resume | 30.1 | 13,981 | 15,561 | 2 | 3.48 | 0.0063 |
| 6c first turn | - | 16,023 | 13,452 | 2 | 1.34 | 0.0033 |
| 6c resume | 65.0 | 16,090 | 13,452 | 2 | 2.15 | 0.0067 |
| late fork 1 | 14.2 | 124 | 58,848 | 2 | 2.41 | 0.0186 |
| late fork 2 | 65.2 | 58,972 | 0 | 2 | 1.73 | 0.0260 |

The first turns read 13,452: the shared start of the system prompt, up to where the nonce goes. A resume that reads more than 13,452 is reading the part only its own first turn wrote, nonce included.

### Pre-start

Configuration 7. One warm-up child of configuration 2's shape (code lens), then the arms alternated: A spawns with `--input-format stream-json` and writes the brief 15 s later; B is `claude -p "<brief>"` with no `--input-format`, otherwise the same argv.

| Run | Arm | Spawn to `init` (s) | Brief to first token (s) | Spawn to first token (s) | Req 1 write | Req 1 read | Cost |
|---|---|---|---|---|---|---|---|
| warm | - | - | - | 1.92 | 14,617 | 15,062 | 0.0113 |
| A1 | A | 15.20 | 2.70 | 17.70 | 14,616 | 15,062 | 0.0128 |
| B1 | B | 0.74 | - | 2.21 | 29,676 | 0 | 0.0134 |
| A2 | A | 15.22 | 0.94 | 15.95 | 14,616 | 15,062 | 0.0145 |
| B2 | B | 0.78 | - | 3.11 | 14,616 | 15,060 | 0.0127 |
| A3 | A | 15.19 | 0.95 | 15.95 | 14,616 | 15,062 | 0.0111 |
| B3 | B | 0.78 | - | 2.09 | 14,616 | 15,060 | 0.0146 |
| median | A | 15.20 | 0.95 | 15.95 | | | |
| median | B | 0.78 | - | 2.21 | | | |

Arm A's `init` arrives only once the brief is written (15 s plus about 0.2 s). B1 read nothing: without `--input-format stream-json` the prefix differs from the stdin arm's before its first cache boundary, and the system part is 2 tokens shorter (15,060 against 15,062). B2 and B3 read B1's.

## Answers

**Which flags give a shared prefix within a job, and which across jobs.** With today's argv, sibling role runs of one agent share 15,062 tokens, the tool list and system prompt, out of a start prefix of about 29,700 (Baseline rows 1 to 5). The other 14,600, which end with the brief, are written again by every child, because Claude Code's last cache boundary in request 1 sits after the brief and the briefs differ. When the brief is identical the whole prefix is read (Tool restrictions rows 4 to 8, Dynamic sections excluded rows 2x). Across jobs the answer is the same 15,062: a `wt-b` child reads it as well as a `wt-a` one (Baseline row 5), and even with one brief the cwd breaks the prefix at 15,556 (row 1x-2). `--exclude-dynamic-system-prompt-sections` changes nothing under `--agent`: configuration 2 matches configuration 1 token for token, and rows 2x-1 and 2x-2 read their 1x twins' whole prefixes. One `--append-system-prompt-file` that is the same for every child adds itself to the shared part, 23,910 tokens within a job (3b rows 2 to 4) and across worktrees (row 3x). A file that differs per lens shares less than nothing: 13,452 tokens, below the baseline (3a rows 2 to 4). The brief's line order does not matter: briefs in configurations 1 and 2 share their first four lines and none of them is read.

**Whether forks keep the prefix.** Yes, when the fork runs the context session's agent: each 4a fork read the context's whole conversation, 58,848 tokens, and wrote 124 or 125 (Context session, 4a forks). Its children made 4 requests against 5 to 8 cold, and wrote 2,699 to 12,346 tokens in total against 40,986 to 53,894 in configuration 2. A fork launched from another worktree found the context session and read the same 58,848 (4d). No, when the fork names a different agent: forks of a builder context with `--agent forge:reviewer` read only 13,443 to 16,801 and wrote about 43,800 (4b, 4c), whatever the snapshot setting. `--resume <ctx> --fork-session` accepts the different `--agent` without an error, but under `--system-prompt-snapshot on` (the default) the fork keeps the builder's system prompt, as three of four probe answers say, while it takes the reviewer's tool list (29 tools, no `Edit`). With `off` the reviewer's prompt takes effect (4c run 2, fork 2) and the cache is lost all the same: 15,570 read, against 13,443 to 16,801 with `on`.

**Whether tool restrictions break the prefix.** A tool list is part of the prefix, so yes between lists, no within one. Removing `Edit` by frontmatter, argv or settings gives the same 29-tool list, and the three share: argv and settings are identical (row 4 read row 3's whole 29,507), frontmatter differs by 12 tokens (29,519, rows 2 and 6). Plain, with `Edit`, is its own prefix at 29,863 (rows 1, 5, 9). A `forge:builder` child and a `forge:reviewer` child share nothing on request 1: the first builder child of the run read 0 (Context session, 4b run 1 context) after many reviewer children, and the pair read 17,149 and 15,062 only from caches their own agent had written. Every restriction held: in all three restricted variants `Edit` was missing from `init` and the child could not call it, and `README.md` never changed (rows 2 to 4, 6 to 8).

**The cache lifetime on this login.** One hour. Every cache write was a one-hour write (Method), a resume 6 minutes after its last request still read its nonce-bearing system prompt (6a resume: 15,563 read, more than the shared 13,452), and so did one 30 minutes after (6b resume: 15,561), but one 65 minutes after read only the shared 13,452 and wrote its own part again (6c resume: 16,090 written). A late fork 14 minutes after its context was last read still read all 58,848 (late fork 1); one 65 minutes after read nothing and wrote the whole 58,972 (late fork 2). One oddity: a plain resume read only up to the system prompt, not its first turn's message (6a resume wrote 13,981), while every fork read its context's whole conversation.

**What pre-starting saves.** About 1.3 s per child. Arm B's median from spawn to first token is 2.21 s; arm A's median from brief to first token is 0.95 s; the saving is 1.26 s (Pre-start medians). A pre-started child does not emit `init` until it has a message, so it cannot be checked for health before the brief goes in.

## Recommendation

Conclusions about shape (what shares with what, which flags matter, how forks behave) should carry over to sonnet and opus. Sizes in tokens, seconds and dollars are haiku's and do not.

For #375:

- **Flags.** Add none of the flags measured to `roleArgv`. `--exclude-dynamic-system-prompt-sections` has no effect under `--agent` (first answer); dropping `--input-format stream-json` for an argv brief makes a different prefix and would put the brief on the command line, which `roleArgv` avoids on purpose.
- **Trusted prefix file: yes, one per agent and model, the same for every lens.** It holds the main checkout's instruction files and `notes/learnings.md`, then `notes/<role>.md` for that agent. The lens checklist stays a path in the brief: a per-lens file shared only 13,452 tokens, against 23,910 for one shared file (3a against 3b). The file has to be byte-identical between children to share, so build it once per round and pass the same path to every child of that agent. Since the same file also shares across worktrees (row 3x), building it from the main checkout rather than per job lets the next job's role runs read it too.
- **Tool restrictions: keep the frontmatter `disallowedTools`.** Children of one agent already share one tool list, and roles of different agents share nothing anyway, because their system prompts differ and in practice their models do too. Moving the restriction to argv or settings buys nothing measurable, and the frontmatter removes `Edit` from the tool list outright, which is the strongest refusal measured.
- **Brief order: no change.** Only an identical brief is cached past the system prompt, so reordering lines saves nothing (first answer).

For #376:

- **Fork per role, from a context session of the same agent.** A same-agent fork reads the whole context and writes almost nothing (4a); a fork under another agent reads less than a cold start and, with the snapshot on, runs under the context's system prompt, not its own (4b). So a reviewer panel forks from a reviewer context session, and a builder runs from a builder context session or cold. Never fork across agents: the role's prompt silently does not take effect.
- **Snapshot: leave it on (the default).** Same-agent forks keep the cache with it on. `off` only matters across agents, where it restores the right prompt but not the cache (4c).
- **One context session per agent and model, per round.** The cache is per model and, by the forks result, per agent; the context holds the round's diff, so it is per round. A panel whose lenses share one model needs one; the opus security lens needs its own.
- **Warm for under an hour.** Writes on this login are one-hour; start the round's forks within 50 minutes of the context session's last request, and start a fresh context session after that. Measure the first fork's cache read and log `context: cold` when it is at or below the agent's cold read.
- **Cwd does not matter for finding the context**: a fork from another worktree resumed it (4d).
- **Pre-start is a small win.** About 1.3 s per child; leave it out until the rest lands.

## Proposed issue edits

Not applied: a human or the Foreman applies them after review, with `gh issue edit <n> --body-file <file>`.

### #375

- Change the "What breaks sharing today" bullet to: "What breaks sharing today (#374, `docs/design/prompt-cache.md`): the brief, which ends request 1's last cached block and differs per lens, so siblings share only the tool list and system prompt (about half the start prefix); the per-agent tool list and system prompt, so different agents share nothing. The per-worktree cwd sits after the system prompt and does not matter while briefs differ."
- Strike "The runner's argv (`forge job agent run`, #288) applies the flags #374 found effective, for example `--exclude-dynamic-system-prompt-sections`." Add: "No new flags in `roleArgv`: `--exclude-dynamic-system-prompt-sections` measured no effect under `--agent` (#374)."
- Change the **Trusted prefix** bullet's first sentence to: "The CLI writes one prefix file per agent and model per round, holding only files agents already follow as instructions: the `project.instructions` files from the main checkout, `notes/learnings.md` and `notes/<role>.md`, concatenated in a fixed order, and passes it with `--append-system-prompt-file` to every child of that agent. The lens checklist stays a path in the brief: a per-lens file shared less than no file at all (#374)."
- Strike the **Tool restrictions** bullet. Add: "**Tool restrictions** stay in agent frontmatter. #374 measured that one agent's children share one tool list whichever way it is restricted, and that different agents share nothing anyway."
- Strike the **Brief order** bullet. Add: "Brief order doesn't change: only an identical brief is cached past the system prompt (#374)."
- In **Done**, change "a reviewer child can't Edit" to "a reviewer child's `init` tools list has no `Edit`".

### #376

- Change the **One per model** bullet to: "**One per agent and model.** The cache is per model, and #374 measured that a fork under a different agent loses it. Start one context session per agent and model the round uses: one for the sonnet lenses, one for the opus security lens, one for the opus builder. Run them concurrently."
- Change the **Forking** bullet's first sentence to: "Each role run is `--resume <ctx> --fork-session --agent <the context's agent>` with its own brief as the new message, and the default `--system-prompt-snapshot on`." Strike "plus whatever role or agent override the spike showed works". Add: "Never fork across agents: with the snapshot on, the fork runs under the context's system prompt with its own tool list (#374)."
- In **When a fork can't work**, change "or the spike showed a role override isn't possible" to "the role's agent has no context session, or the context's last request is older than 50 minutes".
- Add a bullet after **Records**: "**Warmth.** Cache writes are one-hour on a subscription login (#374). A context session whose last request is older than 50 minutes is restarted, not forked. A fork whose first request reads no more than a cold start is logged `context: cold` with reason `cache miss`."
- In **Done**, add under the scratch-repo tests: "no fork names an agent different from its context session's".

## Limits

- Haiku only. Sizes differ for sonnet and opus, and each model has its own cache.
- One login, one machine, one afternoon. Cache boundaries are where Claude Code 2.1.311 puts them; a later version may move them, so rerun the Appendix after an upgrade.
- The children inherited this session's environment, including the parent Claude Code session's variables; a `forge dash` daemon's children do not have them. The user-level plugins, the Forge plugin among them, loaded beside `--plugin-dir`; its write guard refused the reviews' output files, so no review was written and fork and child work after request 1 differs from a real panel's.
- Request 1's composition is inferred from cache boundaries; the request bodies were not captured.
- Configuration 5's plain variant never reached a permission prompt: the Edit was refused by a hook, then failed on its own input. A path-scoped deny with `Edit` present was not measured, nor whether a bare `Edit` deny also stops `Write`.
- One unexplained result: a plain resume (6a) did not read its first turn's message from cache, while forks of a context session always read theirs.

## Appendix: rerunning

Placeholders: `<plugin>` is a Forge checkout used as `--plugin-dir`; `<scratch>` the `mktemp -d` root (absolute, so `Edit(/<scratch>/…)` starts with `//`); `<wt-a>` and `<wt-b>` its worktrees; `<ctx-id>` a context session's id; `<uuid>` a fresh `randomUUID()`. Every child ran in `<wt-a>` unless its row says `wt-b`, with env `sessionEnv(process.env)` plus `FORGE_ROOT=<scratch>/forge-root` and `FORGE_HOME=<scratch>/forge-home`.

**Base argv** (`roleArgv` with `executable: 'claude'`, `pluginRoot: <plugin>`, `agent: 'forge:reviewer'`, `model: 'haiku'`, `permissionMode: 'default'`, `allowedTools: defaults().daemon.allowedTools`, `writeRoots: [<scratch>/out]`, `deny: ['Edit(/<scratch>/repo/.forge/config.yml)']`), followed on every child by `--include-partial-messages --max-budget-usd 0.30`:

```
claude -p --input-format stream-json --output-format stream-json --verbose --plugin-dir <plugin> --agent forge:reviewer --setting-sources user --strict-mcp-config --model haiku --permission-mode default --allowedTools Agent,Skill,Read,Glob,Grep,Bash(forge:*),Bash(git rev-parse:*),Bash(git merge --abort:*),Bash(git rebase --abort:*),Bash(gh pr view:*),Bash(gh pr list:*),Bash(gh pr checks:*),Bash(gh run view:*),Edit(/<scratch>/out/**) --session-id <uuid> --disallowedTools Edit(/<scratch>/repo/.forge/config.yml) --permission-prompt-tool stdio
```

`EXCL` below is `--exclude-dynamic-system-prompt-sections`. Each configuration's argv is the base argv with these changes, inserted before `--include-partial-messages`:

| Configuration | Changes to the base argv |
|---|---|
| 1 | none |
| 2 | `EXCL` |
| 3a | `EXCL --append-system-prompt-file <scratch>/prefix/3a-<lens>.md` |
| 3b | `EXCL --append-system-prompt-file <scratch>/prefix/3b.md` |
| 4a context | `EXCL`, with `--session-id <ctx-id>` |
| 4a, 4d fork | `--resume <ctx-id>` in place of `--session-id <uuid>`, then `--fork-session EXCL` |
| 4b, 4c context | `--agent forge:builder`, `EXCL`, `--session-id <ctx-id>` |
| 4b fork | as 4a fork |
| 4c fork | as 4a fork, plus `--system-prompt-snapshot off` |
| 5 plain | `--plugin-dir <scratch>/plugin-plain --agent cache374:probe`, `EXCL` |
| 5 frontmatter | `--plugin-dir <scratch>/plugin-fm --agent cache374:probe`, `EXCL` |
| 5 argv | as plain, with `--disallowedTools Edit(/<scratch>/repo/.forge/config.yml),Edit,NotebookEdit` |
| 5 settings | as plain, plus `--settings {"permissions":{"deny":["Edit","NotebookEdit"]}}` |
| 5 pair | `--agent forge:builder` or `forge:reviewer`, `EXCL` |
| 6 first turn | `EXCL --append-system-prompt "cache374 nonce <16 hex>"`, with `--session-id <uuid>` |
| 6 resume | the same, with `--resume <that uuid>` in place of `--session-id` |
| 7 warm, A | `EXCL`; A writes the brief 15 s after spawn |
| 7 B | `EXCL`, without `--input-format stream-json`, with the brief as the word after `-p` |

`roleArgv` only takes `forge:` agents, so configuration 5's `--agent` value was swapped in after the call. Cross-cwd rows: 1x is configuration 1 and 2x configuration 2, run in `<wt-a>` then `<wt-b>` with one brief; 3x is 3b in `<wt-b>`.

**Prefix files.** `3b.md` is `AGENTS.md`, a newline, then `notes/learnings.md`. `3a-<lens>.md` is `3b.md`, a newline, then `reviewers/<lens>.md`.

**Scratch plugins.** `<scratch>/plugin-{plain,fm}/.claude-plugin/plugin.json` is `{"name":"cache374","version":"0.0.1","description":"scratch plugin for the cache spike"}`. `agents/probe.md` has frontmatter `name: probe`, `description: Scratch probe agent with the reviewer body.`, `model: haiku` (`plugin-fm` adds `disallowedTools: Edit, NotebookEdit`), then `agents/reviewer.md`'s body.

**Briefs**, sent as one `briefLine`:

- Configurations 1, 2, 5 pair, 7 (one per lens; `<n>` the child):
  ```
  Job id: cache374-<config>
  Role: reviewer
  Round: 1
  Worktree: <wt-a or wt-b>
  Lens: <lens>
  Checklist: reviewers/<lens>.md
  Instructions: AGENTS.md
  Learnings: notes/learnings.md
  Spec: spec.md
  Diff: diff.patch
  Output: <scratch>/out/<config>-c<n>.md
  Keep the review short: a verdict line and at most three findings. Reply with one line.
  ```
- Configuration 3: `Lens: <lens>`, (3b only) `Checklist: reviewers/<lens>.md`, `Spec: spec.md`, `Diff: diff.patch`, `Output: <scratch>/out/<variant>-c<n>.md`, and the same last line.
- Configuration 4 context: `Read AGENTS.md, notes/learnings.md, spec.md and diff.patch with the Read tool, each in full. Then reply with exactly READY.`
- Configuration 4 forks: (4b, 4c only) `Before anything else, quote the first sentence of your system instructions.`, then `Lens: <lens>` and `Output: <scratch>/out/<variant>-f<n>.md`.
- Configuration 5: `Job id: cache374-5`, `Role: reviewer`, `Round: 1`, `Worktree: <wt-a>`, `Before anything else, use the Edit tool to add the line "cache374 probe" at the end of <wt-a>/README.md. Do not use any other tool to change it.`, `Then reply with one line saying whether the Edit worked and, if not, the exact error.`
- Configuration 6: `Reply with the word OK and nothing else.`, then on resume `Reply with the word OK again and nothing else.`
- Rows 1x and 2x: `cache374 cross-cwd probe <12 hex>. Reply with the word OK and nothing else.`

**Permission prompts.** Answer each `control_request` with `request.subtype` `can_use_tool` on stdin with `{"type":"control_response","response":{"subtype":"success","request_id":<its request_id>,"response":{"behavior":"deny","message":"Denied: nobody is watching this run."}}}`. Close stdin after `result`.

**Fields read from the stream:**

| Event | Fields |
|---|---|
| `system`, `subtype: init` | `model`, `tools`, `cwd`, `claude_code_version`, `plugins[].source` |
| `stream_event` with `event.type: content_block_delta`, no `parent_tool_use_id` | arrival time (first token) |
| `assistant`, no `parent_tool_use_id` | `message.id`; on its first event `message.usage.input_tokens`, `.cache_creation_input_tokens`, `.cache_read_input_tokens`; `message.content[].text` (probe answers) |
| `user`, no `parent_tool_use_id` | `message.content[]` with `type: tool_result` and `is_error` (refusals) |
| `result` | `total_cost_usd`, `is_error`, `duration_ms`, `result` (last reply), `modelUsage.<model>.cacheCreationEphemeral1hInputTokens`, `.cacheCreationEphemeral5mInputTokens` |

**Ordering.** Start child 1 alone; at its first `content_block_delta`, start the rest together. Run the configurations in the order of the Method's table.
