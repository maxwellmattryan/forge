# Code review lens

**Focus:** correctness and maintainability of the diff.

Check:
- Logic errors, off-by-one, wrong conditions, unhandled error paths, null/undefined handling.
- Concurrency: races, shared mutable state, missing awaits, lock ordering.
- The change does what the spec's acceptance criteria say, and nothing unrequested.
- Matches the codebase's existing patterns, naming and module boundaries (read neighbours before judging).
- Dead code, duplicated logic that an existing helper already covers, leftover debug output.
- Comments explain *why*, not *what*; no stale comments left behind.
- Files and functions stay small; no new god-objects.

Not your job: test coverage (tests lens), security (security lens), visuals (ui lens).
Severity guide: wrong behaviour → blocker; likely bug or maintainability trap → major; style → nit.
