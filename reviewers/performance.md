# Performance lens

**Focus:** does this change make hot paths slower or heavier?

Check:
- Algorithmic complexity on realistic sizes; accidental quadratic loops; N+1 queries.
- Allocations, copies and clones in hot loops; unnecessary serialization.
- Blocking I/O on latency-sensitive threads (UI thread, request handlers, event loops).
- Caching correctness (invalidation) where caching was added.
- Bundle/binary size growth from new dependencies.
- If the repo has benchmarks, the relevant ones were run and results are in build.md.

Severity guide: measurable regression on a hot path → blocker; likely regression → major.
