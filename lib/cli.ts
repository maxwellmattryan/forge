// The `forge` CLI: the only writer of Forge state. Agents and the orchestrator call it
// instead of hand-editing JSON, so data shapes stay valid no matter which model is driving.
// Output is compact JSON (or a terse table for `status`) to keep orchestrator context small.
// Command groups live in lib/commands/; this file only routes.
import { daemonTrust, loadConfig } from './config.ts';
import { refuseInOffice, refuseInboxDrive } from './daemon-owner.ts';
import { NEED_INIT } from './config-set.ts';
import { detect } from './detect.ts';
import { doctor } from './doctor.ts';
import { loadJob } from './jobs.ts';
import { mainRoot } from './paths.ts';
import * as pr from './pr.ts';
import { prepareRetro, retroDue } from './retro.ts';
import { roster } from './roster.ts';
import { computeStats } from './stats.ts';
import { ForgeError, readJson, run } from './util.ts';
import * as wt from './worktree.ts';
import { advanceCmd } from './commands/advance.ts';
import { auditCmd } from './commands/audit.ts';
import { num, out, parseArgs, req, requireJob, withoutJson } from './commands/args.ts';
import { configCmd } from './commands/config.ts';
import { daemonCmd } from './commands/daemon.ts';
import { dash } from './commands/dash.ts';
import { evalCmd } from './commands/eval.ts';
import { gitRead, gitWrite } from './commands/git.ts';
import { helpCmd, usage } from './commands/help.ts';
import { initWrite, migrate } from './commands/init.ts';
import { jobCmd } from './commands/job.ts';
import { requestsCmd } from './commands/requests.ts';
import { runCmd } from './commands/run.ts';
import { secretsCmd } from './commands/secrets.ts';
import { statsText, statusRows, statusTable } from './commands/status.ts';
import { nextCmd, syncAll, trackerCmd } from './commands/tracker.ts';
import { updateCmd } from './commands/update.ts';
import { versionCmd } from './commands/version.ts';
import type { CliContext, Dispatched } from './types.ts';

export { reportError } from './commands/help.ts';

export async function main(argv: string[]): Promise<void> {
  const { pos, flags } = parseArgs(argv);
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

  const root = mainRoot();
  let loadOpts: { text?: string | null } = {};
  if (process.env.FORGE_DAEMON === '1') {
    // Before loadConfig, which then parses the checked bytes rather than reading the file again.
    const trust = daemonTrust(root);
    if (trust.problem) throw new ForgeError(trust.problem);
    loadOpts = { text: trust.configText };
  }
  const { config, initialized } = loadConfig(root, loadOpts);
  const r = await dispatch(argv, { root, config, initialized });
  if (!r.printed) out(r.data, r.pretty ? { ...flags, pretty: true } : flags);
  // Only a failure is written: `config validate` sets process.exitCode itself and returns printed.
  if (r.exitCode) process.exitCode = r.exitCode;
}

/**
 * One command, returned instead of printed, so `forge job advance` can run step's commands
 * in-process. Commands that print for themselves (`config`, `dash`, `daemon log --follow`)
 * return `printed`; advance never runs those (runnableInProcess in lib/commands/advance.ts).
 */
export async function dispatch(argv: string[], ctx: CliContext): Promise<Dispatched> {
  const { root, config, initialized } = ctx;
  const { pos, flags } = parseArgs(argv);
  const [cmd, sub, ...rest] = pos;
  if (process.env.FORGE_DAEMON === '1') {
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
      return { data: await doctor(root, config, initialized), exitCode: 0, pretty: true };
    case 'status':
      needInit();
      return ok(flags.json ? statusRows(root, Boolean(flags.all)) : statusTable(root, Boolean(flags.all)));
    case 'next':
      needInit();
      return ok(await nextCmd(root, config, flags));
    case 'job':
      needInit();
      if (sub === 'advance') return advanceCmd(ctx, rest, flags, dispatch);
      return ok(await jobCmd(root, config, sub, rest, flags));
    case 'worktree': {
      needInit();
      if (sub === 'create') {
        const id = req(rest[0], 'job id');
        refuseInboxDrive(id);
        return ok(wt.createWorktree(root, config, id));
      }
      if (sub === 'remove') return ok(wt.removeWorktree(root, req(rest[0], 'job id'), { deleteBranch: Boolean(flags['delete-branch']), force: Boolean(flags.force) }));
      if (sub === 'path') return ok(loadJob(root, req(rest[0], 'job id')).worktree ?? '');
      if (sub === 'prune') return ok(run('git', ['worktree', 'prune', '-v'], { cwd: root }).stderr.trim() || 'nothing to prune');
      throw usage('worktree');
    }
    case 'run':
      needInit();
      return runCmd(root, config, argv);
    case 'stop':
      return ok({ stopped: wt.stopBackground(root, req(sub, 'job id')) });
    case 'verify': {
      needInit();
      const r = await wt.verify(root, config, req(sub, 'job id'));
      return { data: r, exitCode: r.ok ? 0 : 1 };
    }
    case 'secrets':
      needInit();
      return secretsCmd(ctx, sub, rest, flags);
    case 'integrate': {
      needInit();
      const id = req(sub, 'job id');
      const r = flags.continue ? pr.integrateContinue(root, config, id) : pr.integrate(root, config, id, { strategy: flags.strategy, keepConflicts: Boolean(flags['keep-conflicts']) });
      return { data: r, exitCode: r.ok ? 0 : 1 };
    }
    case 'pr': {
      needInit();
      const id = req(rest[0], 'job id');
      if (sub === 'find') return ok(pr.findPr(root, config, id));
      if (sub === 'open') return ok(pr.openPr(root, config, id, { title: flags.title, draft: flags.draft === undefined ? undefined : Boolean(flags.draft), force: Boolean(flags.force) }));
      if (sub === 'sync') return ok(pr.syncPr(root, config, id));
      if (sub === 'merge') {
        // Strictly `true`: `--now <id>` would make parseArgs swallow the id as the flag's value,
        // and that mistake must not silently bypass CI.
        refuseInOffice('the foreman never merges; foreman.ship merge only feeds the approver and step PR4');
        const r = pr.mergePr(root, config, id, { now: flags.now === true });
        return { data: r, exitCode: r.action === 'refused' || r.action === 'failed' ? 1 : 0 };
      }
      throw usage('pr');
    }
    case 'sync':
      needInit();
      return ok(await syncAll(root, config));
    case 'tracker':
      needInit();
      return ok(await trackerCmd(root, config, sub, rest, flags));
    case 'stats': {
      const s = computeStats(root, { since: flags.since, includeEvals: Boolean(flags['include-evals']) });
      return ok(flags.json ? s : statsText(s));
    }
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
    case 'requests':
      return ok(requestsCmd(root, config, sub, rest, flags));
    case 'migrate':
      return ok(migrate(root));
    case 'daemon': {
      const r = await daemonCmd(root, sub, rest, flags);
      // `log --follow` streams to stdout itself and returns nothing.
      return r === undefined ? printed : ok(r);
    }
    case 'dash':
      await dash(root, config, flags);
      return printed;
    case 'git':
      needInit();
      return ok(gitWrite(root, config, withoutJson(argv).slice(1)));
    default:
      throw new ForgeError(`unknown command "${cmd}"; run \`forge help\` to list commands`, 'unknown_command', 'forge help');
  }
}
