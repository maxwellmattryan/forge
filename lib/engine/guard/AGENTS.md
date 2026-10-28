# lib/engine/guard/

The guards on what jobs write and publish: verify integrity, protected paths, secret scanning and redaction, and AI attribution.

- These modules sit below the worktree and PR code that calls them, so they never import `lib/engine/workspace/` (worktree, run, verify), `lib/engine/pr/` or `lib/engine/evals/`.
- `command-env.ts` decides what a configured command inherits: every spawn site of one (job-command, dev server, sinks, evals, notify) takes its env from `commandEnv`, an allowlist the same in and out of the daemon, and its argv from `commandShell` with `login: loginShell(config)` (notify always `-c`). `forge release run` alone keeps its caller's whole environment and `login: true`. Widen the allowlist only for a name no credential can hide behind; a repo opts more in through `commandEnv.inherit`.
- `command-env.ts` also owns the PATH those commands get: `sanitizePath` drops empty and relative entries, and `adoptCommandPath` captures the login shell's PATH once at `forge dash` start into `FORGE_COMMAND_PATH`, which no command receives.
- `attribution.ts` is what the no-AI-attribution hook (`hooks/no-ai-attribution.ts`) imports; `.github/CODEOWNERS` names it.
- `prompt-prefix.ts` is the only builder of a role run's system-prompt file (`--append-system-prompt-file`). Its sources are the main checkout's trusted files only (the role's `project.instructions`, `.forge/notes/learnings.md`, `.forge/notes/<role>.md`), never job-folder or worktree text; the file is content-addressed under `.forge/runtime/prompt-prefix/`, outside every write root; and a refused source falls back to today's run, with no prefix.
- When a guard parses git output, it pins the config that reshapes it (`--no-ext-diff`, `--no-textconv`, `core.quotepath=off`): repo and worktree config are builder-writable.
- Design: [Untrusted input](../../../docs/architecture/untrusted-input.md), [Policies](../../../docs/architecture/policies.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `attribution.ts` | AI-attribution policy. |
| `command-env.ts` | What a configured command inherits (docs/CONFIG.md "Command environment"): an allowlist of the Forge process's environment that every spawn site builds on, and the shell argv it runs under. |
| `floor.ts` | The escalate floor: paths no unattended merge lands, whatever policy.protectedPaths says. |
| `integrity.ts` | Verify's test-integrity report: what the committed diff did to the tests and to the config that runs them. |
| `known-secrets.ts` | Known values (docs/CONFIG.md "Secret references"): every secret value a job's sink renders has resolved, kept in the 0600 `<jobDir>/known-secrets.json`, plus its job database passwords. |
| `prompt-prefix.ts` | The trusted prefix: the role-run system-prompt file built only from the main checkout's instruction files, learnings and the role's notes. |
| `protected.ts` | `policy.protectedPaths`: paths only a human may change. |
| `push-hold.ts` | The held push: what `forge pr open` won't push until a person approves it, and why. |
| `redact.ts` | Redaction for the support bundle (lib/engine/ops/bundle.ts): what a user can attach to a public bug report. |
| `secret-refs.ts` | Secret references (docs/CONFIG.md "Secret references"): the value of a declared secret, read from its source only when a config sink renders `{secret.NAME}`. |
| `secrets.ts` | The secret scanner: Forge refuses to publish a likely credential. |
| `types.ts` | The secret scanner's and the redactor's shapes, type-only: SecretKind derives from SECRET_KINDS in secrets.ts. |
<!-- forge:map:end -->
