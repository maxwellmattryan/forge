# Testing

A job adds a test per new behaviour, not per acceptance criterion. Extend the nearest existing test or table first, and add a test file only for a new module. A test checks lasting behaviour through a module's public functions or the CLI's JSON. It never checks one job's output, the wording of prompts or docs, markup or class names, or that a removed thing is gone. Several acceptance criteria may share one proof, and an existing test, a command or a manual step is a proof too. Never delete, skip or weaken a test to get green.

## Allowed source-text tests
A test may read source, Svelte, CSS or Markdown text only to hold one of these invariants. Any other source-text test is a `minor` finding for the `tests` lens.

1. `{@html}` takes only the escape-first helpers: `test/dashboard-svelte.test.ts` › "{@html} receives only escape-first builders" and "no raw HTML sinks in dashboard sources".
2. Every i18n key the dashboard uses exists in `en.json`, and components carry no hard-coded user-facing text: `test/dashboard-i18n.test.ts`.
3. The dashboard loads no remote assets: `test/dashboard-assets.test.ts` › "dist loads nothing from another origin".
4. Theme-token colours keep text at 4.5:1 contrast: `test/dashboard-tokens.test.ts` › "text tokens meet 4.5:1 except the documented exceptions", "plates, chrome and sheen keep text at 4.5:1" and "chip tones meet 4.5:1 on bg, panel and chrome".
5. The CI and release workflows stay secure (pinned actions, permissions, masked secrets, where env reaches): `test/ci-workflow.test.ts`, `test/release-workflow.test.ts`, `test/main-update-workflow.test.ts`.
6. Docs stay in sync with code: `test/cli-contract.test.ts` › "README CLI table is generated from the help tables" (`npm run docs:commands`), and `test/config-set.test.ts` (docs/CONFIG.md against `defaults()` and `lib/config-fields.ts`).

A new entry needs a reason a public function or the CLI's JSON can't hold the invariant, and lands in this list in the same change.

## Measuring
To see whether the rule holds, compare a window of job merges on `develop` with the baseline in the PR that added this file. Run from a checkout of `develop`; set `BASE` to the commit the window starts after.

```bash
# The jobs: first-parent merges whose subject ends in (#<n>), without release commits.
# This takes the next 10 after BASE. For the last 30, drop --reverse and "$BASE".. and use head -30.
git log --first-parent --reverse --format='%H %s' "$BASE"..develop \
  | grep -E '\(#[0-9]+\)$' | grep -vE '^[0-9a-f]+ Release ' | head -10 > jobs.txt

while read -r sha _; do
  added=$(git show --format= -U0 "$sha" -- 'test/*.test.ts' | grep -cE '^\+\s*(test|it)\(')
  edited=$(git show --format= --name-status "$sha" -- test/ | grep -c '^M')
  echo "$sha $added $edited"
done < jobs.txt
```

- **Tests added per job**: the second column; report its mean and median.
- **Existing test files edited per job**: the third column; mean and median.
- **Builder minutes per job**: for each job whose dir in `.forge/jobs/` still exists (`job.json` › `pr.number` matches the subject's `#<n>`), sum the time from each `agent-start` to the next `agent-end` with `role: builder` in its `events.jsonl`. Report the median and how many jobs were measured: done jobs are pruned, so coverage is partial.
- **`tests` lens findings per reviewed job**: count the severity-tagged findings in `.forge/jobs/<job>/review/round-*/tests.md`. Report how many jobs had a `tests` lens; a panel without one gives no coverage.

Check `forge stats --json` first and use any field that already reports one of these.
