# lib/engine/guard/

The guards on what jobs write and publish: verify integrity, protected paths, secret scanning and redaction, and AI attribution.

- These modules sit below the worktree and PR code that calls them, so they never import `lib/engine/workspace/` (worktree, run, verify), `lib/engine/pr/` or `lib/engine/evals/`.
- `command-env.ts` decides what a configured command inherits: every spawn site of one (job-command, dev server, sinks, evals, release, notify) takes its env from `commandEnv` and its argv from `commandShell`. `daemonDrops` is the one filter #393 swaps for an allowlist.
- `attribution.ts` is what the no-AI-attribution hook (`hooks/no-ai-attribution.ts`) imports; `.github/CODEOWNERS` names it.
- When a guard parses git output, it pins the config that reshapes it (`--no-ext-diff`, `--no-textconv`, `core.quotepath=off`): repo and worktree config are builder-writable.
- Design: [Untrusted input](../../../docs/architecture/untrusted-input.md), [Policies](../../../docs/architecture/policies.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `attribution.ts` | AI-attribution policy. |
| `command-env.ts` | What a configured command inherits (docs/CONFIG.md "Daemon" and "Secret references"): the environment every spawn site builds on, and the shell argv it runs under. |
| `integrity.ts` | Verify's test-integrity report: what the committed diff did to the tests and to the config that runs them. |
| `known-secrets.ts` | Known values (docs/CONFIG.md "Secret references"): every secret value a job's sink renders has resolved, kept in the 0600 `<jobDir>/known-secrets.json`, plus its job database passwords. |
| `protected.ts` | `policy.protectedPaths`: paths only a human may change. |
| `redact.ts` | Redaction for the support bundle (lib/engine/ops/bundle.ts): what a user can attach to a public bug report. |
| `secret-refs.ts` | Secret references (docs/CONFIG.md "Secret references"): the value of a declared secret, read from its source only when a config sink renders `{secret.NAME}`. |
| `secrets.ts` | The secret scanner: Forge refuses to publish a likely credential. |
| `types.ts` | The secret scanner's and the redactor's shapes, type-only: SecretKind derives from SECRET_KINDS in secrets.ts. |
<!-- forge:map:end -->
