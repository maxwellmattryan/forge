# lib/engine/trackers/

Tracker sync: the adapter loader with its security wrappers, mirrors, issue links, triage and request refresh.

- `load.ts` wraps every adapter, built-in or custom, so outgoing text is secret-scanned and incoming text is fenced as data; adapters never do either themselves (docs/TRACKERS.md).
- The built-in adapters live in `lib/integrations/github/tracker.ts` and `lib/integrations/backlog/tracker.ts`; the contract is `lib/api/tracker.ts`.
- Design: [Untrusted input](../../../docs/architecture/untrusted-input.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `link.ts` | A job's issues: searching a tracker for them and linking, unlinking, creating or waiving them. |
| `load.ts` | The tracker loader: picks the built-in or repo-local adapter the config names and wraps it in the secret checks every tracker write goes through, and a repo-local adapter's get in the import fence. |
| `mirror.ts` | A job's state mirrored onto its linked issues, each in its own repo's tracker. |
| `request-refresh.ts` | Re-reads a job's request.md from its primary issue. |
| `triage.ts` | Readiness triage: `forge tracker triage` scores ready tracker items before work starts, in two CLI calls with the `forge:triage` agent between them (the CLI never calls a model). |
<!-- forge:map:end -->
