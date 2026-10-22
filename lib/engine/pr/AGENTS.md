# lib/engine/pr/

A job's pull requests: open, update, sync, merge and adopt them, and the human delta after Forge's last push.

- Never adopt a fork PR. PR text and review threads are untrusted: fence them as data before an agent reads them.
- `lifecycle.ts` is pinned in `test/invariants/file-size.test.ts`; #414 splits it into this folder and `lib/integrations/github/`.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `delta.ts` | The human delta: what people changed on a PR branch after Forge's last push. |
| `lifecycle.ts` | Pull requests: open, update, sync, merge and adopt a job's PRs through gh, across its repos. |
<!-- forge:map:end -->
