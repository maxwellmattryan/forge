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
| **port-bearing component** | A `service` or `app` component, which holds one job port (`ports` in `job.json`, `{endpoint.<component>}` in commands); a `library` holds none. | `components`, `ports` |
| **dependency** | An edge from one component to another, `build` when it is needed to compile or bundle and `runtime` when it must be running. | planned (M004) |
| **project graph** | The components of all of a project's repos and the dependencies between them, drawn by the dashboard's project view. | `components` |
| **focus** | The job whose environment you are currently pointed at, set with `forge focus` or the dashboard, where switching focus runs the checkout steps and starts the job's stopped backing services, but starts or stops no dev server. | - |
| **checkout step** | A configured action that makes a fixed path or tool follow the focused job: a `link` from a fixed path to the job's build, or a `run` of a configured command with an optional `undo`, undone when focus moves away. | `checkout` |
| **issue ref** | A tracker's reference to one issue (`owner/repo#12` for GitHub, a local backlog title slug, or a custom adapter's own `KEY-123`), kept in a job's `issues` list in job.json, where the first is the primary issue and one issue may sit on several jobs. | - |

## Multi-repo jobs

Planned in M005, except where a config key exists today.

| Term | Meaning | Config key |
|---|---|---|
| **job repo** | A repo the job changes, the root repo first and then each member repo a human adds with `forge job repo add`, so it gets its own worktree, verify evidence, branch and PR. | - |
| **repo proposal** | A planner's or spec-writer's request, made with `forge job repo propose`, to add a member repo to its job, which parks the job until a human (or the foreman, when `repo-proposal` is in `foreman.decides`) approves or rejects it. | `foreman.decides` |
| **verify record** | A job's verify runs, one per `forge verify` attempt (and per verifiers CHANGES), each bound to the commit it checked; this round's last run is the job's latest verify, and a HEAD is verified only when that run passed on it and on every member HEAD. Only `lib/engine/verify/record.ts` reads it. | - |
| **verify-only repo** | A job repo added with `--verify-only`, which the job checks out at its base to build and test against its changes without branching, pushing or opening a PR there. | - |
| **downstream repo** | A verify-only repo Forge adds to a job because it consumes, through a declared link, a repo the job changes, so verify runs its tests against the job's changes and names it when they break. | `downstream` |
| **checkout hook** | A command run once when a job's checkout of a repo is created (today's single-repo form; per-repo hooks are planned). | `worktrees.setup` |
| **local link** | Wiring one job repo to build against a sibling job repo's checkout instead of a published version, declared as `link` on a `components[].dependsOn[]` edge and applied by `forge run` and `forge verify`. | `components` |
| **interim reference** | What a consumer job repo points at for a dependency changed in the same job until that dependency is released: a `git-ref` pin, a `canary` version, or nothing (`local`, `sequential`); see [CONFIG.md "Interim strategies"](CONFIG.md#interim-strategies). | - |
| **interim strategy** | How an interim reference is made, one of `canary` (a published pre-release), `git-ref` (a pinned commit), `local` (local links, with the consumer PR held as a draft) or `sequential` (merge the dependency first), per dependency and overridable per job with `forge job repo interim`. | `release.interim` |

## Releases

The release strategy keys are in config (see [CONFIG.md "Release strategy"](CONFIG.md#release-strategy)), and `forge release plan|run|status` acts on them (see [RELEASES.md "Releasing a project"](RELEASES.md#releasing-a-project)).

| Term | Meaning | Config key |
|---|---|---|
| **release** | Publishing new versions of one or more components, the one word for single-repo and multi-repo releases alike. | - |
| **release strategy** | How one repo releases, declared per repo: its versioning (`semver` or `calver`), release mechanism, registry (`crates.io`, `npm` or `none`), release cadence and interim strategy. | `release` |
| **release mechanism** | The tool that cuts a repo's release, one of `release-please`, `cargo-release`, `changesets` or `tag` (a git tag made by the repo's own `release.command`), which `forge doctor` checks is installed. | `release.mechanism` |
| **release cadence** | When a repo releases, one of `on-merge` (every merge to the default branch), `scheduled` (on a timer, usually in CI) or `manual` (when a human decides). | `release.cadence` |
| **release plan** | The ordered repos, steps, checks and rollback for one release that `forge release plan` writes and a human runs with `forge release run`, without the Foreman. | - |
| **release gate** | What keeps a consumer PR from merging while it still uses an interim reference: the seeded `release gate` CI check for `git-ref` and `canary`, and Forge's own gate per edge (`held`, `bump-due`, `released`; `forge job interim <id>`), which `forge pr ready` and `forge pr merge` enforce; see [CONFIG.md "Interim strategies"](CONFIG.md#interim-strategies). | - |
| **main update** | Forge's own repo only: the commit `npm run release` pushes to `main` to release a version, develop's tree plus the `dashboard/dist/` that `.github/workflows/main-update.yml` built in CI, with parents `[main, develop]`; see [RELEASES.md "Releasing"](RELEASES.md#releasing). | - |
| **release bump** | What `forge verify` commits once a dependency's release is recorded: the consumer's manifests, and a tracked lockfile, moved from the interim reference to the released version (`forge: release bump for job <id>`). | - |

## Environments

Planned in M007; a row with a config key is implemented.

| Term | Meaning | Config key |
|---|---|---|
| **environment** | The running components and backing services one job uses, each at its own endpoints: its per-job containers and volumes, its job databases and its background processes, beside its worktree and `ports`, shown for one job in its panel's Environment card and for every running one in the dashboard's Running environments section, and which Forge starts on demand, stops while the job is parked and tears down when the job finishes (`forge environment`). | `backing`, `environments.maxRunning` |
| **endpoint** | An address (URL or host and port) where an environment serves one component or backing service: `{endpoint.<component>}` and `{backing.<name>.port}` in commands, the `Endpoints:` brief line and the Environment card. | `components`, `backing` |
| **backing service** | Infrastructure a component needs while it runs, such as a database, cache or queue. | `backing` |
| **isolation** | How a backing service is provided to jobs: `per-job` (its own container per job), `shared` (one instance every job uses) or `external` (run outside Forge, which only points at it). | `backing` |
| **job database** | One job's own database and login role on a shared Postgres backing service, cloned from a template database and dropped when the job's worktree is removed. | `backing[].database` |
| **template database** | The database a shared Postgres backing service's migrate and seed commands build once per template hash, which every job database is cloned from. | `backing[].database` |
| **config sink** | Where Forge writes a component's configuration for an environment (environment variables, a `.env` file, a JSON, YAML or TOML file, or a project script), chosen per component and never assumed. | `components[].config` |
| **secret reference** | A named pointer to a secret held elsewhere (an environment variable, a keychain entry, a 1Password item, a git-ignored file) that a config sink names as `{secret.NAME}` and Forge resolves only when the sink renders, never writing it into job files, briefs or logs. | `secrets` |
| **known value** | A secret value a job's sinks have resolved, or one of its job database passwords: Forge replaces it with `[redacted]` wherever it writes or serves text, and the secret scanner refuses to publish it. | `secrets` |

## Profiles

Planned in M008.

| Term | Meaning | Config key |
|---|---|---|
| **profile** | A named subset of a project's components and backing services, so a job runs only what it needs. | planned (M008) |

## Code layout

Words for Forge's own code, decided in #303 ([design/lib-layout.md](design/lib-layout.md)).

| Term | Meaning | Config key |
|---|---|---|
| **lib layer** | One of the seven top-level folders of `lib/` (`api`, `core`, `integrations`, `engine`, `office`, `server`, `cli`), lowest first; a layer imports only layers below it ([design/lib-layout.md](design/lib-layout.md)). | - |
| **office** | Forge's long-running runtime, which `forge dash` keeps up: the session pool (the inbox session, per-job sessions and the office session where the Foreman decides gates), the reconciler and notifications; its code lives in `lib/office/`. | - |
| **integrations** | The code that knows an outside system's API, CLI or file format (git, GitHub, Claude Code, Docker, webhooks, and the built-in backlog that implements the same contract), one folder per system in `lib/integrations/`; it holds mechanism, never pipeline policy. | - |
| **lib module** | A folder inside a lib layer (`lib/<layer>/<module>/`) that holds one concept's files, such as `lib/core/job/` or `lib/engine/pipeline/`. | - |
| **layer alias** | A `package.json` subpath import (`#api/`, `#core/`, `#integrations/`, `#engine/`, `#office/`) that names a lib layer; imports across layers use one, imports inside a layer stay relative. | - |
| **touchpoint rule** | A row of the rule table in `scripts/check-touchpoints.ts`: a change a diff can recognise and the companion change it needs, which `npm run check:touchpoints` reports as missing with the fix; companions only a person can judge stay in AGENTS.md › Where a change goes. | - |
| **folder map** | A folder's `AGENTS.md`: a few hand-written lines, then the table that `npm run docs:map` generates from each file's header comment. | - |
| **GitHub adapter** | The one interface (`GitHub`, in `lib/integrations/github/types.ts`) that `lib/engine/pr/` takes as a parameter for every pull request read and edit: the gh adapter (`ghGitHub`) in production, which `lib/cli/` passes, and `memoryGitHub` in tests, so PR policy code never runs `gh` itself. | - |
| **PR snapshot** | What the GitHub adapter returns for a pull request (`PrSnapshot`): each field of gh's JSON checked once, so an unsafe ref or a malformed head arrives as `null` and a PR not known to be same-repo reads as cross-repository (a fork PR is never adopted), and policy code never reads raw gh output. | - |

## Dashboard look

Words for how the dashboard shows activity, used in the README, Settings and `dashboard/AGENTS.md`. The design language behind them ("station", "bezel", "pilot lamp") belongs in code, comments and design notes, never in dashboard copy.

| Term | Meaning | Config key |
|---|---|---|
| **heat** | The dashboard's picture of activity: a session log's frame warms while output streams and cools slowly after, and a board card's edge cools once after its job changes stage. It shows only what arrives while the dashboard is connected, never a page load or a reconnect, and reduced motion leaves each at its end state. | - |
| **lamp** | A small light that shows state at a glance, on a session log's nameplate (working, waiting, you, done, idle or fault) and on the status bar's indicators. It is decorative: the pill or text beside it carries the meaning. | - |
| **Screen effect** | The browser preference in Settings › General for the scanlines and soft glow on session logs, on by default and kept per browser like Grain; off leaves the rest of each log's frame as it is. | - |

## Collisions we avoid

Some of these words already mean something in Forge. They keep those meanings:

- `resources` stays the reference links agents should know about, and `infra.mode` stays the policy for cloud and infrastructure commands. That is why runtime infrastructure is a "backing service", never a "resource" or "infra".
- "GitHub Project" always carries the prefix (`tracker.github.project`, `statusSync: project`). Bare "project" means the glossary's project.
- The top-level `project:` block (name, description, kinds, instructions, notes) today describes the root repo of a one-repo project.
- `services:` today lists a monorepo's sub-paths with their own commands. It keeps its name, and a component of kind `service` is not a `services:` entry.
- "Model profiles" in [CONFIG.md](CONFIG.md) are `runtime.models` presets from `/forge init`. "Profile" alone means the glossary's profile.
- A job's `dependsOn` is a job dependency. "Dependency" alone means a component edge.
- "Environment" alone never means environment variables (say "environment variables"), and "focus" never means a test's focus marker or keyboard focus.
- "Hand-off" alone means a session handing a job to another with `forge requests add resume`; the Foreman's always carries the name ("Foreman hand-off").
- "File map" is a spec's `Files:` table; a folder's `AGENTS.md` is its "folder map".
- "Integrations" never means the integrate stage or the integrator (bringing a branch up to date with its base), nor integration tests (`test/integration/`).
- "Office" alone means the runtime; the Foreman's session is the "office session".
- "Milestone" means a tracker milestone (a group of planned work). The Thread's one-line rows for a job's events are "progress lines".
- "Layer" alone keeps [its meaning in the architecture docs](architecture/layers.md) (engine, roster, repo layer, runtime state). The folders of `lib/` are "lib layers".

## Existing terms

The new words build on these, which exist today.

| Term | Meaning | Config key |
|---|---|---|
| **job** | One unit of work that Forge takes from request to PR, in its own worktree. | - |
| **move** | A change to a job's stage, state or `waitingOn` made through `lib/engine/pipeline/moves/apply.ts`, which then stops or tears down its environment, queues the Foreman's gate request and mirrors it to its tracker; notifications follow every transition. | - |
| **output mode** | How a `forge` call prints: `human` (rendered text for a person at a terminal) or `agent` (compact JSON, the CLI's contract), chosen by `--json`, `--mode`, `FORGE_MODE`, then whether stdout is a terminal (docs/CLI.md "Output mode"). | - |
| **activity log** | The timestamped lines a foreground `forge dash` prints after its banner in human mode, of three kinds: `session` (session transitions), `http` (requests worth noting) and `job` (newly appended job events); `--quiet` and agent mode leave only the banner (docs/CLI.md "Output mode"). | - |
| **Foreman** | The office session that decides gates for jobs under `foreman.decides`. | `foreman.decides` |
| **Foreman hand-off** | The Foreman leaving a gate it was asked to decide for a person (a reserved topic or class, the assistant escalating, or the CLI refusing its decision), recorded with `forge job handoff` and shown as *left for a human* (`foremanHandoff`) until a decision answers that park or the job parks again. | `foreman.reserved` |
| **lease** | A job's one claim on who drives it (`lease` in job.json: `driver`, `epoch`, `since`, `renewedAt`, `expiresAt`): taken by `forge job claim`, renewed only by the driver's own activity, expired by the supervisor when the driver's session exits, and `live` until `expiresAt` passes; nobody else may claim a live lease without `--force`. | - |
| **epoch** | The lease's counter, one higher at every change of driver and never lower; a driver passes the epoch its claim returned as `--epoch`, and a write with an older one is refused (`stale_epoch`), so a session that was taken over can't write after it. | - |
| **reconciler** | The pass (lib/office/reconcile.ts) that finds `running` jobs nothing drives (no request routed to them, no busy session, no live lease) and resumes each once, then parks it on `escalation` if it made no progress since; `forge dash` runs it every 30 s and `forge sync` runs it when no dash does (it replaces what was called a stranded job). | `daemon.turnTimeoutMinutes` |
| **rework panel** | The lenses that re-run on a rework round under `review.onRework: narrow` (the `always` and `alwaysOnRework` lenses, `security` by default, those whose last verdict asked for changes or that have none, and those whose `paths` the fix touched), while every other lens on the job's panel keeps its last pass. | `review.onRework` |
| **outcome** | What happened to a merged job inside its window after the merge (reverted, follow-up bug issues, churn), `open` until the window closes and `final` after, measured by `forge sync` and stored as `outcome` in job.json. | `outcomes.windowDays` |
| **autonomy rate** | The share of merged jobs with a final outcome that shipped with no person's rework, revision, decision, PR feedback or edit, and were neither reverted nor followed by a bug; the **strict** autonomy rate also counts a person's approval at a gate config requires (spec, split, repos, release, issue link, infra, protected paths). | - |
| **score** | A sampled merged job's post-merge quality score from the judge, 0-5, against the spec's acceptance criteria and the merged diff; queued by `forge sync`, recorded by `forge job score record` and stored as `score` in job.json (`held` when a budget stopped it, `failed` without a valid `score.md`). | `scoring.sample`, `scoring.model` |
| **score coverage** | How many merged jobs were sampled for a score, and how many of those were scored, held, failed or are still queued (`scoreCoverage` in `forge stats`). | `scoring.sample` |
| **churn** | Later non-Forge commits on the base branch, inside a job's outcome window, that touch a file the job's merge changed; a soft signal reported beside the autonomy rate, never counted against it. | `outcomes.windowDays` |
| **total-round ceiling** | The most build rounds a job runs, whoever opened them (the builder, a person, the Foreman, or a CI rework), before each further round needs a person's rework, twice `maxRounds` by default; past it step parks the job on `rounds-exhausted` (rule B7) and the Foreman is refused there. | `pipeline.maxTotalRounds` |
| **CI rework cap** | The most CI reworks in a row, with no person's action between, that `forge sync` starts on a PR whose checks fail; the next red head waits on `pr-review` for a person, with a reason naming the failing checks. | `pr.maxCiReworks` |
| **unattended job budget** | The spend limits a job in a daemon-enabled repo gets when its own budget sets no `tokens`, `usd` or `minutes` limit. | `daemon.jobBudget` |
| **`release` gate class** | The Foreman's approval of one job's release plan (`forge release plan --job`), which stands in for `forge release run`'s publish prompt without a terminal, for that exact plan only, which stays a human's unless a project adds `release` to `foreman.decides` and removes `gate:release` from `foreman.reserved` (not the **release gate**, the CI check on interim references). | `foreman.reserved` |
| **prompt cohort** | The jobs whose last start of one role ran on the same prompt hash (`promptHash` on `agent-start`), grouped by `forge stats --by prompt` so a prompt change can be compared with the prompts before it. | - |
| **settled experiment** | An experiment ledger entry whose status `forge experiment evaluate` wrote (`kept`, `reverted` or `inconclusive`, with its n, method and interval); it is history, and the notes check refuses any change to it. | `improve.experiments` |
| **progress line** | A one-line row the job panel's Thread shows between the messages for a job event a person follows: a new stage, a parked gate, an agent's closing reply, a round's checks or reviews, the decision, the PR, merge conflicts or a note. It never counts as unread. | - |
| **scenario** | A named dashboard state, one JSON file in `test/fixtures/scenarios/`, that `npm run scenario`, `npm run dev -- --scenario` and the render check seed into a scratch repo through the CLI alone, with the texts each view must show (docs/TESTING.md "Dashboard scenarios and the render check"). | - |
| **render check** | `npm run test:render`: every view of every scenario, and the job drawer, loaded in headless Chrome against a dashboard build, failing on a console or page error, a 5xx or missing text; CI's `render` job runs it, outside the verify list. | - |
| **version step** | One named entry (`{ id, up }`, or `{ id }` for `/api`) in an append-only version list (`lib/core/versions/`, `lib/api/versions.ts`); a shape's version is its list's length plus one, so a shape change appends a step and never types a number. | - |
| **file map** | The `Files:` table that ends a spec's Approach: one row per file the builder will touch or reuse, with its symbols, the change and the tests that cover it; `forge job acs` reports a spec without one as incomplete (`fileMap`, `incomplete`). | - |
| **recall fixture** | A frozen diff in the main checkout's `.forge/evals/recall/<name>/`, with the lenses that review it and its planted defects (none for a clean fixture), that `forge eval recall` grades reviewer prompts against. | `evals.recall.paths` |
| **worktree seed** | A private, Forge-owned copy of a fresh base worktree's dependency paths and caches, which new job worktrees clone copy-on-write while their key files match, instead of running setup. | `worktrees.seed` |
| **finding key** | A review finding's lens plus the first four words of its title, lower-cased, without its location, code spans, paths, punctuation and stop words; `forge retro prepare` lists findings that share one in 2 or more jobs under `## Recurring findings across jobs`. | - |
| **mechanical finding** | A recurring finding a script could decide from the diff or the tree, for which the retro proposes a check (an invariant test, a lint rule or a verifier) instead of a learning; every other finding is a judgement finding. | - |
