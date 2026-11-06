# lib/integrations/os-service/

The OS's per-user service managers, sleep assertions and browser openers: launchd and systemd units and their CLIs, caffeinate and systemd-inhibit, and open, xdg-open and rundll32.

- Mechanism only: which unit a platform gets, its environment, when the dashboard holds the machine awake and when `forge dash` opens a browser are policy, in `lib/engine/project/login-service.ts`, `lib/server/uptime.ts` and `lib/cli/commands/dash.ts`.
- A browser gets a link only through a 0600 redirect file's path, never the link in its argv, and openers run by absolute path (`browser.ts`).
- Every value that reaches a unit file is escaped for its format, and the readers parse back exactly what the renderers write, so doctor can tell which Forge and node a unit runs.
- Nothing here runs a manager's CLI or starts a helper by itself: callers pass a `ServiceRun`, a `SleepSpawn` or the opener's `spawn`, and only `forge dash` passes the real ones, so no test can install a unit or start a real `caffeinate` or browser.
- Design: [Daemon](../../../docs/architecture/daemon.md), [Daemon security](../../../docs/architecture/daemon-security.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `browser.ts` | The human's browser: the opener for each platform, and the redirect file that hands it a link without putting the link (and its key) in any argv. |
| `launchd.ts` | macOS's per-user LaunchAgent for the machine dashboard: the plist file, its reader, and the launchctl argv that loads, unloads and inspects it in the user's GUI domain. |
| `sleep.ts` | The machine's sleep assertion: caffeinate on macOS and systemd-inhibit on Linux, held by one helper child that exits on its own when the dashboard's pid dies, so a SIGKILLed dashboard leaves nothing behind. |
| `systemd.ts` | Linux's systemd user unit for the machine dashboard: the unit file, its reader, and the `systemctl --user` argv that enables, disables and inspects it. |
| `types.ts` | The shapes of the OS service managers and the sleep helper, type-only: a unit's program, environment and log, the runner its manager's CLI goes through, and the helper child a test fakes. |
<!-- forge:map:end -->
