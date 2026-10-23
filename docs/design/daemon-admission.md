# Design note: pacing the daemon pool against the subscription windows

Status: proposal. Follows commit `7aa5cec` (failed turns retry instead of stranding their requests), which is the reactive half of this; the note describes the proactive half.

## Problem

With `daemon.enabled`, `forge dash` runs up to `daemon.maxConcurrent` job sessions on the human's Claude login. A subscription is not rate-limited per request: it has a rolling 5-hour window and a 7-day window, measured in usage, with no published numbers to pace against. In practice three jobs exhaust the 5-hour window, after which every session's turns fail until the reset. Spacing requests out cannot help by itself, because three jobs in sequence spend what three jobs in parallel spend; what helps is not starting work the window cannot pay for, resuming when it resets, and leaving the human room to keep working in their own session.

Measured on this repo's logs (`.forge/runtime/daemons/*.log`, 2026-10-14): one orchestrator turn of about 20 minutes moved the 5-hour window from 0.10 to 0.21. A turn is the smallest unit the supervisor can gate, and it is coarse: three turns in flight can commit a third of the window after the pool has already decided to stop.

## The signal

Claude Code prints a `rate_limit_event` line on a headless session's stdout, account-wide, every few API calls within a turn (the first within seconds of `init`). Observed shape:

```json
{"type":"rate_limit_event","rate_limit_info":{
  "status":"allowed",                       // also expected: allowed_warning, rejected
  "rateLimitType":"five_hour","resetsAt":1791966600,
  "overageStatus":"rejected","isUsingOverage":false,
  "unifiedWindows":{
    "five_hour":{"utilization":0.17,"resetsAt":1791966600},
    "seven_day":{"utilization":0.38,"resetsAt":1792022400},
    "seven_day_overage_included":{"utilization":0.32,"resetsAt":1792022400}}}}
```

`resetsAt` is epoch seconds; `utilization` is a fraction. The event is undocumented, so it is parsed tolerantly (`parseRateLimit` in `lib/daemon.ts` already does, for the retry path) and the feature degrades to today's behaviour when it is absent or changes shape. Two limits follow from how it arrives: readings exist only while some session is making requests, so a fully paused pool learns nothing new and must resume on time, not on observation; and the human's own interactive spend shows up only in the next reading a daemon turn produces, so thresholds need headroom.

## Principles

- **The pool decides, at turn granularity.** Every session is a child of one `forge dash`, and `lib/daemon-pool.ts` already hands out slots. Admission is one more input to that decision. Nothing throttles inside a turn and nothing kills a busy session: a turn that started finishes.
- **One reading serves every session.** Utilization is per account, so the newest reading from any child is the pool's reading. Several `forge dash` processes on other repos see the same number and pace themselves the same way, without coordination.
- **Proactive and reactive layers agree.** The pool stops issuing turns before the window is spent; if a turn is refused anyway, the session's retry-at-reset (commit `7aa5cec`) is the backstop, and that `rejected` event also becomes the pool's reading so the other sessions stop at once instead of each discovering it.
- **Visible everywhere a hold is visible today**: the pool bar, the session pill, `forge daemon status`, the session logs.
- **Configurable from the dashboard.** Thresholds name no command, file, tool or repository and loosen no security policy, so they pass the `lib/config-fields.ts` editable rule.

## Mechanism

### Reading

`lib/daemon.ts` already keeps the last `rate_limit_event` of the turn in flight. It gains a context callback, `ctx.onRateLimit(scope, info)`, called on every event, where `info` is the parsed `{status, windows: {five_hour, seven_day}, observedAt}` (the `seven_day_overage_included` window is ignored: overage is off for a subscription that has none, and the plain `seven_day` is the binding one). The pool keeps the newest reading as `quota` and persists it to `.forge/runtime/daemons/quota.json`, so a restarted `forge dash` does not start three blind turns; a persisted window whose `resetsAt` has passed counts as unknown.

A `rejected` status sets that window's utilization to 1 in the pool's reading, whatever the number said.

### Decision

A pure function in a new `lib/admission.ts`, so it is unit-tested without children:

```
admit({ quota, config, maxConcurrent, now }) -> { slots, hold: null | { window, until } , reason }
```

