# Glossary

These are the words Forge's docs, agent prompts and dashboard use for projects with several repos, components, backing services, environments and releases. Terms marked planned describe work in the named milestone and have no config key yet.

## The project model

Planned in M004, except where a config key exists today.

| Term | Meaning | Config key |
|---|---|---|
| **project** | One or more repos Forge works on together, configured from the root repo's `.forge/`, with no global state outside those repos (today's block describes a project of one repo). | `project` |
| **root repo** | The repo that holds the project's `.forge/`, which for a project of one repo is that repo and is never listed in `repos`. | `repos` |
| **member repo** | Any other repo the root repo's config lists as part of the project. | `repos` |
| **component** | A buildable unit inside a repo, of kind `library`, `service` or `app`. | planned (M004) |
| **dependency** | An edge from one component to another, `build` when it is needed to compile or bundle and `runtime` when it must be running. | planned (M004) |
| **project graph** | The components of all of a project's repos and the dependencies between them, drawn by the dashboard's project view. | `components` |
| **focus** | The job whose environment you are currently pointed at, set with `forge focus` or the dashboard, where switching focus starts or stops no server and runs the checkout steps. | - |
| **checkout step** | A configured action that makes a fixed path or tool follow the focused job: a `link` from a fixed path to the job's build, or a `run` of a configured command with an optional `undo`, undone when focus moves away. | `checkout` |
| **issue ref** | A tracker's reference to one issue (`owner/repo#12` for GitHub, a local backlog title slug, or a custom adapter's own `KEY-123`), kept in a job's `issues` list in job.json, where the first is the primary issue and one issue may sit on several jobs. | - |

## Multi-repo jobs

Planned in M005, except where a config key exists today.

| Term | Meaning | Config key |
|---|---|---|
| **job repo** | A repo the job changes, the root repo first and then each member repo a human adds with `forge job repo add`, so it gets its own worktree, verify evidence, branch and PR. | - |
| **repo proposal** | A planner's or spec-writer's request, made with `forge job repo propose`, to add a member repo to its job, which parks the job until a human (or the foreman, when `repo-proposal` is in `foreman.decides`) approves or rejects it. | `foreman.decides` |
| **verify-only repo** | A job repo added with `--verify-only`, which the job checks out at its base to build and test against its changes without branching, pushing or opening a PR there. | - |
| **downstream repo** | A verify-only repo Forge adds to a job because it consumes, through a declared link, a repo the job changes, so verify runs its tests against the job's changes and names it when they break. | `downstream` |
| **checkout hook** | A command run once when a job's checkout of a repo is created (today's single-repo form; per-repo hooks are planned). | `worktrees.setup` |
| **local link** | Wiring one job repo to build against a sibling job repo's checkout instead of a published version, declared as `link` on a `components[].dependsOn[]` edge and applied by `forge run` and `forge verify`. | `components` |
| **interim reference** | What a consumer job repo points at for a dependency changed in the same job until that dependency is released: a `git-ref` pin, a `canary` version, or nothing (`local`, `sequential`); see [CONFIG.md "Interim strategies"](CONFIG.md#interim-strategies). | - |
| **interim strategy** | How an interim reference is made, one of `canary` (a published pre-release), `git-ref` (a pinned commit), `local` (local links, with the consumer PR held as a draft) or `sequential` (merge the dependency first), per dependency and overridable per job with `forge job repo interim`. | `release.interim` |

## Releases

The release strategy keys are in config today (see [CONFIG.md "Release strategy"](CONFIG.md#release-strategy)); the commands that act on them are planned in M006.

| Term | Meaning | Config key |
|---|---|---|
| **release** | Publishing new versions of one or more components, the one word for single-repo and multi-repo releases alike. | planned (M006) |
| **release strategy** | How one repo releases, declared per repo: its versioning (`semver` or `calver`), release mechanism, registry (`crates.io`, `npm` or `none`), release cadence and interim strategy. | `release` |
| **release mechanism** | The tool that cuts a repo's release, one of `release-please`, `cargo-release`, `changesets` or `tag` (a git tag made by the repo's own `release.command`), which `forge doctor` checks is installed. | `release.mechanism` |
| **release cadence** | When a repo releases, one of `on-merge` (every merge to the default branch), `scheduled` (on a timer, usually in CI) or `manual` (when a human decides). | `release.cadence` |
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
