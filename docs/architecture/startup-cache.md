# Start-up cache

Agents and the orchestrator call `forge` hundreds of times a job, so start-up time is paid on every call. Before it imports `lib/cli/main.ts`, `bin/forge` turns on two caches in one directory:

- **V8's code cache** (`module.enableCompileCache`), on every Node. From Node 24 it covers type-stripped modules too.
- **Stripped modules**, on Node 22 and 23 only. Their code cache skips type-stripped modules, so every start loads the stripper and strips all of `lib/` again. A `module.registerHooks` load hook keeps each stripped `.ts` file of the plugin as `strip/<node version>/<sha256 of the source>.js`. Content keys mean an edited file or an updated plugin is never served stale, and identical files of different installs share an entry. A miss strips with `module.stripTypeScriptTypes` and silences its one-time ExperimentalWarning, which agents would read as a fault. The entry is written aside and renamed, so concurrent starts never read half a module. A file the stripper rejects goes to Node's own loader, which reports the error as usual. Beside it, a resolve hook resolves each layer alias (`#core/…`) a `lib/` file imports once per process, because Node 22 walks up to `package.json` on every one.

`forge job list`, median of 30 warm starts on an M-series Mac:

| Node | Before | After |
|---|---|---|
| 22.18 | 144 ms | 37 ms |
| 22.23 | 98 ms | 39 ms |
| 26.3 | 148 ms | 70 ms |

A miss costs about 15 ms over an uncached start, once per changed file. On Node 22 the modules `forge job list` loads take about 1.3 MB of cache (0.9 MB stripped, 0.4 MB V8), per Node version.

The cache holds code the CLI runs, so it must be no easier to write than the code it caches. It is `.cache/` in the plugin root (or `$FORGE_CACHE_DIR`), so whoever can write it could already rewrite `lib/`. It is not in a temp or other shared dir, because Claude Code's sandbox lets Bash write the temp dir: a sandboxed agent could plant a module there that a later unsandboxed `forge` would run. `bin/forge` creates the dir as `0700` with a `.gitignore` of `*`, so a checkout's `git status` never shows it. It uses the dir only when it is a real directory (not a symlink), owned by the current user, not group- or world-writable, in a parent owned by that user or root that is either not group- or world-writable or sticky. Otherwise, and whenever a read or write fails, the CLI runs uncached and prints nothing. A read-only install, or a sandbox that can't write the plugin, still reads entries an earlier unsandboxed start wrote and skips writing misses. Each plugin version starts with an empty cache and is removed along with it. `NODE_DISABLE_COMPILE_CACHE=1` turns both caches off. A `NODE_COMPILE_CACHE` already set wins for the V8 cache. Deleting the directory is always safe.
