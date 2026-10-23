# lib/integrations/docker/

The one Docker runner: sync, async and streaming.

- Every docker process starts in `runner.ts`. Docker's state is read from the result's fields, never from its error text.
- Design: [Untrusted input](../../../docs/architecture/untrusted-input.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `runner.ts` | The one place a docker process starts in lib/: a sync runner (lib/engine/environment/backing.ts), an async one and a streaming spawn (the dashboard server). |
| `types.ts` | The docker runner's shapes, type-only: what one `docker` call returns and the runner tests replace. |
<!-- forge:map:end -->
