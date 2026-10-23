# lib/integrations/github/

GitHub through `gh`: the runner, pull requests, the GitHub tracker, issue previews and the actor.

- Every `gh` call goes through `gh.ts`, which gives it a timeout and parses its JSON.
- `pull-requests.ts` is the typed PR seam: the parsers that check every PR read once into a snapshot (`types.ts`), and the gh adapter (`createGhGitHub`, `ghGitHub`) behind the `GitHub` interface. Only `lib/cli/` passes the gh adapter; tests pass the in-memory one (`test/support/memory-github.ts`). When to adopt, open, rework, retarget or merge stays in `lib/engine/pr/`.
- Everything GitHub returns is untrusted text: it is fenced as data before an agent reads it, and the dashboard renders it as text.
- Read-only checks against real repos are fine while developing; anything that writes (PRs, labels, Project fields, comments, issues) goes only to a throwaway repo the maintainer approves.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `actor.ts` | Who did a human action. |
| `gh.ts` | The one place a gh process starts in lib/: every call has a timeout, so a hung gh (a stalled network, an auth prompt) can't block `pr sync` or a tracker call forever, and JSON it prints is parsed in one place. |
| `preview.ts` | Hover previews of github.com pages for the dashboard: a strict URL parse, one `gh api graphql` call per page, and a small folded shape. |
| `pull-requests.ts` | Pull requests on GitHub, behind the typed seam lib/engine/pr/ takes as a parameter: the parsers that check every PR read once into a snapshot, and the gh adapter that makes the calls. |
| `tracker.ts` | GitHub Issues tracker via the gh CLI. |
| `types.ts` | The typed GitHub seam for pull requests: the checked snapshots Forge reads and the edits it makes, behind one GitHub adapter that lib/engine/pr/ takes as a parameter. |
<!-- forge:map:end -->
