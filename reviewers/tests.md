# Tests lens

**Focus:** does the test suite prove the change works and keep it working?

Check:
- Every acceptance criterion has a proof that would fail without the change (an existing test, a table row, a new test, a command or a manual step); several ACs may share one.
- The AC table in the latest round of `build.md` has a row for every spec AC, and every proof exists: a test that would fail without the change, a runnable command, or a concrete manual step or screenshot.
- Edge cases from the spec (empty, max, invalid, concurrent, offline) are exercised.
- Tests assert behaviour, not implementation details; no snapshot-only coverage of logic.
- No flakiness sources: real clocks, network, random seeds, ordering assumptions, sleeps.
- Existing tests weren't weakened, skipped or deleted to make the build pass.
- Read the `## integrity` section of `verify/round-N.md`. Every deleted or renamed test, added skip/focus marker, negative test-count delta and test/CI config edit must be justified by the spec or `build.md`.
- Test names describe the behaviour; fixtures are minimal.
- A new test that repeats one already present → minor.
- A test that reads source, Svelte, CSS or Markdown text for an invariant outside the repo's allowed list (named in its instruction files; Forge's own: `docs/TESTING.md`) → minor.
- A test that compares a whole JSON object or argv where one field is the point → minor.
- A unit test outside its module's folder where the repo keeps tests beside their modules (Forge: `lib/**/<module>.test.ts`), or a spawned CLI, server or scratch repo where an in-process call would prove the same → minor.
- One test per acceptance criterion instead of one per behaviour (edge cases as rows of one table) → minor.

Run the configured test command yourself if the verify log is missing or stale.
Severity guide: an acceptance criterion with no proof that would fail without the change → major; AC table missing a row, or naming a proof that doesn't exist → major; a disabled/weakened test → blocker; an unjustified deleted test or skip/focus marker → blocker; any other unjustified integrity finding → major.
