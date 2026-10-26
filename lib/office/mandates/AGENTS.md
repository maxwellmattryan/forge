# lib/office/mandates/

Mandates: the owner's standing instructions to the Office, one file each in `.forge/runtime/mandates/`, written only by `forge mandate` (`lib/cli/commands/mandate.ts`).

- `store.ts` is the only reader and writer of the files. A file that can't be read safely is unreadable with a `problem`, and nothing acts on it: narrowing fails closed.
- A mandate's `decides` only ever narrows `foreman.decides`: `checkForemanDecision` and `gateOwner` (`lib/office/foreman.ts`) and `forge job assist` read it through `jobMandateDecides`. Engine code can't import this module, so `assistantBrief` takes the mandate as a parameter.
- The body is the owner's free text: it reaches a brief or `forge mandate show` only through `mandateGuidance` (`fenceImport`), never raw.
- Design: [Foreman](../../../docs/architecture/foreman.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `contract.ts` | The mandate contract's rules: the stored shape a file needs to be read, the refusals of `forge mandate new\|edit`, the defaults a new mandate takes, the contract as it applies under the config (what it caps), the derived state and chain, and the guidance and goal fences. |
| `draft.ts` | A goal mandate's milestone draft and its drafting runs' records: the draft rules (draftProblems), the stored `.forge/runtime/mandates/<id>/draft.json` (readDraft, recordDraft), the drafter's staging file under the office session's worktrees root, the draft requests for a mandate, the spend ledger (`ledger.jsonl`), and the status `forge mandate draft show` prints. |
| `intake.ts` | Intake's first CLI call: `forge mandate draft prepare` writes a goal mandate's survey (`.forge/runtime/mandates/<id>/survey.md`, outside every session's write roots) and returns the `forge:drafter` brief. |
| `store.ts` | Mandate files: `.forge/runtime/mandates/<id>.md`, YAML frontmatter then the owner's guidance. |
| `types.ts` | The mandate shapes, type-only: the file `forge mandate` writes, the contract terms, the summary and state the CLI prints, and a goal mandate's milestone draft. |
<!-- forge:map:end -->
