# lib/engine/environment/

A job's runtime environment: backing services, ports, endpoints, the dev server's state and config sinks.

- Backing services run through the Docker CLI (`lib/integrations/docker/runner.ts`); their validation lives in `lib/core/config/validators/` so config and the schema can import it without the job store.
- `ports.ts` gives each component its job ports, and `endpoints.ts` turns them into the placeholders and env a command sees.
- Design: [Untrusted input](../../../docs/architecture/untrusted-input.md), [Concurrency](../../../docs/architecture/concurrency.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `backing-db.ts` | Job databases (docs/CONFIG.md "Backing services"): a shared Postgres entry with `database` gives each job its own database and login role on the one server, cloned from a template database the project's migrate and seed commands build. |
| `backing-names.ts` | Backing services' Docker names: a container is `forge-<owner>-<name>` and its volumes add `-<i>`. |
| `backing-records.ts` | Backing services' validated entries and their port records: each job's `backing.json` and the project's shared one, read tolerantly (the session can write them), and the host ports they hold. |
| `backing.ts` | Backing services (docs/CONFIG.md "Backing services"): databases, caches and queues jobs run against, as a container per job, one per project, or an address run elsewhere, driven through the Docker CLI. |
| `config-sinks-apply.ts` | Renders a component's config sinks (lib/core/config/sinks.ts) into the job's worktree right before one of its commands runs: env vars for the command, env files and config files written at 0o600 through a temp file plus rename, and project scripts run with the values. |
| `endpoints.ts` | A job's endpoints: the address of each port-bearing component (lib/engine/environment/ports.ts) and the host port of each backing service (lib/engine/environment/backing.ts), as the `{endpoint.<c>}` / `{backing.<n>.*}` placeholders and the FORGE_PORT_<C> / FORGE_ENDPOINT_<C> variables configured commands get, as the briefs and the dashboard list them, and as the config sinks of #196 will read them. |
| `lifecycle.ts` | A job's environment (docs/CONFIG.md "Backing services" › Lifecycle): its per-job containers and volumes, its job databases on shared servers and its background processes. |
| `ports.ts` | Job ports: one stable port per port-bearing component (lib/engine/environment/endpoints.ts turns them into placeholders and env), chosen with the worktree under the same locks as backing ports: the machine's, then the project's, so two registered projects with one port range never hand out the same port. |
| `record.ts` | The environment record (docs/CONFIG.md "Backing services" › Lifecycle): what Forge last did to each job's environment, `running` or `stopped`, with when it was last used. |
| `status.ts` | A job's environment as the dashboard shows it (issue #199): its dev server's state and last log lines, its backing services, and every running environment in the checkout with its CPU and memory. |
| `types.ts` | The environment and backing-service records and results, type-only. |
<!-- forge:map:end -->
