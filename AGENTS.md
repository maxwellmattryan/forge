# Working on Forge itself

This repo is **Forge**: a Claude Code plugin that is also its own marketplace. This guide is for changing Forge; to *use* it in another repo, run `/forge` there. Read `README.md` first; for depth see `docs/ARCHITECTURE.md` (the architecture topics), `docs/CONFIG.md` (every config key) and [`docs/GLOSSARY.md`](docs/GLOSSARY.md) (the words docs, prompts and dashboard copy use). [docs/DEVELOPING.md](docs/DEVELOPING.md) is the reference: read a section when your change touches it.

## Essentials
Obey these on every change; each links the section with the detail.
- **Builder, spec writer or integrator? Read [docs/DEVELOPING.md](docs/DEVELOPING.md) before you start**: the layout, where each kind of change goes, the rules and the gotchas. Other roles read a section only when their task touches it.
- **Read the folder map first**: `lib/AGENTS.md` and each folder's `AGENTS.md` say what lives there, and the builder's brief lists the ones its file map touches ([Layout](docs/DEVELOPING.md#layout)).
- **Zero runtime dependencies**: Node ≥ 22.18 built-ins only; build tools are exact-pinned devDependencies ([Rules](docs/DEVELOPING.md#rules)).
- **The CLI is the only writer of state**: new state means a new CLI command, never an agent editing `job.json` ([Rules](docs/DEVELOPING.md#rules)).
- **Version every shape change**: append a named step to its version list in `lib/core/versions/`, and to `API_CHANGES` in `lib/api/versions.ts` when `/api/*` changes; on conflict keep both, in merge order ([Rules](docs/DEVELOPING.md#rules), [Where a change goes](docs/DEVELOPING.md#where-a-change-goes)).
- **Never add AI attribution** to commits, PRs, issues or comments ([Rules](docs/DEVELOPING.md#rules)).
- **Preserve the security posture**: never adopt fork PRs; the server answers loopback Hosts only; POSTs need the token, a matching Origin and JSON; tracker and PR text is fenced as data ([Rules](docs/DEVELOPING.md#rules)).
- **Work on `develop`**: branch from it and open PRs into it; `main` takes only release PRs and hotfix PRs, from `release/v<version>` branches ([Publishing](docs/DEVELOPING.md#publishing)).
- **Never commit `dashboard/dist/`** or hand-edit it: it is a gitignored build; run `npm run build:dashboard` to check it. CI builds it for the main update that the release PR carries into `main` ([Rules](docs/DEVELOPING.md#rules)).
- **Escape everything the dashboard renders**: `{@html}` only on the escape-first helpers ([dashboard/AGENTS.md](dashboard/AGENTS.md)).
- **Touching `dashboard/`?** Read [dashboard/AGENTS.md](dashboard/AGENTS.md) first: its look, i18n, Tailwind and escaping rules.
- **Never point the CLI at a real repo's `.forge/`** while developing: use a scratch repo or `FORGE_ROOT`, and `FORGE_HOME` for the machine index ([Verify](#verify-before-claiming-it-works)).
- **Jobs leave `CHANGELOG.md` and versions alone**: the release commit adds them ([Publishing](docs/DEVELOPING.md#publishing)).
- **Use the glossary's words** in docs, prompts and dashboard copy ([`docs/GLOSSARY.md`](docs/GLOSSARY.md)).
- **Keep docs in sync with CLI behaviour**: `README.md`, `docs/*.md` and `skills/forge/**` ([Rules](docs/DEVELOPING.md#rules)).
- **Run the verify list before claiming it works** ([Verify](#verify-before-claiming-it-works)).

## Verify before claiming it works
```bash
npm ci                                  # once: the dashboard's build toolchain (devDependencies only)
npm run check:touchpoints               # the companions this diff is missing, against origin/develop (docs/CI.md)
npm run typecheck                       # tsc --noEmit: the engine (tsconfig.json) and its tests (test/tsconfig.json)
npm run check:dashboard                 # svelte-check: strict TS over dashboard/src (.ts and .svelte), warnings fail
npm run build:dashboard                 # the build's own tests skip without it; it is gitignored, never commit it
node --test "test/**/*.test.ts" "lib/**/*.test.ts" "dashboard/src/**/*.test.ts"   # globs, not dirs: Node 22 treats a directory arg as a module
for f in bin/forge lib/trackers/status.mjs dashboard/*.mjs; do node --check "$f"; done   # the JS files tsc does not check
claude plugin validate . --strict
```
CI, Node 22.18, the dashboard, the plugin and GitHub code paths: [docs/DEVELOPING.md › Verify notes](docs/DEVELOPING.md#verify-notes).
