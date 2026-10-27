// The `forge` CLI: the only writer of Forge state. Agents and the orchestrator call it
// instead of hand-editing JSON, so data shapes stay valid no matter which model is driving.
// Output is compact JSON (or a terse table for `status`) to keep orchestrator context small: that is
// agent mode. Human mode, for a person at a terminal, renders the same results as text; main()
// resolves the mode once per process (docs/CLI.md "Output mode").
// Command groups live in lib/cli/commands/; this file only routes.
import { daemonTrust, loadConfig } from '#core/config/load.ts';
import { refuseBrokenScope, refuseDaemonMerge, refuseInboxDrive } from '#office/owner.ts';
import { registerNotify } from '#office/notify.ts';
import { mandateRefusal } from '#office/foreman/policy.ts';
import { NEED_INIT } from '#core/config/set.ts';
import { detect } from '#engine/ops/detect.ts';
import { stopBackground } from '#engine/environment/lifecycle.ts';
import { git } from '#integrations/git/runner.ts';
import { loadJob } from '#core/job/store.ts';
import { trustedMemberWorktree } from '#engine/project/job-repos.ts';
import { mainRoot } from '#core/paths.ts';
import { findPr } from '#engine/pr/adopt.ts';
import { openPr } from '#engine/pr/open.ts';
import { syncPr } from '#engine/pr/sync.ts';
import { integrate, integrateContinue } from '#engine/pr/integrate.ts';
import { mergePr, mergeTarget, readyPr } from '#engine/pr/merge.ts';
import { ghGitHub } from '#integrations/github/pull-requests.ts';
import { prepareRetro, retroDue } from '#engine/evals/retro.ts';
import { roster } from '#engine/pipeline/roster.ts';
import { computeStats, statsByPromptCmd, statsCsv } from '#engine/metrics/stats.ts';
import { ForgeError } from '#core/errors.ts';
import { readJson } from '#core/os/fs.ts';
import { createWorktree, removeWorktree } from '#engine/workspace/worktree.ts';
import { verify } from '#engine/verify/gate.ts';
import { advanceCmd } from './commands/advance.ts';
import { agentRunCmd } from './commands/job/agent-run.ts';
import { auditCmd } from './commands/audit.ts';
import { backingCmd } from './commands/backing.ts';
import { budgetCmd } from './commands/budget.ts';
import { environmentCmd } from './commands/environment.ts';
import { num, out, outputMode, parseArgs, req, requireJob, resolveOutputMode, setOutputMode, setRenderKey, withoutJson, withoutMode } from './commands/args.ts';
import { configCmd } from './commands/config.ts';
import { daemonCmd } from './commands/daemon.ts';
import { dash } from './commands/dash.ts';
import { doctorCmd } from './commands/doctor.ts';
import { evalCmd } from './commands/eval.ts';
import { experimentCmd } from './commands/experiment.ts';
import { focusCmd } from './commands/focus.ts';
import { gitRead, gitWrite } from './commands/git.ts';
import { helpCmd, usage } from './commands/help.ts';
import { confirmHuman, mergeNowOp } from './commands/human.ts';
import { initWrite, migrate } from './commands/init.ts';
import { jobCmd, refuseForemanJobCommand } from './commands/job.ts';
import { mandateCmd } from './commands/mandate.ts';
import { chatCmd } from './commands/chat.ts';
import { notifyCmd } from './commands/notify.ts';
import { officeCmd } from './commands/office.ts';
import { projectCmd } from './commands/project.ts';
import { releaseCmd } from './commands/release.ts';
import { requestsCmd } from './commands/requests.ts';
import { runCmd } from './commands/run.ts';
import { secretsCmd } from './commands/secrets.ts';
import { serviceCmd } from './commands/service.ts';
import { verifiersCmd } from './commands/verifiers.ts';
import { renderKey } from './commands/render/registry.ts';
import { statsText, statusRows, statusTable, statusView } from './commands/status.ts';
import { nextCmd, syncAll, trackerCmd } from './commands/tracker.ts';
import { updateCmd } from './commands/update.ts';
import { versionCmd } from './commands/version.ts';
import type { CliContext, Dispatched } from './types.ts';

