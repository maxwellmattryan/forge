# lib/integrations/os-service/

The OS's per-user service managers and sleep assertions: launchd and systemd units and their CLIs, and caffeinate and systemd-inhibit.

- Mechanism only: which unit a platform gets, its environment and when the dashboard holds the machine awake are policy, in `lib/engine/project/login-service.ts` and `lib/server/uptime.ts`.
- Every value that reaches a unit file is escaped for its format, and the readers parse back exactly what the renderers write, so doctor can tell which Forge and node a unit runs.
- Nothing here runs a manager's CLI or starts a helper by itself: callers pass a `ServiceRun` or `SleepSpawn`, and only `forge dash` passes `spawnSleepHelper`, so no test can install a unit or start a real `caffeinate`.
- Design: [Daemon](../../../docs/architecture/daemon.md), [Daemon security](../../../docs/architecture/daemon-security.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `launchd.ts` | macOS's per-user LaunchAgent for the machine dashboard: the plist file, its reader, and the launchctl argv that loads, unloads and inspects it in the user's GUI domain. |
| `sleep.ts` | The machine's sleep assertion: caffeinate on macOS and systemd-inhibit on Linux, held by one helper child that exits on its own when the dashboard's pid dies, so a SIGKILLed dashboard leaves nothing behind. |
| `systemd.ts` | Linux's systemd user unit for the machine dashboard: the unit file, its reader, and the `systemctl --user` argv that enables, disables and inspects it. |
| `types.ts` | The shapes of the OS service managers and the sleep helper, type-only: a unit's program, environment and log, the runner its manager's CLI goes through, and the helper child a test fakes. |
<!-- forge:map:end -->
