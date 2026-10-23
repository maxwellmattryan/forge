# Baseline counts

At `tests-before-rewrite` (`719783b0`, develop after #446).

| Measure | Value |
|---|---|
| Test files (`test/**/*.test.ts`) | 218 |
| `it(`/`test(` calls with a title | 1,960 |
| Lines in test files | 61,580 |
| Lines in all of `test/` (`.ts`, `.mjs`, helpers and fixtures included) | 65,406 |
| Lines in `lib/**/*.ts`, for comparison | 48,769 |
| Test files that spawn anything (`forgeAsync`, `forgeSync`, `spawn`, `execFile`) | 128 |
| …of which start the CLI (`forgeAsync`/`forgeSync`) | 67 |
| Local wall time (`npm run test:times`, Node v26.3.0, load 3.63, see `times.txt`) | 283.3 s |
| CI wall time, last green develop run (`719783b0`, 4 shards on 2 Node versions) | 6 m 14 s |
| Line coverage (`npm run coverage`, `lib/` and `dashboard/src/lib/`) | 99.6% (51,340/51,535), see `coverage.txt` |

## After the teardown

| Measure | Value |
|---|---|
| Test files (`test/**`, `lib/**`, `dashboard/src/**` `*.test.ts`) | 30 (25 under `test/`, 5 beside their modules) |
| `it(`/`test(` calls with a title | 123 (the suite runs 710 tests: 552 are rows `test/step.test.ts` generates) |
| Lines in test files | 4,503 |
| Lines in all of `test/` (kept fixtures and helpers included) | 7,830 |
| Test files that spawn anything | 10 |
| Local wall time (`npm run test:times`, Node v26.3.0, load 5.94, see `times-after-teardown.txt`) | 8.2 s |
| Line coverage (`coverage-after-teardown.txt`) | 94.3% (43,351/45,972) of the 214 files the kept tests still load; the 55 files no kept test loads are absent from the report, not counted as 0% |