export { reportError } from './commands/help.ts';

export async function main(rawArgv: string[]): Promise<void> {
  setOutputMode(resolveOutputMode(rawArgv, process.env, process.stdout.isTTY === true));
  // Everything below sees the call as if --mode had never been typed: help, git, run's args.
  const argv = withoutMode(rawArgv);
  const { pos, flags } = parseArgs(argv);
  // The outer call's renderer, chosen here once like the mode: dispatch never sets it.
  setRenderKey(renderKey(pos));
  // Before the git passthrough, so `forge git log --help` never runs `git help` (which can start a
  // configured viewer), and before mainRoot(), so help works outside a repo.
  const dashdash = argv.indexOf('--');
  if (!pos.length || pos[0] === 'help' || (dashdash < 0 ? argv : argv.slice(0, dashdash)).includes('--help')) return helpCmd(pos[0] === 'help' ? pos.slice(1) : pos, flags);
  // git's own options pass through untouched: argv goes to git, not through Forge's flag parsing.
  // Forge's --json is taken out first, so git never sees it. The writing subcommands go through the
  // daemon trust check and config below like any other command.
  const bare = withoutJson(argv);
  if (bare[0] === 'git' && bare[1] !== 'add' && bare[1] !== 'commit') {
    process.exitCode = gitRead(bare.slice(1));
    return;
  }
  const [cmd] = pos;
  if (cmd === 'version') return versionCmd(flags);
  if (cmd === 'update') return updateCmd(flags);
  if (cmd === 'project') return projectCmd(pos.slice(1), flags);
  if (cmd === 'service') return serviceCmd(pos.slice(1), flags);

  let root: string;
  try {
    root = mainRoot();
  } catch (e) {
    // The machine's dashboard serves every registered project, so it opens outside any repo too.
    if (cmd === 'dash' && e instanceof ForgeError && e.code === 'not_a_repo') return dash(null, null, flags);
    throw e;
  }
  let loadOpts: { text?: string | null } = {};
  if (process.env.FORGE_DAEMON === '1') {
    // Before loadConfig, which then parses the checked bytes rather than reading the file again.
    const trust = daemonTrust(root);
    if (trust.problem) throw new ForgeError(trust.problem);
    loadOpts = { text: trust.configText };
  }
  const { config, initialized } = loadConfig(root, loadOpts);
  // Here, not in dispatch, so advance's in-process commands and forgeInProcess never register twice.
  registerNotify();
  const r = await dispatch(argv, { root, config, initialized });
  if (!r.printed) out(r.data, r.pretty ? { ...flags, pretty: true } : flags);
  // Only a failure is written: `config validate` sets process.exitCode itself and returns printed.
  if (r.exitCode) process.exitCode = r.exitCode;
}

/**
 * One command, returned instead of printed, so `forge job advance` can run step's commands
 * in-process. Commands that print for themselves (`config`, `dash`, `daemon log --follow`)
 * return `printed`; advance never runs those (runnableInProcess in lib/cli/commands/advance.ts).
 */
