# lib/engine/ops/titles/

Titles: a job's first title from free text, the title schema PR titles and job names follow (titles.*), renaming jobs under it, and the convention a repo's merged PR titles already follow.

- Every title is checked here (`checkTitle`) before it names a job or reaches GitHub; a title that fails names nothing and is logged with its problem.
- Merged PR titles are other people's text: agents see them only quoted, through `forge pr titles`, never in a brief.
- A rename changes `job.title` only, never the id, slug or branch, and never an open PR's title.
- Design: [Titles](../../../../docs/CONFIG.md#titles), [Imported text](../../../../docs/architecture/untrusted-input/imported-text.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `check.ts` | The title schema: whether a PR title or job name follows titles.* (conventional commits, plain, or the repo's own pattern), the brief lines that carry it, and which convention merged PR titles already follow. |
| `derive.ts` | Short, deterministic job titles from free text (POST /api/jobs). |
| `history.ts` | The repo's PR title convention from its history: recent merged PR titles (`forge pr titles`), cached for a few hours, with the convention detectConvention reads in them, for the approver, init and doctor. |
| `rename.ts` | Renaming a job under the title schema (titles.job): from spec.md's heading at the spec gate, or to the approver's PR title. |
<!-- forge:map:end -->
