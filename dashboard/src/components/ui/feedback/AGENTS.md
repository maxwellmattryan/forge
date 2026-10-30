# dashboard/src/components/ui/feedback/

What a page or section shows in place of its content: the warning banner, the empty state, and the loading state with its skeleton bones.

- These know nothing of jobs, gates or sessions; `../../skeletons/` builds each page's loading shape from `Loading` and `Skeleton`.
- Design: [Working on the dashboard](../../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `Banner.svelte` | A warning banner: lost connection, newer API, missing config or a load error. |
| `Empty.svelte` | An empty state with the Forge mark. |
| `Loading.svelte` | A page or section still loading: <Skeleton> bones laid out in the shape of what will come, announced once to a screen reader as "Loading…" (or `label`). |
| `Skeleton.svelte` | One skeleton bone: a breathing bar the size of the text, chip or panel that will sit there once the data arrives. |
<!-- forge:map:end -->
