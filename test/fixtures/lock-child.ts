// A lock contender for test/lock.test.ts: takes <lockDir> with withLock, appends `enter <tag>` and
// `exit <tag>` around a short sleep to <log>, and prints a timeout to stderr with exit 1.
// Usage: node lock-child.ts <lockDir> <log> <tag> [timeoutMs] [holdMs]
import fs from 'node:fs';
import { sleepSync, withLock } from '../../lib/util.ts';

const [lockDir, log, tag, timeout = '20000', hold = '150'] = process.argv.slice(2);
try {
  withLock(
    lockDir,
    () => {
      fs.appendFileSync(log, `enter ${tag}\n`);
      sleepSync(Number(hold));
      fs.appendFileSync(log, `exit ${tag}\n`);
    },
    { timeoutMs: Number(timeout) },
  );
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
}
