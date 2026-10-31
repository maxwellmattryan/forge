# dashboard/src/lib/jobs/

A job as the board and the drawer show it: its state, card and table, dependencies, the drawer, effort, repos, screenshots, protected paths and its Thread.

- `job.json` can be hand-edited, so these read its fields defensively despite the types, and its text renders as text.
- `effort.ts` mirrors `resolveEffort` in `lib/core/config/models.ts`, and `deps.ts` mirrors `lib/engine/pipeline/deps.ts`, because the dashboard can't import `lib/`: change both sides together.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `board.ts` | The Pipeline page's board and table: filters, counts, columns, urgency order and each card's slots. |
| `deps.ts` | Dependency links between jobs (`dependsOn`), derived from /api/state jobs. |
| `drawer.ts` | The job drawer: its tabs and width with their keyboard rules, the file it shows, timeline lines and the verdict matrix, as plain functions node:test can pin. |
| `effort.ts` | Reasoning effort as the dashboard shows it. |
| `overlap.ts` | The drawer's Overlaps with card: the job's last `forge overlap` report (GET /api/jobs/:id `overlap`) as rows. |
| `protected.ts` | The protected-paths flag as the board, the drawer and the Needs-you card show it. |
| `repos.ts` | The drawer's Repos table and the card's member PR chips, for a job with member repos (job.repos: the root repo first, then members). |
| `screenshots.ts` | The drawer's Screenshots card: UI evidence that agents saved to the job's screenshots/ dir. |
| `state.ts` | A job's state as the dashboard reads it: tones, chip text, waits that need a human, the drawer's Resume. |
| `thread-progress.ts` | The Thread's progress lines: the job's events that a person follows (a stage change, a parked gate, an agent's closing line, checks, reviews, the decision, the PR) as compact lines between the requests, so the Thread tells the job's story without the Log's detail. |
| `thread.ts` | A job's Thread in the drawer: its requests as a conversation, the secret scanner's notes, and the issue-link gate's candidates. |
| `typing.ts` | The Thread's typing: a message, or a reply, that arrives while the drawer is open types out behind a caret, as if its sender wrote it there. |
<!-- forge:map:end -->
