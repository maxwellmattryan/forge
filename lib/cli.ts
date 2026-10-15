// The `forge` CLI: the only writer of Forge state. Agents and the orchestrator call it
// instead of hand-editing JSON, so data shapes stay valid no matter which model is driving.
// Output is compact JSON (or a terse table for `status`) to keep orchestrator context small.
// Command groups live in lib/commands/; this file only routes.
import path from 'node:path';
import { daemonTrust, loadConfig } from './config.ts';
import { refuseInboxDrive } from './daemon-owner.ts';
import { NEED_INIT } from './config-set.ts';
import { detect } from './detect.ts';
import { doctor } from './doctor.ts';
import { forgeVersion } from './evals.ts';
import { loadJob } from './jobs.ts';
import { mainRoot, PLUGIN_ROOT } from './paths.ts';
import * as pr from './pr.ts';
import { prepareRetro, retroDue } from './retro.ts';
import { roster } from './roster.ts';
import { computeStats } from './stats.ts';
import { ForgeError, readJson, run } from './util.ts';
import * as wt from './worktree.ts';
import { advanceCmd } from './commands/advance.ts';
import { num, out, parseArgs, req, requireJob } from './commands/args.ts';
import { configCmd } from './commands/config.ts';
import { daemonCmd } from './commands/daemon.ts';
import { dash } from './commands/dash.ts';
import { evalCmd } from './commands/eval.ts';
import { gitRead, gitWrite } from './commands/git.ts';
import { initWrite, migrate } from './commands/init.ts';
import { jobCmd } from './commands/job.ts';
import { requestsCmd } from './commands/requests.ts';
import { statsText, statusTable } from './commands/status.ts';
import { nextCmd, syncAll, trackerCmd } from './commands/tracker.ts';
import { updateCmd } from './commands/update.ts';
import type { CliContext, Dispatched } from './types.ts';

const HELP = () => `⚒️  Forge v${forgeVersion()}: a lightweight, self-improving software factory

Usage: forge <command> [options]   (state, worktrees, PRs, trackers, evals, dashboard)

  forge status                       active jobs at a glance (add --all for finished)
  forge next [--claim --session S] [--force]   resume a queued unowned job (with --claim --session), else the next ready tracker item whose job is not blocked (optionally start a job)
  forge job new|from-ref|link|list|show|get|set|claim|release|note|human|agent|round|budget|verdicts|decision|progress|paths|scope|acs|step|advance
  forge job step <id> [--session S]  the job's next action (spawn, run, wait, procedure, done) and the agent brief; read-only, except --session <owner> refreshes its heartbeat
  forge job advance <id> --session S [--max N]  run step's run actions in-process up to the next spawn, wait, procedure or done (at most N commands, default 20)
  forge worktree create|remove|path|prune <id>
  forge run <id> <command> [--background]   forge stop <id>   forge verify <id>
  forge integrate <id> [--strategy merge|rebase] [--keep-conflicts | --continue]
  forge git diff|log|show|range-diff [git args]   read-only git for agents (no --output)
  forge git add <id> -- <path>...    stage paths in the job's worktree
  forge git commit <id> (--message T | --message-file F) [-- <path>...]   commit in the job's worktree, on its branch
  forge pr find|open|sync|merge <id> [--now]   forge sync          reconcile PRs + trackers for all jobs
  forge tracker list|get|search|claim|update|comment|create|close
  forge stats [--since DATE] [--json]  forge roster   forge retro due|prepare <job>
  forge eval list|new|mine|start|grade|runs|compare|report
  forge requests [list|scope|add|claim|ack]
  forge daemon status   forge daemon log <job>|--inbox [--lines N] [--follow]   (the dash session pool)
  forge init detect|write --answers FILE   forge config [show|get PATH|validate]
  forge doctor   forge migrate   forge dash [--background|--stop] [--port N]   forge version
  forge update [--check] [--keep-dash]   update this Forge install (Claude Code plugin or git clone)

Docs: ${path.join(PLUGIN_ROOT, 'docs')}`;

export async function main(argv: string[]): Promise<void> {
  // git's own options pass through untouched, so this runs before Forge's flag parsing. The writing
  // subcommands go through the daemon trust check and config below like any other command.
  if (argv[0] === 'git' && argv[1] !== 'add' && argv[1] !== 'commit') {
    process.exitCode = gitRead(argv.slice(1));
    return;
  }
  const { pos, flags } = parseArgs(argv);
  const [cmd] = pos;
  if (!cmd || cmd === 'help' || flags.help) return out(HELP(), flags);
  if (cmd === 'version') return out({ version: forgeVersion() }, flags);
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
    if (!initialized) throw new ForgeError(NEED_INIT, 2);
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
      throw new ForgeError('usage: forge init detect | forge init write --answers FILE [--force]');
    }
    case 'config':
      configCmd(root, config, initialized, sub, rest, flags);
      return printed;
    case 'doctor':
      return { data: await doctor(root, config, initialized), exitCode: 0, pretty: true };
    case 'status':
      needInit();
      return ok(statusTable(root, Boolean(flags.all)));
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
      throw new ForgeError('usage: forge worktree create|remove|path|prune <id>');
    }
    case 'run': {
      needInit();
      const id = req(sub, 'job id');
      const name = req(rest[0], 'command name');
      const tail = num(flags.tail, '--tail', { integer: true }) ?? 40;
      if (flags.background) return ok(await wt.startBackground(root, config, id, name));
      const r = wt.runCommand(root, config, id, name, { tail });
      return { data: r, exitCode: r.ok ? 0 : 1 };
    }
    case 'stop':
      return ok({ stopped: wt.stopBackground(root, req(sub, 'job id')) });
    case 'verify': {
      needInit();
      const r = wt.verify(root, config, req(sub, 'job id'));
      return { data: r, exitCode: r.ok ? 0 : 1 };
    }
    case 'integrate': {
      needInit();
      const id = req(sub, 'job id');
      const r = flags.continue ? pr.integrateContinue(root, id) : pr.integrate(root, config, id, { strategy: flags.strategy, keepConflicts: Boolean(flags['keep-conflicts']) });
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
        const r = pr.mergePr(root, config, id, { now: flags.now === true });
        return { data: r, exitCode: r.action === 'refused' || r.action === 'failed' ? 1 : 0 };
      }
      throw new ForgeError('usage: forge pr find|open|sync|merge <id> [--now]');
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
    case 'roster':
      return ok(roster(root, config));
    case 'retro': {
      needInit();
      if (sub === 'due') return ok(retroDue(root, config));
      if (sub === 'prepare') return ok(prepareRetro(root, config, requireJob(root, rest[0]).id, { since: flags.since }));
      throw new ForgeError('usage: forge retro due | forge retro prepare <job> [--since DATE]');
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
      return ok(gitWrite(root, config, argv.slice(1)));
    default:
      throw new ForgeError(`unknown command "${cmd}"\n\n${HELP()}`);
  }
}
