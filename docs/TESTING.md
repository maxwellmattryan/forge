# Testing

A job adds a test per new behaviour, not per acceptance criterion. Extend the nearest existing test or table first, and add a test file only for a new module. A test checks lasting behaviour through a module's public functions or the CLI's JSON. It never checks one job's output, the wording of prompts or docs, markup or class names, or that a removed thing is gone. Several acceptance criteria may share one proof, and an existing test, a command or a manual step is a proof too. Never delete, skip or weaken a test to get green.

## Allowed source-text tests
A test may read source, Svelte, CSS or Markdown text only to hold one of these invariants. Any other source-text test is a `minor` finding for the `tests` lens.

Entries 1-4 and 7 live in one file, `test/dashboard-invariants.test.ts`.

1. `{@html}` takes only the escape-first helpers, and the markup has no other HTML or URL sink: "{@html} receives only escape-first builders", "the {@html} guard rejects anything but one whole builder call", "no raw HTML sinks in dashboard sources", "mockups render only in the sandboxed /raw iframe", "dynamic URLs go through safeUrl" and "the URL guard rejects shorthand, spreads and unchecked src/action/formaction/xlink:href".
2. Every i18n key the dashboard uses exists in `en.json`, and components carry no hard-coded user-facing text: "en.json is a catalog of strings and plural objects, and every message is used", "components carry no hard-coded user-facing text" and "the text guard catches what it should".
3. The dashboard loads no remote assets: "dist loads nothing from another origin".
4. Theme-token colours keep text at 4.5:1 contrast: "text tokens meet 4.5:1 except the documented exceptions", "plates, chrome and sheen keep text at 4.5:1" and "chip tones meet 4.5:1 on bg, panel and chrome".
5. The CI and release workflows stay secure: `test/ci-workflow.test.ts`, `test/release-workflow.test.ts` and `test/main-update-workflow.test.ts`, through the shared `test/workflow-lint.ts` (actions pinned to a SHA, least `permissions`, no persisted checkout credentials, a credential only in the `env` or `with` of the step that uses it, no expression in a `run:` script, no fork trigger, no dependency cache). Each test also holds which refs reach its workflow: release only from a push to `main` after `verify`, the main-update build only from `develop`. `test/ci-workflow.test.ts` also holds that CI runs the AGENTS.md verify list in order and that the runtime audit blocks.
6. Docs stay in sync with code: `test/cli-contract.test.ts` › "README CLI table is generated from the help tables" (`npm run docs:commands`), `test/config-set.test.ts` (docs/CONFIG.md against `defaults()` and `lib/config-fields.ts`), `test/version.test.ts` › "deprecated config keys" (docs/CONFIG.md against the deprecated-key registry), `test/docs-glossary.test.ts` › "config keys exist or are marked planned", `test/findings.test.ts` › "builder prompt example parses" (the `Findings addressed` format `agents/builder.md` teaches is the one `parseAddressed` reads), and `test/governance.test.ts` (relative links and anchors resolve, the PR template mirrors the verify list, CODEOWNERS names files that exist, issue forms are what GitHub accepts, no AI attribution lines).
7. Segments, nav links and icon-only buttons stay accessible: "segments and nav expose their selected state", "every icon-only button has a tooltip and a label" and "the icon-button sweep finds a planted button without a tooltip". Tests can't render a `.svelte` component, so only its markup can hold this.
8. The engine compiles strict and erasable-only: `test/engine-ts.test.ts` › "engine tsconfig is strict and erasable-only" reads `tsconfig.json`'s `strict` and `erasableSyntaxOnly`. No public function exposes the compiler flags.
9. Agents that read untrusted text keep their tool limits: `test/foreman.test.ts` › "assistant agent has no Bash" and `test/roster.test.ts`'s triage check read the `disallowedTools` frontmatter of `agents/assistant.md` and `agents/triage.md`, which Claude Code enforces and no Forge function reads.

A new entry needs a reason a public function or the CLI's JSON can't hold the invariant, and lands in this list in the same change.

## Coverage
`npm run coverage` runs the whole suite under Node's built-in coverage and writes one line per `lib/` and `dashboard/src/lib/` file (path, line %, lines hit/found) and a total to `node_modules/.cache/forge/coverage.txt`. Its exit status is the test run's. A change that deletes or rewrites tests runs it before and after: no file's line coverage may drop more than 1 percentage point. Where one does, add a small test of that file's public function in the nearest existing test file. Code reached only through a spawned `bin/forge` may count low; the rule compares the same tool before and after, so that cancels out.

## Measuring
To see whether the rule holds, compare a window of job merges on `develop` with the baseline in the PR that added this file. Run from a checkout of `develop`; set `BASE` to the commit the window starts after.

```bash
# The jobs: first-parent merges whose subject ends in (#<n>), without release commits ("Release 0.18.7 …").
# This takes the next 10 after BASE. For the last 30, drop --reverse and "$BASE".. and use head -30.
git log --first-parent --reverse --format='%H %s' "$BASE"..develop \
  | grep -E '\(#[0-9]+\)$' | grep -vE '^[0-9a-f]+ Release v?[0-9]+\.[0-9]+\.[0-9]+' | head -10 > jobs.txt

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