export async function dispatch(argv: string[], ctx: CliContext): Promise<Dispatched> {
  // Never resolves the output mode or the render key: advance runs step's commands here, in-process,
  // and an argv of theirs must not change how the outer call prints.
  const { root, config, initialized } = ctx;
  const { pos, flags } = parseArgs(argv);
  const [cmd, sub, ...rest] = pos;
  if (process.env.FORGE_DAEMON === '1') {
    refuseBrokenScope();
    const rewrite = cmd === 'init' && sub === 'write' ? 'init write' : cmd === 'migrate' ? 'migrate' : cmd === 'config' && sub === 'set' ? 'config set' : null;
    if (rewrite) throw new ForgeError(`forge ${rewrite} rewrites .forge/config.yml, which a daemon session may not do; a human runs it in their own session`);
  }
  const needInit = () => {
    if (!initialized) throw new ForgeError(NEED_INIT, 'not_initialized', '/forge init');
  };
  const ok = (data: unknown): Dispatched => ({ data, exitCode: 0 });
  const printed: Dispatched = { printed: true, exitCode: 0 };

  switch (cmd) {
    case 'init': {
      if (sub === 'detect') return ok(detect(root));
      if (sub === 'write') {
        const answers = flags.answers ? readJson(String(flags.answers)) : {};
        return ok(initWrite(root, answers, Boolean(flags.force)));
      }
      throw usage('init');
    }
    case 'config':
      configCmd(root, config, initialized, sub, rest, flags);
      return printed;
    case 'doctor':
      return doctorCmd(ctx, pos.slice(1), flags);
    case 'status':
      needInit();
      // Reading the mode is safe: status is not in ADVANCE_GROUPS (lib/cli/commands/advance.ts), so it
      // only ever runs as the outer call, whose mode main() set.
      if (flags.json) return ok(statusRows(root, Boolean(flags.all)));
      return ok(outputMode() === 'human' ? statusView(root, Boolean(flags.all)) : statusTable(root, Boolean(flags.all)));
    case 'next':
      needInit();
      return ok(await nextCmd(root, config, flags));
    case 'job':
      needInit();
      if (sub === 'advance') {
        refuseForemanJobCommand(sub);
        return advanceCmd(ctx, rest, flags, dispatch);
      }
      // Like advance, its non-zero exits carry data; `forge job agent <id> run` stays an unknown phase.
      if (sub === 'agent' && rest[0] === 'run') {
        refuseForemanJobCommand(sub);
        return agentRunCmd(ctx, rest.slice(1), flags);
      }
      return ok(await jobCmd(root, config, sub, rest, flags));
    case 'worktree': {
      needInit();
      if (sub === 'create') {
        const id = req(rest[0], 'job id');
        refuseInboxDrive(id);
        const res = createWorktree(root, config, id);
        return { data: res, exitCode: res.repos?.some((r) => !r.ok) ? 1 : 0 };
      }
      const repo = flags.repo === undefined ? undefined : req(typeof flags.repo === 'string' ? flags.repo : undefined, '--repo');
      if (sub === 'remove') {
        const res = await removeWorktree(root, req(rest[0], 'job id'), { deleteBranch: Boolean(flags['delete-branch']), force: Boolean(flags.force), repo });
        return { data: res, exitCode: res.repos?.some((r) => r.error) || res.backing?.ok === false ? 1 : 0 };
      }
      if (sub === 'path') return ok(repo === undefined ? (loadJob(root, req(rest[0], 'job id')).worktree ?? '') : (trustedMemberWorktree(root, config, loadJob(root, req(rest[0], 'job id')), repo) ?? ''));
      if (sub === 'prune') return ok(git(root, ['worktree', 'prune', '-v'], { write: true }).stderr.trim() || 'nothing to prune');
      throw usage('worktree');
    }
    case 'backing':
      needInit();
      return backingCmd(ctx, sub, rest, flags);
    case 'environment':
      needInit();
      return environmentCmd(ctx, sub, rest);
    case 'run':
      needInit();
      return runCmd(root, config, argv);
    case 'stop':
      return ok({ stopped: stopBackground(root, req(sub, 'job id')) });
    case 'focus':
      needInit();
      return ok(await focusCmd(root, config, pos.slice(1), flags));
    case 'verify': {
      needInit();
      const r = await verify(root, config, req(sub, 'job id'));
      return { data: r, exitCode: r.ok ? 0 : 1 };
    }
    case 'secrets':
      needInit();
      return secretsCmd(ctx, sub, rest, flags);
    case 'verifiers':
      // list reads only .forge/verifiers/, so it needs no initialised repo or job.
      if (sub !== 'list') needInit();
      return verifiersCmd(ctx, sub, rest);
    case 'integrate': {
      needInit();
      const id = req(sub, 'job id');
      const r = flags.continue ? integrateContinue(root, config, id) : integrate(root, config, id, { strategy: flags.strategy, keepConflicts: Boolean(flags['keep-conflicts']) });
      return { data: r, exitCode: r.ok ? 0 : 1 };
    }
    case 'pr': {
      needInit();
      // Before the id: `--root <id>` makes parseArgs swallow the id as the flag's value, and a
      // misread merge target must be refused, never guessed.
      if (sub === 'merge') mergeTarget(flags);
      if (sub === 'ready') mergeTarget(flags, 'ready');
      const id = req(rest[0], 'job id');
      if (sub === 'find') return ok(findPr(root, config, ghGitHub, id));
      if (sub === 'open') return ok(openPr(root, config, ghGitHub, id, { title: flags.title, draft: flags.draft === undefined ? undefined : Boolean(flags.draft), force: Boolean(flags.force) }));
      if (sub === 'sync') return ok(await syncPr(root, config, ghGitHub, id, { narrow: (j) => mandateRefusal(root, config, j, 'pr-feedback') }));
      if (sub === 'merge') {
        // Strictly `true`: `--now <id>` would make parseArgs swallow the id as the flag's value,
        // and that mistake must not silently bypass CI.
        refuseDaemonMerge(id, flags);
        // A human-only operation: a person types the id back at this terminal before any gh call.
        const now = flags.now === true ? await confirmHuman(root, mergeNowOp(requireJob(root, id).id)) : undefined;
        const r = await mergePr(root, config, ghGitHub, id, { now, ...mergeTarget(flags) });
        return { data: r, exitCode: r.action === 'refused' || r.action === 'failed' ? 1 : 0 };
      }
      if (sub === 'ready') return ok(readyPr(root, config, ghGitHub, id, mergeTarget(flags, 'ready')));
      throw usage('pr');
    }
    case 'release':
      needInit();
      return releaseCmd(ctx, sub, rest, flags);
    case 'sync':
      needInit();
      return ok(await syncAll(root, config));
    case 'tracker':
      needInit();
      return ok(await trackerCmd(root, config, sub, rest, flags));
    case 'stats': {
      if (flags.by === 'prompt') return ok(statsByPromptCmd(root, config, flags));
      if (flags.csv || flags.by !== undefined) return ok(statsCsv(root, config, flags));
      const s = computeStats(root, { since: flags.since, includeEvals: Boolean(flags['include-evals']), config });
      // Human mode renders the object; safe for the same reason as status (not in ADVANCE_GROUPS).
      return ok(flags.json || outputMode() === 'human' ? s : statsText(s));
    }
    case 'budget':
      needInit();
      return ok(await budgetCmd(root, config, sub, flags));
    case 'audit':
      needInit();
      return ok(auditCmd(root, pos.slice(1), flags));
    case 'roster':
      return ok(roster(root, config));
    case 'retro': {
      needInit();
      if (sub === 'due') return ok(retroDue(root, config));
      if (sub === 'prepare') return ok(prepareRetro(root, config, requireJob(root, rest[0]).id, { since: flags.since }));
      throw usage('retro');
    }
    case 'eval':
      needInit();
      return ok(await evalCmd(root, config, sub, rest, flags));
    case 'experiment':
      needInit();
      return experimentCmd(ctx, sub, rest, flags);
    case 'mandate':
      needInit();
      return mandateCmd(ctx, sub, rest, flags);
    case 'chat':
      needInit();
      return chatCmd(ctx, sub, rest, flags);
    case 'office':
      needInit();
      return officeCmd(ctx, sub, rest, flags);
    case 'requests':
      return ok(requestsCmd(root, config, sub, rest, flags));
    case 'notify':
      needInit();
      return notifyCmd(ctx, sub, rest, flags);
    case 'migrate':
      return ok(migrate(root));
    case 'daemon': {
      const r = await daemonCmd(root, sub, rest, flags);
      // `log --follow` streams to stdout itself and returns nothing.
      return r === undefined ? printed : ok(r);
    }
    case 'dash':
      await dash(root, config, flags, ctx.initialized);
      return printed;
    case 'git':
      needInit();
      return ok(gitWrite(root, config, withoutJson(argv).slice(1)));
    default:
      throw new ForgeError(`unknown command "${cmd}"; run \`forge help\` to list commands`, 'unknown_command', 'forge help');
  }
}
