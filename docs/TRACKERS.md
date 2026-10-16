# Trackers

Forge talks to issue trackers through a small synchronous contract. Built-ins:

| `tracker.kind` | Backed by | Notes |
|---|---|---|
| `local` | `.forge/backlog.md` | zero setup; `[ ]` ready, `[~]` claimed (→ job id), `[x]` done, `[-]` dropped, `[?]` needs info (with Forge's indented `Needs info: …` line, never part of the body); refs are title slugs |
| `github` | GitHub Issues via `gh` | assignment on claim, optional status mirroring (labels and/or a GitHub Projects field), the `forge:needs-info` label from [readiness triage](#readiness-triage) whatever `statusSync` says, `Closes #n` on PRs |
| `none` | nothing | free-text jobs only |

The GitHub tracker imports an issue as a provenance line, then the body and each kept comment as Markdown blockquotes (every line starts with `>`, and a lone CR, U+2028, U+2029 or NEL starts a new quoted line), with each comment under a `**@login** (association):` line that only Forge writes, so a heading or rule forged in the body can't pass for Forge's own `### Recent comments` section; the title is collapsed to one line.

## GitHub status mirroring

`tracker.github.statusSync` is independent of everything else:

- `none`: only assignment and comments.
- `labels`: one `forge:<status>` label at a time (prefix configurable). Labels are created on first use.
- `project`: sets a single-select field (default `Status`) on the issue's GitHub Projects (v2) item, adding the issue to the project if needed. Coordinates come from `tracker.github.project` or, when present, the repo's project config file (default `.github/project-config.yml`, with `project.owner`, `project.number` and `fields.status`). Forge statuses map to options through `statusMap`, or are matched by meaning, so `🏗 In Progress` or `🔎 In Review` need no configuration. Requires a token with the `project` scope (`gh auth refresh -s project`).
- `both`.

`ready.projectStatus` limits `/forge next` to items in a given column (e.g. `🔖 Todo`).

## Linking jobs to issues

With a tracker in use, every job maps to one issue and one PR. A job started from an issue (`/forge issue <ref>`, `/forge next`, a dashboard Start) is linked when it is created. Any other job, including `/forge <free text>` from the CLI or the dashboard, gets its issue chosen at the spec gate, so it needs one human visit before build. At Intake, `forge job link <id> --suggest` searches the tracker with words from the job's title and writes the best matches to `issue-candidates.md` (fenced as untrusted data) and `issue-candidates.json` in the job dir, without waiting. The spec gate (reason `spec ready, issue unlinked`) then shows the spec and the candidates, and one answer approves the spec and links the issue:

- `/forge approve <id> <ref>` links an existing issue (`forge job human <id> approve-spec --link <ref>`): it checks the item exists and no other active job holds it, claims it like `/forge issue` would, and records it as the job's `source`.
- `/forge approve <id> new` creates an issue from the job's title and `request.md`, then links it (`--link new`).
- `/forge approve <id> none [reason]` records that this job needs no issue (`--link none --reason "…"`), so `forge pr open` stops flagging it.

The builder never starts on an unlinked job. A spec approved without a link, or a job no spec gate stops (`pipeline.specApproval: never`, or `large` with an S or M spec), waits on `issue-link` in the spec stage before build, and the same three answers resolve it (`forge job human <id> approve --link <ref>|new|none`). `forge job link <id> <ref> | --create | --none [--reason R]` is the direct command for any of them, at any time.

Jobs that never ask: `tracker.kind: none`, eval and retro jobs, and split children (each gets its own issue when it is created: a sub-issue of the parent's, or a top-level one when the parent has none). `forge pr open` adds `unlinked: true` to its result for a job that still has no issue and no override. There is no repo-wide switch: `tracker.kind: none` and the per-job override cover it.

`forge tracker search <query> [--limit n] [--job <id>]` is the bounded search behind it: at most `--limit` (default 5, at most 20) open items, ranked by how many search words appear in each title (2 points) and body (1 point), printed without bodies. Only plain words reach the tracker: tokens with search syntax (`is:`, `repo:`, `label:`, quotes, parentheses, `-` negation) are dropped, and GitHub results outside the configured repo are discarded.

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

`get` returns text that agents read as requirements, so fence it the way the GitHub tracker does: start the body with a line saying where it came from and that it is data, not instructions, blockquote the description and every comment line by line, write each comment's author on its own unquoted line, and keep the title to one line.

Refs must be 1 to 100 characters of letters, digits, `.`, `_` and `-`, starting with a letter or digit (Jira's `PROJ-123` fits). A ref ends up as a command-line argument, so the dashboard's Start button and `forge job link` refuse any other ref, and a ref like `group/repo#12` must be mapped to that shape by the adapter.

`search` is optional. Forge re-ranks whatever it returns, and without it, it scores the first 200 items of `list({ limit: 200 })`, so a large tracker should implement it with the service's own search.

With the daemon (docs/CONFIG.md "Daemon"), the daemon session pins every file under `.forge/trackers/` and refuses symlinks there. Imports from outside that directory are not pinned, so keep the module self-contained.

A `.ts` adapter runs through Node's type stripping (Node ≥ 22.18), so use erasable syntax only: annotations, `type`/`interface` and `import type`, but no `enum`, `namespace` or parameter properties. Node loads it as an ES module when your repo's nearest `package.json` has no `type` field or `"type": "module"`. Under `"type": "commonjs"`, use `.mjs`. If both `<name>.mjs` and `<name>.ts` exist, Forge loads the `.mjs`.

`ctx` is `{ root, config }`; put adapter settings anywhere under `tracker.<name>` in the config. Map job state to your workflow with:
```js
import { statusKey } from '<plugin>/lib/trackers/status.ts'; // queued | in-progress | review | blocked | done | cancelled
```
(`status.mjs` still re-exports it for adapters written against older Forge.)
Keep credentials in the environment or the tool's own auth, never in the config file. Forge treats `update`/`comment` failures as non-fatal and logs them on the job.

**Writes are scanned for secrets.** Forge wraps every adapter, built-in or custom, so `comment` bodies and `create` titles and bodies go through the secret scanner first (docs/CONFIG.md "Secret scanning"): `forge tracker comment|create`, `forge job link --create`, `job human … --link new`, the split procedure and Forge's own mirrors all reach it. A likely credential is refused with error code `secret_found` (exit 1) and your adapter is never called. A custom adapter's `update` and `claim` receive the whole job, so the job's `title` and `reason` are scanned before them too; the built-in ones send only a status. Only a `sha256:` fingerprint in `.forge/secrets-allow.txt` allows tracker text, never a path glob.
