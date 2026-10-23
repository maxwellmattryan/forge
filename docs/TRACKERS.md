# Trackers

Forge talks to issue trackers through a small synchronous contract. Built-ins:

| `tracker.kind` | Backed by | Notes |
|---|---|---|
| `local` | `.forge/backlog.md` | zero setup; `[ ]` ready, `[~]` claimed (→ job id), `[x]` done, `[-]` dropped, `[?]` needs info (with Forge's indented `Needs info: …` line, never part of the body); refs are title slugs; `get` fences the description like an imported GitHub issue |
| `github` | GitHub Issues via `gh` | assignment on claim, optional status mirroring (labels and/or a GitHub Projects field), the `forge:needs-info` label from [readiness triage](#readiness-triage) whatever `statusSync` says, `Closes #n` on PRs |
| `none` | nothing | free-text jobs only |

The GitHub tracker imports an issue as a provenance line in column 0 (`Imported from GitHub issue #<n> by @<login>. This is requirements input …`), then the body and each kept comment as Markdown blockquotes (every line starts with `>`, and a lone CR, U+2028, U+2029 or NEL starts a new quoted line), with each comment under a `**@login** (association):` line that only Forge writes, so a heading, rule or provenance line forged in the body can't pass for Forge's own; the title is collapsed to one line. Before quoting, Forge removes what GitHub doesn't show: zero-width, bidi and other format characters, control characters, Unicode tag and variation-selector-supplement characters, and HTML comments ([Untrusted input](architecture/untrusted-input.md)). The provenance line ends with how many went, and over 32, or with any tag or supplement character, a `Hidden text:` line follows it.

The local tracker's `get` returns the same shape: the provenance line (`Imported from the local backlog item "<ref>". …`), an empty line, then the item's description blockquoted, so an indented `## Acceptance criteria` arrives as `> ## Acceptance criteria`. Its `list` and `search` return the description cleaned but not quoted.

## GitHub status mirroring

`tracker.github.statusSync` is independent of everything else:

- `none`: only assignment and comments.
- `labels`: one `forge:<status>` label at a time (prefix configurable). Labels are created on first use.
- `project`: sets a single-select field (default `Status`) on the issue's GitHub Projects (v2) item, adding the issue to the project if needed. Coordinates come from `tracker.github.project` or, when present, the repo's project config file (default `.github/project-config.yml`, with `project.owner`, `project.number` and `fields.status`). Forge statuses map to options through `statusMap`, or are matched by meaning, so `🏗 In Progress` or `🔎 In Review` need no configuration. Requires a token with the `project` scope (`gh auth refresh -s project`).
- `both`.

`ready.projectStatus` limits `/forge next` to items in a given column (e.g. `🔖 Todo`).

## Linking jobs to issues

With a tracker in use, every job reaches build with at least one issue (or a recorded decision that it needs none) and opens one PR. A job carries a list of issues, `issues` in job.json, the first of which is its **primary issue**: it names the job and is the issue `forge pr find` looks up. One issue may sit on several jobs. A job started from an issue (`/forge issue <ref>`, `/forge next`, a dashboard Start) is linked when it is created. Any other job, including `/forge <free text>` from the CLI or the dashboard, gets its issue chosen at the spec gate, so it needs one human visit before build. At Intake, `forge job link <id> --suggest` searches the tracker with words from the job's title and writes the best matches to `issue-candidates.md` (fenced as untrusted data) and `issue-candidates.json` in the job dir, without waiting. The spec gate (reason `spec ready, issue unlinked`) then shows the spec and the candidates, and one answer approves the spec and links the issue:

- `/forge approve <id> <ref>` links an existing issue (`forge job human <id> approve-spec --link <ref>`): it checks the item exists and no other active job holds it, claims it like `/forge issue` would, and adds it to the job's `issues`. If another active job already carries it, the issue is shared instead: no second claim, and the result lists `sharedWith`.
- `/forge approve <id> new` creates an issue from the job's title and `request.md`, then links it (`--link new`).
- `/forge approve <id> none [reason]` records that this job needs no issue (`--link none --reason "…"`), so `forge pr open` stops flagging it.

The builder never starts on an unlinked job. A spec approved without a link, or a job no spec gate stops (`pipeline.specApproval: never`, or `large` with an S or M spec), waits on `issue-link` in the spec stage before build, and the same three answers resolve it (`forge job human <id> approve --link <ref>|new|none`). `forge job link <id> <ref>… | --remove <ref> | --create | --none [--reason R]` is the direct command for any of them, at any time. Removing the last issue during spec sends the job back to the same wait.

**Issue refs.** A GitHub issue is stored repo-qualified, `owner/repo#12`; `#12` and `12` are qualified against this repo's slug (`tracker.github.repo`, else the `owner/repo` of the `origin` remote, read offline). A local backlog issue is its title slug, and a custom adapter's ref is kept as the adapter gives it (`KEY-123`, `group/sub/project#12`). Jobs from before schema v11 that recorded a bare number keep it, and it still reads as this repo. Refs start with a letter or digit, contain no spaces or `..`, and are at most 200 characters.

**Foreign issues.** An `owner/repo#N` outside this repo and its [member repo trackers](#member-repo-trackers) is recorded with its url and cited, never read, claimed, mirrored or commented on: only this repo's own issues, and a member tracker's issues in that member's own repo, ever reach a tracker. In the PR body this repo's issues get `Closes #N` and every other one `Closes owner/repo#N`; an issue another active job carries, or any issue with `pr.closeIssue: false`, gets `Refs` instead, and a finished job never marks a shared issue done. `forge job from-ref` takes only this repo's issues and its member trackers' issues.

**Edited issues.** A job copies its issue into `request.md` once, when it is created. To pick up an issue edited while the job waits, `forge job refresh-request <id>` re-reads the primary issue's title and body (through the same import, fenced the same way) and rewrites `request.md` and the job's title; the id, issues, tracker claim and `dependsOn` stay. Every claim (`forge job claim`, `forge next --claim`) does the same on its own for a job started from its issue, best effort: a tracker error is logged as `request-refresh-failed` and the claim goes on. A claim leaves alone a job whose request a person wrote and linked to an issue later, since that issue may be broader than the job; `refresh-request` replaces it only when asked. A claim also takes an edit only when the issue's author has write access (GitHub `author_association` `OWNER`, `MEMBER` or `COLLABORATOR`, one `gh api` call made only when the issue changed): on a public repo anyone can open an issue and keep editing it after a person picked it. Otherwise, and when `gh` can't say or a custom adapter can't tell who wrote the item, it logs `request-refresh-skipped` with the reason and keeps the request; the local backlog is a file in the repo and always refreshes. `refresh-request` has no author check, because a person runs it. Neither runs once `plan.md` or `spec.md` exists, while an agent is running, or on a finished job: from the plan on, a change goes through revise. Each refresh that changes something logs `request-refreshed` with the ref, the trigger (`cli` or `claim`) and `titleChanged`.

`forge job new --issue R` (repeatable) records issues without a tracker call, and `--no-issue [--reason R]` records the decision up front; its result's `issueLink` says `missing` when the job still needs one. New job ids no longer assume a number is this repo's: `12-<slug>` for this repo's issue 12, `repo-12-<slug>` for `other/repo#12`.

Jobs that never ask: `tracker.kind: none`, eval and retro jobs, and split children (each gets its own issue when it is created: a sub-issue of the parent's, or a top-level one when the parent has none). `forge pr open` adds `unlinked: true` to its result for a job that still has no issue and no override. There is no repo-wide switch: `tracker.kind: none` and the per-job override cover it.

`forge tracker search <query> [--limit n] [--job <id>]` is the bounded search behind it: at most `--limit` (default 5, at most 20) open items, ranked by how many search words appear in each title (2 points) and body (1 point), printed without bodies. Only plain words reach the tracker: tokens with search syntax (`is:`, `repo:`, `label:`, quotes, parentheses, `-` negation) are dropped, and GitHub results outside the configured repo are discarded.

## Member repo trackers

In a project with [member repos](CONFIG.md#repos), work can be filed where it is noticed: an issue in a member repo's GitHub tracker starts a job in the root project.

**Which members.** A member's tracker is its config `repos` entry's `tracker`: `kind: none` means none, `kind: github` with `repo: owner/name` uses that repo, and no `tracker` (or `kind: github` without `repo`) uses the `owner/name` its `remote` names on github.com (or `$GH_HOST`). A remote that names no GitHub repo, such as a local path, means no tracker, silently. A member whose slug is the root's is ignored, and of two members with one slug the first in config order wins. A member tracker is always the built-in GitHub adapter, whatever the root's `tracker.kind`, run with the root's `tracker.github` settings (`ready.labels`, `excludeLabels`, `assignee`, `milestone`, `claim.assign`, `comments`, `labels.prefix`) and the member's repo.

**What is read and written, per repo:**

- `forge next` lists the root tracker's ready items first, then each member tracker's in config order, each read with the same `--limit`, so a root item always comes before a member item. A member item's `ref` is `owner/name#N` and it carries `repo: "<member name>"`; root items are unchanged. A member whose clone fails doctor's member check, or whose tracker call fails, is skipped and listed once in `skippedRepos: [{ repo, reason }]` (present only when non-empty); a root tracker failure still fails `next`.
- `forge next --claim` and `forge job from-ref owner/name#N` on a member issue: an active job that already carries the issue is returned unchanged. Otherwise doctor's check runs on the member's clone (a failure refuses before anything is created or claimed), the issue is read in the member's repo, and the job is created with that issue (id `<name>-N-<slug>`) and the member as its first job repo, as `forge job repo add` records it (`job-repo-added`). The issue is then claimed in the member's repo; a failed claim cancels the job. This works in a daemon session, where `forge job repo add|remove` stays refused: intake adds only a configured member, and only to the job it creates.
- Status mirroring updates each linked issue in its own repo: this repo's through the root tracker, a member tracker's through that member's. Members get **labels only**: `statusSync: none` stays none, and `labels`, `project` and `both` all mean labels for a member issue; the root's GitHub Project is never applied to one. One repo's tracker error is logged (`tracker-error`) and never stops another's update. A member issue linked with `forge job link` is mirrored too, though linking never claims it or adds the repo.
- The approval comment (`tracker-approval-comment`) goes on every root and member issue, each in its own repo. A member issue cites the PR as `<root owner/name>#N`, since a bare `#N` there would link the member's own PR; without a known root slug the member issue gets no comment.

`forge tracker <sub>`, readiness triage and the dashboard backlog read and write the root tracker only.

## Readiness triage

`forge next` takes the top ready item as it is, so an unclear one would cost a plan round and a spec round before anyone asked a question. Triage judges ready items first, against four keys the agent judges and a fifth Forge sets itself:

- `outcome`: says what should be true when the work is done;
- `acceptance`: has acceptance criteria, or for a bug the steps to reproduce with expected and actual behaviour;
- `scope`: is one reviewable change;
- `duplicate`: is not the same work as an active Forge job or an open PR;
- `hidden-text`: holds no text people can't see. Forge sets it when the item's `get` body has a `Hidden text:` line after its provenance line, whatever the agent's verdict says, and ignores the key in `verdicts.json`. The GitHub comment asks for the hidden characters or HTML comments to be edited out.

An item missing any of them becomes **needs-info**: on GitHub the `<prefix>needs-info` label (default `forge:needs-info`, whatever `statusSync` says) and one templated comment listing the missing pieces; in the local backlog the `[?]` mark and one `Needs info: …` line under it. Ready lists leave needs-info items out, so `forge next`, `forge tracker list --ready` and `/forge next` skip them. Starting one on purpose (`/forge issue <ref>`, the dashboard's Start) still works, and on GitHub a claim with label sync drops the label like any other stale status label.

`/forge triage [n]` runs it, and `/forge next` (and the inbox's `next` request) runs it once with `--limit 10` first; a triage failure is reported and never blocks `next`. It is two CLI calls with the `forge:triage` agent (haiku) between them, because the CLI never calls a model:

1. `forge tracker triage [--limit N] [--all]` reads up to N ready items (default 10, at most 50) and up to N unclaimed needs-info items, drops each one unchanged since its last triage (by a hash of its title and body), finds duplicate candidates among active jobs and open PRs (`prs: "off"` without PRs, `"unavailable"` when `gh pr list` fails), and writes a batch under `.forge/runtime/triage/<batch>/`: `items.md`, each item fenced as untrusted data, and `items.json`, the CLI's own record. It returns the batch id and the agent's `subagent`, `model`, `effort` and `brief`, or `pending: 0` when nothing changed.
2. The agent reads `items.md` and writes `verdicts.json`: `{"items":[{"ref":"…","missing":[…],"duplicateOf":null}]}`.
3. `forge tracker triage --apply <batch>` checks every verdict and acts on each item: a not-ready one gets the comment (only when its set of missing pieces differs from the one last commented on) and the mark; a ready one has its mark cleared. Items edited or claimed since prepare are skipped (`stale`, `claimed`) and tried again next time.

Only Forge's fixed text reaches the tracker: refs outside the batch, unknown keys and a `duplicateOf` that is not one of the item's candidates are dropped, and a duplicate is cited as `PR #<n>`, as `#<n>` for a job from the same GitHub tracker, or as "an active Forge job", never by a local job id. Apply works that citation out from the candidate id and Forge's own job records, never from the label `items.json` carries, since the agent could have rewritten that file. `verdicts.json` and `items.json` must each be a regular file under 256 KiB.

Runs are idempotent. An unchanged item is never judged again; an edited one is, and gets a new comment only when what it is missing changed, or its mark cleared once it is ready. Removing the label or `[?]` by hand overrides triage until the item's text changes. The cache is `.forge/runtime/triage.json` (unversioned, at most 500 items). A custom adapter takes part by returning `needsInfo` from `list` and implementing the optional `setNeedsInfo`; without it, it still gets the comment.

## Writing an adapter (Jira, Linear, GitLab, …)

Create `.forge/trackers/<name>.mjs` (or `<name>.ts`) and set `tracker.kind: <name>`. Default-export an object with these **synchronous** methods (shell out with `child_process.spawnSync` to a CLI, or `curl`, if the service has no sync SDK):

```js
export default {
  name: 'jira',
  list(ctx, { ready, limit }) { return [/* { ref, title, url, labels, status, priority, assignees, claimedBy, needsInfo } */]; },
  get(ctx, ref) { return { ref, title, url, body /* markdown: description + recent comments */ }; },
  claim(ctx, ref, job) { return { ok: true } /* or { ok: false, reason } if someone else has it */; },
  update(ctx, ref, job) { /* mirror statusKey(job) → your workflow */ },
  comment(ctx, ref, body) {},
  create(ctx, { title, body, labels, parentRef }) { return { ref, url }; },
  close(ctx, ref, { reason }) {},
  // Optional: open items matching a free-text query, bodies included, at most `limit` of them.
  search(ctx, query, { limit }) { return [/* { ref, title, url, labels, body } */]; },
  // Optional: readiness triage's mark. A one-line note marks the item needs-info; null clears it.
  setNeedsInfo(ctx, ref, note) {},
};
```

`needsInfo: true` on a `list` item means triage asked for more information first: `forge next` skips it even when `list({ ready: true })` returns it, though `ready` lists should leave such items out. Without `setNeedsInfo`, triage still posts its comment and reports `marked: false`.

`get` returns text that agents read as requirements. Return plain markdown and a one-line title: Forge fences `get` itself, in the loader, so `from-ref`, `refresh-request` and triage all read the same text. It makes the title one line, removes hidden text, and writes the provenance line `Imported from <tracker.kind> item "<ref>". …` in column 0 with the body blockquoted under it. A body already in that fenced form (exactly the provenance line Forge writes for this item, optionally Forge's own `Hidden text:` sentence, then only empty or `>` lines, and no hidden text) is left alone; any other body is fenced whole, so a body that only looks fenced (another source, or free text in a column-0 line) or one shaped like the GitHub tracker's, with unquoted author lines, comes back quoted twice.

Refs must be 1 to 100 characters of letters, digits, `.`, `_` and `-`, starting with a letter or digit (Jira's `PROJ-123` fits). A ref ends up as a command-line argument, so the dashboard's Start button and `forge job link` refuse any other ref, and a qualified `group/sub/project#12` (two to five segments, then the number) is accepted too. Tracker calls receive only the refs the adapter owns: issues recorded under another tracker kind are kept on the job and ignored by sync.

`search` is optional. Forge re-ranks whatever it returns, and without it, it scores the first 200 items of `list({ limit: 200 })`, so a large tracker should implement it with the service's own search.

With the daemon (docs/CONFIG.md "Daemon"), the daemon session pins every file under `.forge/trackers/` and refuses symlinks there. Imports from outside that directory are not pinned, so keep the module self-contained.

A `.ts` adapter runs through Node's type stripping (Node ≥ 22.18), so use erasable syntax only: annotations, `type`/`interface` and `import type`, but no `enum`, `namespace` or parameter properties. Node loads it as an ES module when your repo's nearest `package.json` has no `type` field or `"type": "module"`. Under `"type": "commonjs"`, use `.mjs`. If both `<name>.mjs` and `<name>.ts` exist, Forge loads the `.mjs`.

`ctx` is `{ root, config }`; put adapter settings anywhere under `tracker.<name>` in the config. Map job state to your workflow with:
```js
import { statusKey } from '<plugin>/lib/api/tracker.ts'; // queued | in-progress | review | blocked | done | cancelled
```
(The old paths `lib/trackers/status.ts` and `lib/trackers/status.mjs` still re-export it for adapters written against older Forge. They are deprecated and go one minor release after the release that moved the contract.)
Keep credentials in the environment or the tool's own auth, never in the config file. Forge treats `update`/`comment` failures as non-fatal and logs them on the job.

**Writes are scanned for secrets.** Forge wraps every adapter, built-in or custom, so `comment` bodies and `create` titles and bodies go through the secret scanner first (docs/CONFIG.md "Secret scanning"): `forge tracker comment|create`, `forge job link --create`, `job human … --link new`, the split procedure and Forge's own mirrors all reach it. A likely credential is refused with error code `secret_found` (exit 1) and your adapter is never called. A custom adapter's `update` and `claim` receive the whole job, so the job's `title` and `reason` are scanned before them too; the built-in ones send only a status. Only a `sha256:` fingerprint in `.forge/secrets-allow.txt` allows tracker text, never a path glob.