- `u(window)` is the window's utilization, or 0 when unknown.
- If any window has `u >= pause`: `slots = 0`, `hold = { window, until: that window's resetsAt }`. With both windows over, `until` is the earlier reset; the first turn after it is a probe whose events say whether the other window still binds, in which case the pool holds again.
- Else if any window has `u >= throttle`: `slots = 1`.
- Else `slots = maxConcurrent`.
- Hysteresis: a hold ends at `until`, or when a fresh reading (another repo's pool, a probe) shows `u < pause - 0.05`. A throttle lifts when `u < throttle - 0.05`. This keeps the pool from flapping around a threshold as readings jitter by a point or two.

Defaults: `throttle: 0.6`, `pause: 0.85`. `pause` keeps roughly 15% of a window for the human and for the turns already in flight. Both `null` disables admission and leaves the pool as it is today.

### Pool

In `tick()`, `slots` replaces `maxConcurrent` in the slot loop. A job beyond `slots` is `waiting` as now. Under a hold, every session routes to `held: 'quota'` the way budget holds work: eligible requests are kept, nothing is written, and the `held` log line carries `until`. `cancel` and `approve` requests are held too: both are cheap, but a held pool makes no API call at all, and the human's own session can act on them. The inbox is not counted against `slots` (as today) but is held at `pause` like any session, because intake is a turn as well.

Idle children stay alive under a hold; idle-stop and slot-stealing work unchanged. The 2-second poll re-evaluates `until`, so no timer is needed; to blunt the herd at a reset when several pools share an account, each pool adds a fixed jitter of up to 60 s derived from the checkout's realpath hash.

Pool-wide transitions (`hold`, `throttle`, `resume`) are logged as a `quota` event to every live session's log, the way trust stops are, with the reading that caused them.

## Surfaces

- `/api/state.daemons.quota`: `{ windows: { five_hour: {utilization, resetsAt} | null, seven_day: … }, observedAt, slots, hold: { window, until } | null }`. `API_VERSION` 10; `dashboard/src/lib/types.ts` mirrors it (`test/types-parity.ts`). `DaemonSessionState.held` widens to `'budget' | 'quota' | null` in both type files.
- Dashboard pool bar: a quota chip (`5h 72% · resets 14:05`, `7d 38%`), red while held with the resume time, and `held: quota (n)` beside the budget count. Session pill: `held: quota`. Settings, Daemon section: the two thresholds. New keys in `dashboard/src/messages/en/` (`statusbar.json`, `settings.json`).
- `forge daemon status` adds `quota` (the same object) so the terminal shows why nothing is running. `forge doctor` prints one line when a hold is active.
- Config (`docs/CONFIG.md`, `lib/config.ts` `defaults()`, `lib/config-fields.ts`, `daemonProblems`):

```yaml
daemon:
  quota:                     # pace the pool against the login's usage windows (null: never)
    throttle: 0.6            # one job session at a time once a window is this full
    pause: 0.85              # no new turns once a window is this full, until it resets
```

  Validation: each a number in (0, 1] or `null`, `throttle <= pause` when both set. Like `daemon.auth`, new keys with defaults need no `CONFIG_SCHEMA_VERSION` bump, because normalisers fill them.

## Interactions and edge cases

- **No reading yet** (first start, or every window reset while idle): the pool runs at `maxConcurrent` until the first event, which arrives seconds into the first turn. The persisted reading covers restarts.
- **`daemon.auth: api-key`**: API accounts have per-minute limits and a spend cap, not windows. Whether claude emits `rate_limit_event` on a key is unverified; if it does not, admission is a no-op there and the retry backoff remains the only pacing.
- **A human's session** shares the account. Its spend appears in the next daemon reading; `pause` headroom is the mitigation, and the dashboard chip makes the shared state visible.
- **Clock**: `resetsAt` is server time; the pool compares it to `Date.now()`. A skewed local clock resumes early or late by the skew, which the retry backstop absorbs.
- **Mid-turn overshoot** is accepted: a turn is never interrupted. If measurement shows single turns regularly cross `pause` on their own, the next refinement is to project each in-flight turn's expected delta (the median per-turn delta in the logs) and admit against `u + inflight × delta`.
- **Interactive sessions** (`/forge next` in a human's window) are unaffected: admission is a pool concern.

## Tests

- `test/admission.test.ts`: the pure function across thresholds, unknown windows, hysteresis, both windows over, nulls.
- `test/integration/pool/daemon.test.ts` with `fakeKit`: a child emits events; assert slots shrink to 1 at `throttle`, a hold at `pause` with `held: 'quota'` on every session and nothing written, resume after `until` (short `resetsAt` in the test), a `rejected` event holding the other sessions at once, the reading surviving a pool restart via `quota.json`, and an expired persisted window ignored.
- `test/dashboard-daemon.test.ts`: `poolModel` with a quota chip and `held: 'quota'` pills; `test/config-set.test.ts` picks the new fields up automatically; `test/dashboard-invariants.test.ts` enforces the rest (`test/types-parity.ts` existed when this was written and has since been removed).

## Rollout and measurement

1. **Observe first**: ship the reading, persistence, `quota` in `/api/state` and `forge daemon status`, and the chip, with both thresholds `null`. The chip alone answers "why did three jobs stop" today.
2. **Enable defaults** once a few days of logs give per-turn and per-job deltas on the 5-hour window. `forge stats` can later report "window share per job" from the same events, which is the number that decides whether `pause` is right.
3. Judge success by failed turns per window (should fall to zero outside the reset moment) and by whether the human's own sessions stop hitting the limit while the daemon runs.

## Out of scope here

Reducing spend per job (model per role, fewer lenses, tighter `pipeline.budget`) is the only lever that raises jobs per window and is worth its own measurement pass. Overflowing to an API key when the subscription is spent is a billing decision, not a scheduling one, and stays opt-in through `daemon.auth`. Throttling inside a turn would need the orchestrator's cooperation and is not attempted.
