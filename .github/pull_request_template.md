<!-- One PR per issue, into develop (main takes only the main update and hotfixes). Leave the version fields and CHANGELOG.md alone: the release commit at the end of a wave adds them. Never commit dashboard/dist/: CI builds dashboard/dist/ for the main update. -->

## What changes

<!-- What changes for people using Forge, and why. -->

Closes #

## Verify

Run every command from AGENTS.md "Verify before claiming it works", checking engine changes on Node 22.18 itself:

- [ ] `npm ci`
- [ ] `npm run build:dashboard`
- [ ] `npm run check:dashboard`
- [ ] `npm run typecheck`
- [ ] `node --test "test/*.test.ts"`
- [ ] `for f in bin/forge lib/trackers/status.mjs dashboard/*.mjs; do node --check "$f"; done`
- [ ] `claude plugin validate . --strict`

## Checklist

- [ ] No AI attribution in the commits or in this description
- [ ] No version bump and no CHANGELOG.md entry
- [ ] No `dashboard/dist/` files in the diff
- [ ] README.md, docs/ and skills/forge/ updated where CLI behaviour changed
