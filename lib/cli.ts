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
import { out, parseArgs, req } from './commands/args.ts';
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

const HELP = () => `⚒️  Forge v${forgeVersion()}: a lightweight, self-improving software factory

Usage: forge <command> [options]   (state, worktrees, PRs, trackers, evals, dashboard)

  forge status                       active jobs at a glance (add --all for finished)
  forge next [--claim --session S] [--force]   next ready tracker item whose job is not blocked (optionally start a job)
  forge job new|from-ref|link|list|show|get|set|claim|release|note|human|agent|round|budget|verdicts|decision|progress|paths|scope|acs|step
  forge job step <id>                the job's next action (spawn, run, wait, procedure, done) and the agent brief; read-only
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
  const [cmd, sub, ...rest] = pos;
  if (!cmd || cmd === 'help' || flags.help) return out(HELP(), flags);
  if (cmd === 'version') return out({ version: forgeVersion() }, flags);
  if (cmd === 'update') return updateCmd(flags);

  const root = mainRoot();
  let loadOpts: { text?: string | null } = {};
  if (process.env.FORGE_DAEMON === '1') {
    // Before loadConfig, which then parses the checked bytes rather than reading the file again.
    const trust = daemonTrust(root);
    if (trust.problem) throw new ForgeError(trust.problem);
    const rewrite = cmd === 'init' && sub === 'write' ? 'init write' : cmd === 'migrate' ? 'migrate' : cmd === 'config' && sub === 'set' ? 'config set' : null;
    if (rewrite) throw new ForgeError(`forge ${rewrite} rewrites .forge/config.yml, which a daemon session may not do; a human runs it in their own session`);
    loadOpts = { text: trust.configText };
  }
  const { config, initialized } = loadConfig(root, loadOpts);
  const needInit = () => {
    if (!initialized) throw new ForgeError(NEED_INIT, 2);
  };

  switch (cmd) {
    case 'init': {
      if (sub === 'detect') return out(detect(root), flags);
      if (sub === 'write') {
        const answers = flags.answers ? readJson(String(flags.answers)) : {};
        return out(initWrite(root, answers, Boolean(flags.force)), flags);
      }
      throw new ForgeError('usage: forge init detect | forge init write --answers FILE [--force]');
    }
    case 'config':
      return configCmd(root, config, initialized, sub, rest, flags);
    case 'doctor':
      return out(await doctor(root, config, initialized), { ...flags, pretty: true });
    case 'status':
      needInit();
      return out(statusTable(root, Boolean(flags.all)), flags);
    case 'next':
      needInit();
      return out(await nextCmd(root, config, flags), flags);
    case 'job':
      needInit();
      return out(await jobCmd(root, config, sub, rest, flags), flags);
    case 'worktree': {
      needInit();
      if (sub === 'create') {
        const id = req(rest[0], 'job id');
        refuseInboxDrive(id);
        return out(wt.createWorktree(root, config, id), flags);
      }
      if (sub === 'remove') return out(wt.removeWorktree(root, req(rest[0], 'job id'), { deleteBranch: Boolean(flags['delete-branch']), force: Boolean(flags.force) }), flags);
      if (sub === 'path') return out(loadJob(root, req(rest[0], 'job id')).worktree ?? '', flags);
      if (sub === 'prune') return out(run('git', ['worktree', 'prune', '-v'], { cwd: root }).stderr.trim() || 'nothing to prune', flags);
      throw new ForgeError('usage: forge worktree create|remove|path|prune <id>');
    }
    case 'run': {
      needInit();
      const id = req(sub, 'job id');
      const name = req(rest[0], 'command name');
      if (flags.background) return out(await wt.startBackground(root, config, id, name), flags);
      const r = wt.runCommand(root, config, id, name, { tail: Number(flags.tail ?? 40) });
      out(r, flags);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case 'stop':
      return out({ stopped: wt.stopBackground(root, req(sub, 'job id')) }, flags);
    case 'verify': {
      needInit();
      const r = wt.verify(root, config, req(sub, 'job id'));
      out(r, flags);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case 'integrate': {
      needInit();
      const id = req(sub, 'job id');
      const r = flags.continue ? pr.integrateContinue(root, id) : pr.integrate(root, config, id, { strategy: flags.strategy, keepConflicts: Boolean(flags['keep-conflicts']) });
      out(r, flags);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case 'pr': {
      needInit();
      const id = req(rest[0], 'job id');
      if (sub === 'find') return out(pr.findPr(root, config, id), flags);
      if (sub === 'open') return out(pr.openPr(root, config, id, { title: flags.title, draft: flags.draft === undefined ? undefined : Boolean(flags.draft), force: Boolean(flags.force) }), flags);
      if (sub === 'sync') return out(pr.syncPr(root, config, id), flags);
      if (sub === 'merge') {
        // Strictly `true`: `--now <id>` would make parseArgs swallow the id as the flag's value,
        // and that mistake must not silently bypass CI.
        const r = pr.mergePr(root, config, id, { now: flags.now === true });
        out(r, flags);
        if (r.action === 'refused' || r.action === 'failed') process.exitCode = 1;
        return;
      }
      throw new ForgeError('usage: forge pr find|open|sync|merge <id> [--now]');
    }
    case 'sync':
      needInit();
      return out(await syncAll(root, config), flags);
    case 'tracker':
      needInit();
      return out(await trackerCmd(root, config, sub, rest, flags), flags);
    case 'stats': {
      const s = computeStats(root, { since: flags.since, includeEvals: Boolean(flags['include-evals']) });
      return out(flags.json ? s : statsText(s), flags);
    }
    case 'roster':
      return out(roster(root, config), flags);
    case 'retro': {
      needInit();
      if (sub === 'due') return out(retroDue(root, config), flags);
      if (sub === 'prepare') return out(prepareRetro(root, config, req(rest[0], 'retro job id'), { since: flags.since }), flags);
      throw new ForgeError('usage: forge retro due | forge retro prepare <job> [--since DATE]');
    }
    case 'eval':
      needInit();
      return out(await evalCmd(root, config, sub, rest, flags), flags);
    case 'requests':
      return out(requestsCmd(root, config, sub, rest, flags), flags);
    case 'migrate':
      return out(migrate(root), flags);
    case 'daemon': {
      const r = await daemonCmd(root, sub, rest, flags);
      // `log --follow` streams to stdout itself and returns nothing.
      if (r !== undefined) out(r, flags);
      return;
    }
    case 'dash':
      return dash(root, config, flags);
    case 'git':
      needInit();
      return out(gitWrite(root, config, argv.slice(1)), flags);
    default:
      throw new ForgeError(`unknown command "${cmd}"\n\n${HELP()}`);
  }
}
