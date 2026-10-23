# lib/core/config/

`.forge/config.yml`: loading over the defaults, validation, and the one write path.

- `load.ts` loads config.yml over `defaults()` (`keys/defaults.ts`) and re-exports the split files, so its many importers keep one import.
- `keys/` holds each key's default (`defaults.ts`), its doc string (`docs.ts`) and the renderer that writes docs/CONFIG.md's reference block from both (`reference.ts`, `npm run docs`). A new key gets a default and a doc string; only `scripts/` and tests import `docs.ts` and `reference.ts`, so the CLI never loads them.
- `validate.ts` holds `validateConfig` and the sections with no file of their own. The validators in `validators/` sit apart because the job store imports `load.ts`: a section's validation that reached the job store (or a module that imports it) would close an import cycle.
- `fields.ts` is the settings allowlist the dashboard shows, and `set.ts` the one write path `forge config set` and `/api/config` share. A new config key gets a `fields.ts` entry if the dashboard should show it; `test/invariants/generated-docs.test.ts` checks every entry against `defaults()` and the doc strings in `keys/docs.ts`.
- Design: [Data and versioning](../../../docs/architecture/versioning.md), [Daemon security](../../../docs/architecture/daemon-security.md), [Foreman](../../../docs/architecture/foreman.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `components.ts` | Components: the parts of a repo (`config.components`), what kind each is and what it depends on. |
| `fields.ts` | The settings schema: which config keys `forge config set` and POST /api/config may write, and how each one is parsed, validated and shown in the dashboard. |
| `keys/defaults.ts` | Every config key Forge reads, with its default: what loadConfig merges a repo's config.yml over. |
| `keys/docs.ts` | Every config key's doc string: the comment docs/CONFIG.md's reference block shows beside its default (npm run docs:config). |
| `keys/reference.ts` | docs/CONFIG.md's per-key reference: defaults() rendered as commented YAML from the doc strings in docs.ts, and the sync npm run docs:config writes. |
| `load.ts` | Loading `.forge/config.yml` over the defaults, and the small readers of a loaded config. |
| `models.ts` | runtime.model* and runtime.effort*: their validation, and the one place each resolves for a spawn (resolveModel, resolveEffort). |
| `release-strategy.ts` | A repo's release strategy (docs/CONFIG.md "Release strategy"): how it versions, which tool cuts a release, where it publishes and how often. |
| `set.ts` | `forge config set` and POST /api/config: the one write path for a single config key. |
| `sinks.ts` | Config sinks (docs/CONFIG.md "Config sinks"): `components[].config` lists where a component takes its configuration (env vars, an env file, a JSON/YAML/TOML file, a project script), and Forge renders them with the job's values before each of that component's commands. |
| `trust.ts` | What a daemon session may run: daemon.* validation (the command, its flags and allowedTools) and the trust digest that pins the files deciding what `forge` executes from the main checkout. |
| `types.ts` | The effective config and its sections' shapes, type-only: re-exported by lib/core/types.ts; unions with a runtime list derive from it. |
| `validate.ts` | validateConfig, and the validators for the config sections that have no file of their own. |
| `validators/backing.ts` | backing: validation, apart from lib/engine/environment/backing.ts so lib/core/config/validate.ts and lib/core/job/schema.ts can import it without pulling in the job store (which imports config/load.ts). |
| `validators/checkout.ts` | checkout: validation, apart from lib/engine/workspace/checkout.ts so lib/core/config/validate.ts can import it without pulling in the job store (which imports config/load.ts). |
| `validators/deprecations.ts` | Config keys on their way out (docs/RELEASES.md "Deprecation"). |
| `validators/endpoints.ts` | The config-time half of lib/engine/environment/endpoints.ts: the env name of a component and the problems with the `{endpoint.<c>}` / `{backing.<n>.*}` placeholders a config's templates use. |
| `validators/notify.ts` | notify.* validation, apart from lib/office/notify.ts so lib/core/config/validate.ts can import it without pulling in the delivery code (which imports lib/core/job/store.ts, which imports lib/core/config/load.ts). |
| `validators/policy-check.ts` | Config-time validation of the glob lists and the protected-paths policy, and the matcher that applies it. |
| `validators/secret-refs.ts` | secrets: validation, apart from lib/engine/guard/secret-refs.ts so lib/core/config/validate.ts can import it without pulling in processes or git. |
<!-- forge:map:end -->
