# Glossary

These are the words Forge's docs, agent prompts and dashboard use for projects with several repos, components, backing services, environments and releases. Terms marked planned describe work in the named milestone and have no config key yet.

## The project model

Planned in M004, except where a config key exists today.

| Term | Meaning | Config key |
|---|---|---|
| **project** | One or more repos Forge works on together, configured from the root repo's `.forge/`, with no global state outside those repos (today's block describes a project of one repo). | `project` |
| **root repo** | The repo that holds the project's `.forge/`, which for a project of one repo is that repo. | planned (M004) |
| **member repo** | Any other repo the root repo's config lists as part of the project. | planned (M004) |
| **component** | A buildable unit inside a repo, of kind `library`, `service` or `app`. | planned (M004) |
| **dependency** | An edge from one component to another, `build` when it is needed to compile or bundle and `runtime` when it must be running. | planned (M004) |
| **project graph** | The components of all of a project's repos and the dependencies between them. | planned (M004) |
| **focus** | The job whose environment you are currently pointed at, set with `forge focus` or the dashboard, where switching focus starts or stops nothing. | - |
| **issue ref** | A tracker's reference to one issue (a GitHub number or a local backlog title slug), stored as `source.ref` in job.json. | - |

## Multi-repo jobs

Planned in M005, except where a config key exists today.

| Term | Meaning | Config key |
|---|---|---|
| **job repo** | A repo the job changes, so it gets a branch, a worktree and a PR. | planned (M005) |
| **verify-only repo** | A repo the job checks out to build and test against its changes without changing it. | planned (M005) |
| **checkout hook** | A command run once when a job's checkout of a repo is created (today's single-repo form; per-repo hooks are planned). | `worktrees.setup` |
| **local link** | Wiring one job repo to build against a sibling job repo's checkout instead of a published version. | planned (M005) |
| **interim reference** | What a consumer job repo points at for a dependency changed in the same job until that dependency is released. | planned (M005) |
| **interim strategy** | How an interim reference is made, one of `canary` (a published pre-release), `git-ref` (a pinned commit), `local` (local links, with the consumer PR held as a draft until release) or `sequential` (release the dependency first). | planned (M005) |

## Releases

Planned in M006.

| Term | Meaning | Config key |
|---|---|---|
| **release** | Publishing new versions of one or more components, the one word for single-repo and multi-repo releases alike. | planned (M006) |
| **release strategy** | A project's policy for how and when its components release (coordinated or independent, and the cadence) and which interim strategy each dependency uses. | planned (M006) |
| **release plan** | The ordered components, versions and steps for one release, which a human can run from the CLI without the Foreman. | planned (M006) |
| **release gate** | A check that blocks merging a PR while it still uses an interim reference. | planned (M006) |

## Environments

Planned in M007.

| Term | Meaning | Config key |
|---|---|---|
| **environment** | The running components and backing services one job uses, each at its own endpoints (today a job's environment is its worktree plus its `port`). | planned (M007) |
| **endpoint** | An address (URL or host and port) where an environment serves one component or backing service. | planned (M007) |
| **backing service** | Infrastructure a component needs while it runs, such as a database, cache or queue. | planned (M007) |
| **isolation** | How a backing service is provided to jobs: `per-job` (its own container per job), `shared` (one instance every job uses) or `external` (run outside Forge, which only points at it). | planned (M007) |
| **config sink** | Where Forge writes a component's configuration for an environment (a `.env` file, a JSON config file, environment variables), chosen per component and never assumed. | planned (M007) |
| **secret reference** | A pointer to a secret held elsewhere (an environment variable name, a keychain entry, a secret manager path) that Forge resolves at run time and never writes into job files, prompts or logs. | planned (M007) |

## Profiles

Planned in M008.

| Term | Meaning | Config key |
|---|---|---|
| **profile** | A named subset of a project's components and backing services, so a job runs only what it needs. | planned (M008) |

## Collisions we avoid

Some of these words already mean something in Forge. They keep those meanings:

- `resources` stays the reference links agents should know about, and `infra.mode` stays the policy for cloud and infrastructure commands. That is why runtime infrastructure is a "backing service", never a "resource" or "infra".
- "GitHub Project" always carries the prefix (`tracker.github.project`, `statusSync: project`). Bare "project" means the glossary's project.
- The top-level `project:` block (name, description, kinds, instructions, notes) today describes the root repo of a one-repo project.
- `services:` today lists a monorepo's sub-paths with their own commands. It keeps its name, and a component of kind `service` is not a `services:` entry.
- "Model profiles" in [CONFIG.md](CONFIG.md) are `runtime.models` presets from `/forge init`. "Profile" alone means the glossary's profile.
- A job's `dependsOn` is a job dependency. "Dependency" alone means a component edge.
- "Environment" alone never means environment variables (say "environment variables"), and "focus" never means a test's focus marker or keyboard focus.

## Existing terms

The new words build on these, which exist today.

| Term | Meaning | Config key |
|---|---|---|
| **job** | One unit of work that Forge takes from request to PR, in its own worktree. | - |
| **Foreman** | The office session that decides gates for jobs under `foreman.decides`. | `foreman.decides` |
