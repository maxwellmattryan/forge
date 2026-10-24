# lib/core/os/

OS helpers on Node built-ins: the platform tiers, child processes and pids, small file reads and writes, and the mkdir lock.

- `run` starts a binary without a shell, so arguments are never reinterpreted. git, gh and docker have their own runners in `lib/integrations/`, which add their pins and timeouts.
- Locks are broken only when their holder is provably dead, never for their age (docs/architecture/concurrency.md "Locks prove death").
- Design: [Concurrency](../../../docs/architecture/concurrency.md), [Daemon security](../../../docs/architecture/daemon-security.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `fs.ts` | Small file helpers: JSON and text reads with fallbacks, atomic and owner-only writes, and the check that a path stays inside the checkout. |
| `lock.ts` | The mkdir lock across concurrent Forge sessions on one machine, broken only when its holder is provably dead. |
| `platform.ts` | The support matrix (docs/SUPPORT.md) as code: one definition of the platform tiers that doctor reports and the daemon and `forge update` refusals enforce, plus the POSIX sh resolver configured command templates run through outside the daemon. |
| `process.ts` | Child processes and pids: run a binary without a shell, find one on PATH, and signal, wait for and identify processes. |
<!-- forge:map:end -->
