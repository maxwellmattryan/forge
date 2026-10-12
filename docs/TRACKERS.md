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

## Writing an adapter (Jira, Linear, GitLab, …)

Create `.forge/trackers/<name>.mjs` and set `tracker.kind: <name>`. Default-export an object with these **synchronous** methods (shell out with `child_process.spawnSync` to a CLI, or `curl`, if the service has no sync SDK):

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
};
```
`ctx` is `{ root, config }`; put adapter settings anywhere under `tracker.<name>` in the config. Map job state to your workflow with:
```js
import { statusKey } from '<plugin>/lib/trackers/status.mjs'; // queued | in-progress | review | blocked | done | cancelled
```
Keep credentials in the environment or the tool's own auth, never in the config file. Forge treats `update`/`comment` failures as non-fatal and logs them on the job.
