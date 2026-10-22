# lib/integrations/git/

The one git runner, with its config pins and clean environment, and the offline repo slug.

- Every git call goes through `runner.ts`, so no caller can forget the pins or the clean environment. Put `--` before revisions and paths, and validate any value from `gh` or job state before it reaches argv.
- `repo-slug.ts` never waits on `gh` or the network: issue refs read it on every job read.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `repo-slug.ts` | This repo's `owner/repo`, read offline: lib/core/job/issue-ref.ts needs it to tell this repo's issues from foreign ones on every job read and link, so it must never wait on `gh` or the network. |
| `runner.ts` | The one place a git process starts in lib/: every call gets the same config pins and a clean environment, so no caller can forget either. |
<!-- forge:map:end -->
