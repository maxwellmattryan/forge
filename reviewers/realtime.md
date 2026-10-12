# Realtime-safety lens (audio / embedded / low-latency)

**Focus:** nothing on the realtime path may block, allocate or take unbounded time.

Check every function reachable from the realtime callback (audio process, ISR, frame loop):
- No heap allocation (Vec growth, Box/String creation, collect, format!, clone of heap types).
- No locks or blocking primitives (Mutex, RwLock, channels that block, condvars); atomics only.
- No syscalls, file or network I/O, logging that allocates, or panics/unwraps on reachable paths.
- Bounded loops; no recursion of unbounded depth; denormals handled where relevant.
- Work that can be precomputed is done in prepare/init, not per block.
- Parameter changes are smoothed; no zipper noise from instant jumps.

Any violation is a blocker. If the repo ships a dedicated realtime-safety agent or checklist, defer to it.
