# lib/office/foreman/runs/

The office runs: forge dash's office runner, which runs each `draft` and `direct` request in code, one at a time, with the CLI steps as children and one-shot model children for the drafter, the surveyors and at most one director call. No session serves `_office` any more.

- An office run never leaves a request claimed: a failure requeues it through `requeueOrphanedRequests` (counted, once, then `REQUEUE_REJECTED`), a stop, a usage limit, a refused launch or the office cap gives it back with `releaseClaim` (not counted). Steps end a run early only by throwing `GiveBack` or `RunFailed` (`steps.ts`).
- A run's CLI argv comes only from `officeArgv`'s seven fixed commands (`cli.ts`): ids are pattern-checked, positionals go after `--`, and a reason is one cleaned `--reason=` word. Model output reaches argv only as a ref that exactly matches a survey candidate (`parseDirect`).
- Every child of a run, CLI or model, gets `FORGE_DAEMON=1`, scope `_office` and the pool's trust digest, so the CLI's office refusals apply. Model children run under `dontAsk` with Bash denied; only the drafter has a write root, the drafts dir computed in-process (`draftsDir`).
- No start, resume or note runs until every model child of the run has ended (`direct.ts`), and the director's reply decides only through `parseDirect`'s strict `DIRECT:` line: an unparseable reply starts nothing.
- The log (`_office.log`) carries events and cut reasons only, never claude's text or a CLI child's stdout.
- Design: [Foreman](../../../../docs/architecture/foreman.md) › Office runs, [Daemon](../../../../docs/architecture/daemon.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `child.ts` | One model child of an office run: a headless `claude -p --agent forge:<drafter\|surveyor\|director>` with its brief as the only stdin message (runRoleChild), started after the same launch checks as a session's, under `--permission-mode dontAsk` with Bash denied, its own tools and write roots, scope `_office` and `--max-budget-usd` set to what is left of the office's daily cap. |
| `cli.ts` | An office run's CLI children: the seven fixed `forge` commands it may run (officeArgv), each checked word by word so no id, ref or reason reads as an option, the child itself (`process.execPath bin/forge …` in the repo, with stdout kept: runOfficeCli), how its exit and JSON are read (officeCliResult), and the env every child of the run gets (officeChildEnv): the daemon marker, scope `_office` and the pool's trust digest, so the CLI's office refusals apply. |
| `direct.ts` | A direct office run: `forge office survey`, then with surveyors on a board and a forge:surveyor per mandate with work in flight (all at once), then the plan (./plan.ts): mandates code decides, and at most one forge:director call for the rest. |
| `draft.ts` | A draft office run: `forge mandate draft prepare` as a CLI child, one forge:drafter model child on prepare's brief, model and effort whose only write root is the drafts dir, then `forge mandate draft record` with the drafter's session id as its agent id. |
| `plan.ts` | A direct office run's pure planning: the survey read defensively, the surveyors' SURVEY: lines, which mandates code decides and which the one director call is asked about, the director's brief, and the strict parser over its DIRECT: line. |
| `runner.ts` | forge dash's office runner: runs each pending `draft` or `direct` request in code, one office run at a time, as the Foreman, with the CLI steps as children (./cli.ts) and one-shot model children (./child.ts) for the drafter, the surveyors and at most one director call. |
| `steps.ts` | What an office run's steps share: the deps the runner hands a draft or direct run (its CLI and model children, its log), how a run ends (its ack and outcome), and the two ways a step ends it early, a claim given back uncounted (GiveBack) or a counted failure (RunFailed). |
<!-- forge:map:end -->
