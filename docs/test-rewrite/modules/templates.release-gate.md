# templates/release-gate
Source: templates/release-gate/ · Public surface: release-gate.mjs (plain Node ≥ 18 script run from a consumer repo's root: exit 0 no interim reference, 1 at least one, 2 cannot check; editable `RULES` (cargo, cmake, npm) and `IGNORE`) and forge-release-gate.yml (the CI workflow `forge init write` seeds beside it).
Old tests: test/release-gate-script.test.ts, test/release-gate-init.test.ts
Baseline coverage: not measured (outside `lib/` and `dashboard/src/lib/`, which `npm run coverage` covers)

Seeding (when and where `forge init write` copies these files, the protectedPaths rule and the warning) is cli.commands.md B81–B82, E32–E33.

## Behaviours
- B1. Each ecosystem's interim pin fails the gate (exit 1) with a line `<path>:<line>: <ecosystem>: <why>: <text>` and a last line `release gate: <n> interim references; replace them with released versions before merging`. With all four pins written by the interim pin writers (`pinCargo`, `pinNpm`, `pinCmake`, `canaryVersion` from #engine/release/interim.ts, sha `'a'×40`) in one commit: `Cargo.toml:<lines of CARGO + 1>: cargo: a Forge interim [patch] block`, `cmake/CMakeLists.txt:6: cmake: a GIT_TAG pinned to a commit`, `package.json:4: npm: a git dependency pinned to a commit`, `web/package.json:4: npm: a canary pre-release`, then `release gate: 4 interim references; …`; the npm line's text is `"lib": "git+https://example.com/lib.git#<sha>"`. Each pin alone → its own line and `release gate: 1 interim references; …`. Old: release-gate-script › "the seeded release gate script › fails on a git-ref or canary pin, per ecosystem"
- B2. Once every dependency is a released version again (the original Cargo.toml, package.json ×2, CMakeLists.txt) → exit 0, stdout exactly `release gate: no interim references in 4 manifests\n`. Old: release-gate-script › "passes once every dependency is a released version"
- B3. Only tracked files are scanned (`git ls-files -z`), and `node_modules/` paths are ignored: a tracked `package.json`, a tracked `node_modules/dep/package.json` with a pin, an untracked `untracked/Cargo.toml` and a gitignored `ignored/package.json` → exit 0, `release gate: no interim references in 1 manifests\n`. Old: release-gate-script › "scans tracked files only"
- B4. The rules are editable in the seeded copy: removing the npm rule block (`// edit to match your project: a git dependency at a commit` … `},`) from a copy makes a repo with only an npm pin pass with `release gate: no interim references in 0 manifests\n`. Old: release-gate-script › "patterns are editable in the seeded file"
- B5. The seeded workflow runs the script read-only: workflow `permissions: {contents: 'read'}`; no job sets its own `permissions`; every `uses:` is pinned to a 40-hex commit (`/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/`); the checkout step has `with: {persist-credentials: false}`; a step runs exactly `node .forge/ci/release-gate.mjs`; no `setup-node`, `npm ` or install outside comments. Triggers: `pull_request` and `merge_group`. Old: release-gate-init › "release gate seeding › the seeded workflow runs the script with read-only permissions"

## Edge and corner cases
- E1. It fails closed (exit 2, `release gate: cannot check: <reason>\n` on stderr) when it cannot check: an invalid package.json (`{ "name": "app", `) → `package.json is not valid JSON`; a JSON array (`[1, 2]`) → `package.json is not a JSON object`; outside a git repo (`GIT_CEILING_DIRECTORIES` above a non-git temp dir) → starts `release gate: cannot check: git ls-files exited `. Setup: the scratch git repo recipe; one commit per manifest state; the no-git case runs in a fresh non-git temp dir. Old: release-gate-script › "fails closed when it cannot check"
- E2. A tracked manifest that is a symlink (`package.json` → `deps.json`) is never followed: exit 2, stderr exactly `release gate: cannot check: package.json is not a regular file\n`. Setup: the scratch git repo recipe; `deps.json` holds the pinned package.json text, `package.json` is a relative symlink to it, committed with `--allow-empty`. Old: release-gate-script › "a tracked manifest that is a symlink fails closed"
- E3. Cargo `[patch]` pins without the Forge marker: the marker lines stripped from a pinned Cargo.toml → exit 1 with `Cargo.toml:<n>: cargo: a [patch] entry pinned to a commit: `; a quoted source `[patch."https://example.com/x"]` with an inline table `rev = '<sha>'` → exit 1; a `rev` outside `[patch]` → 0; a `[patch]` at a tag → 0; a later section ends the `[patch]` (a `rev` under `[workspace.dependencies]` after it) → 0; the Forge block itself is reported once, not once per rev. Setup: the scratch git repo recipe with CARGO as the base text. Old: release-gate-script › "a [patch] entry pinned to a commit fails without the Forge marker"

## Regressions worth keeping
- R1. A long hostile line stays linear: a CMakeLists.txt line `  GIT_TAG <'a'×10000>` and a package.json with `git+<'#'×10000>` and `'-canary'×2000` specs finish in under 5 s with exit 0 (no catastrophic backtracking). Setup: the scratch git repo recipe. Old: release-gate-script › "a long hostile line stays linear"

## Cheapest layer
The script is a standalone program for consumer repos: spawn `node templates/release-gate/release-gate.mjs` with the scratch repo as cwd (no shell, so it runs on Windows too). The workflow is parsed as YAML (#core/format/yaml.ts) after `initWrite` seeds it, or read straight from the template.

## Setup recipes
- A scratch git repo per case: `git init -q -b main`, user name/email, then `scratchGitConfig(git)` from test/helpers.ts; write manifests and commit (`--allow-empty` for a symlink-only commit).
- Baseline manifests: CARGO `[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nlib = "1.2.0"\n`; PKG `{\n  "name": "app",\n  "dependencies": {\n    "lib": "^1.2.0"\n  }\n}\n`; CMAKE `cmake_minimum_required(VERSION 3.24)\ninclude(FetchContent)\nFetchContent_Declare(\n  lib\n  GIT_REPOSITORY https://example.com/lib.git\n  GIT_TAG v1.2.0\n)\n`.
- Pinned forms from the pin writers: `pinCargo(CARGO, [{source:'crates-io', name:'lib', git:'https://example.com/lib.git', rev:SHA}])`, `pinNpm(PKG, 'lib', 'git+https://example.com/lib.git#'+SHA)`, `pinCmake(CMAKE, 'lib', SHA)`, `pinNpm(PKG, 'lib', canaryVersion('1.2.0', SHA))` (each returns `{text}` or `{error}`).
- Workflow: `initWrite(tempRepo().dir, {tracker:{kind:'none'}, pr:{enabled:false}, release:{interim:'canary'}}, false)` then read `.github/workflows/forge-release-gate.yml`.

## Dropped on purpose
- Nothing.
