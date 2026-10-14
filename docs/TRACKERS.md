# Trackers

Forge talks to issue trackers through a small synchronous contract. Built-ins:

| `tracker.kind` | Backed by | Notes |
|---|---|---|
| `local` | `.forge/backlog.md` | zero setup; `[ ]` ready, `[~]` claimed (→ job id), `[x]` done, `[-]` dropped; refs are title slugs |
| `github` | GitHub Issues via `gh` | assignment on claim, optional status mirroring (labels and/or a GitHub Projects field), `Closes #n` on PRs |
| `none` | nothing | free-text jobs only |

## GitHub status mirroring

`tracker.github.statusSync` is independent of everything else:

- `none`: only assignment and comments.
- `labels`: one `forge:<status>` label at a time (prefix configurable). Labels are created on first use.
- `project`: sets a single-select field (default `Status`) on the issue's GitHub Projects (v2) item, adding the issue to the project if needed. Coordinates come from `tracker.github.project` or, when present, the repo's project config file (default `.github/project-config.yml`, with `project.owner`, `project.number` and `fields.status`). Forge statuses map to options through `statusMap`, or are matched by meaning, so `🏗 In Progress` or `🔎 In Review` need no configuration. Requires a token with the `project` scope (`gh auth refresh -s project`).
- `both`.

`ready.projectStatus` limits `/forge next` to items in a given column (e.g. `🔖 Todo`).

## Linking jobs to issues

With a tracker in use, every job maps to one issue and one PR. A job started from an issue (`/forge issue <ref>`, `/forge next`, a dashboard Start) is linked when it is created. Any other job, including `/forge <free text>` from the CLI or the dashboard, passes an issue gate at Intake: `forge job link <id> --suggest` searches the tracker with words from the job's title, writes the best matches to `issue-candidates.md` (fenced as untrusted data) and `issue-candidates.json` in the job dir, and the job waits on `issue-link` until you answer:

- `/forge approve <id> <ref>` links an existing issue (`forge job link <id> <ref>`): it checks the item exists and no other active job holds it, claims it like `/forge issue` would, and records it as the job's `source`.
- `/forge approve <id> new` creates an issue from the job's title and `request.md`, then links it (`forge job link <id> --create`).
- `/forge approve <id> none [reason]` records that this job needs no issue (`forge job link <id> --none --reason "…"`), so `forge pr open` stops flagging it.

Jobs that never ask: `tracker.kind: none`, eval and retro jobs, and split children (they get the parent's sub-issue when they are created). `forge pr open` adds `unlinked: true` to its result for a job that still has no issue and no override. There is no repo-wide switch: `tracker.kind: none` and the per-job override cover it.

`forge tracker search <query> [--limit n] [--job <id>]` is the bounded search behind it: at most `--limit` (default 5, at most 20) open items, ranked by how many search words appear in each title (2 points) and body (1 point), printed without bodies.

## Writing an adapter (Jira, Linear, GitLab, …)

Create `.forge/trackers/<name>.mjs` (or `<name>.ts`) and set `tracker.kind: <name>`. Default-export an object with these **synchronous** methods (shell out with `child_process.spawnSync` to a CLI, or `curl`, if the service has no sync SDK):

```js
export default {
  name: 'jira',
  list(ctx, { ready, limit }) { return [/* { ref, title, url, labels, status, priority, assignees, claimedBy } */]; },
  get(ctx, ref) { return { ref, title, url, body /* markdown: description + recent comments */ }; },
  claim(ctx, ref, job) { return { ok: true } /* or { ok: false, reason } if someone else has it */; },
  update(ctx, ref, job) { /* mirror statusKey(job) → your workflow */ },
  comment(ctx, ref, body) {},
  create(ctx, { title, body, labels, parentRef }) { return { ref, url }; },
  close(ctx, ref, { reason }) {},
  // Optional: open items matching a free-text query, bodies included, at most `limit` of them.
  search(ctx, query, { limit }) { return [/* { ref, title, url, labels, body } */]; },
};
```

`search` is optional. Forge re-ranks whatever it returns, and without it, it scores the first 200 items of `list({ limit: 200 })`, so a large tracker should implement it with the service's own search.

With the daemon (docs/CONFIG.md "Daemon"), the daemon session pins every file under `.forge/trackers/` and refuses symlinks there. Imports from outside that directory are not pinned, so keep the module self-contained.

A `.ts` adapter runs through Node's type stripping (Node ≥ 22.18), so use erasable syntax only: annotations, `type`/`interface` and `import type`, but no `enum`, `namespace` or parameter properties. Node loads it as an ES module when your repo's nearest `package.json` has no `type` field or `"type": "module"`. Under `"type": "commonjs"`, use `.mjs`. If both `<name>.mjs` and `<name>.ts` exist, Forge loads the `.mjs`.

`ctx` is `{ root, config }`; put adapter settings anywhere under `tracker.<name>` in the config. Map job state to your workflow with:
```js
import { statusKey } from '<plugin>/lib/trackers/status.ts'; // queued | in-progress | review | blocked | done | cancelled
```
(`status.mjs` still re-exports it for adapters written against older Forge.)
Keep credentials in the environment or the tool's own auth, never in the config file. Forge treats `update`/`comment` failures as non-fatal and logs them on the job.
