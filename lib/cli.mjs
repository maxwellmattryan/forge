// @ts-check
// The `forge` CLI: the only writer of Forge state. Agents and the orchestrator call it
// instead of hand-editing JSON, so data shapes stay valid no matter which model is driving.
// Output is compact JSON (or a terse table for `status`) to keep orchestrator context small.
// Command groups live in lib/commands/; this file only routes.
import path from 'node:path';
import { loadConfig, validateConfig } from './config.mjs';
import { detect } from './detect.mjs';
import { forgeVersion } from './evals.mjs';
import { loadJob } from './jobs.mjs';
import { mainRoot, PLUGIN_ROOT } from './paths.mjs';
import * as pr from './pr.mjs';
import { prepareRetro, retroDue } from './retro.mjs';
import { roster } from './roster.mjs';
import { computeStats } from './stats.mjs';
import { ForgeError, getPath, readJson, run } from './util.mjs';
import * as wt from './worktree.mjs';
import { out, parseArgs, req } from './commands/args.mjs';
import { dash } from './commands/dash.mjs';
import { evalCmd } from './commands/eval.mjs';
import { doctor, initWrite, migrate } from './commands/init.mjs';
import { jobCmd } from './commands/job.mjs';
import { requestsCmd } from './commands/requests.mjs';
import { statsText, statusTable } from './commands/status.mjs';
import { nextCmd, syncAll, trackerCmd } from './commands/tracker.mjs';

const HELP = () => `⚒️  Forge v${forgeVersion()}: a lightweight, self-improving software factory

Usage: forge <command> [options]   (state, worktrees, PRs, trackers, evals, dashboard)

  forge status                       active jobs at a glance (add --all for finished)
  forge next [--claim --session S]   next ready tracker item (optionally start a job for it)
  forge job new|from-ref|list|show|get|set|claim|release|note|human|agent|round|budget|verdicts|decision|progress|paths|scope
  forge worktree create|remove|path|prune <id>
  forge run <id> <command> [--background]   forge stop <id>   forge verify <id>
  forge integrate <id> [--strategy merge|rebase]
  forge pr find|open|sync|merge <id>   forge sync          reconcile PRs + trackers for all jobs
  forge tracker list|get|claim|update|comment|create|close
  forge stats [--since DATE] [--json]  forge roster   forge retro due|prepare <job>
  forge eval list|new|mine|start|grade|runs|compare|report
  forge requests [list|add|claim|ack]
  forge init detect|write --answers FILE   forge config [show|get PATH|validate]
  forge doctor   forge migrate   forge dash [--background|--stop] [--port N]   forge version

Docs: ${path.join(PLUGIN_ROOT, 'docs')}`;

/** @param {string[]} argv */
export async function main(argv) {
  const { pos, flags } = parseArgs(argv);
  const [cmd, sub, ...rest] = pos;
  if (!cmd || cmd === 'help' || flags.help) return out(HELP(), flags);
  if (cmd === 'version') return out({ version: forgeVersion() }, flags);

  const root = mainRoot();
  const { config, initialized } = loadConfig(root);
  const needInit = () => {
    if (!initialized) throw new ForgeError('this repo has no .forge/config.yml yet; run `/forge init` (or `forge init write --answers FILE`)', 2);
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
    case 'config': {
      if (!sub || sub === 'show') return out(config, { ...flags, pretty: true });
      if (sub === 'get') return out(getPath(config, rest[0] ?? '') ?? null, flags);
      if (sub === 'validate') {
        const problems = validateConfig(config, root);
        out({ ok: !problems.length, initialized, problems }, flags);
        if (problems.length) process.exitCode = 1;
        return;
      }
      throw new ForgeError('usage: forge config [show|get PATH|validate]');
    }
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
      if (sub === 'create') return out(wt.createWorktree(root, config, req(rest[0], 'job id')), flags);
      if (sub === 'remove') return out(wt.removeWorktree(root, req(rest[0], 'job id'), { deleteBranch: Boolean(flags['delete-branch']), force: Boolean(flags.force) }), flags);
      if (sub === 'path') return out(loadJob(root, req(rest[0], 'job id')).worktree ?? '', flags);
      if (sub === 'prune') return out(run('git', ['worktree', 'prune', '-v'], { cwd: root }).stderr.trim() || 'nothing to prune', flags);
      throw new ForgeError('usage: forge worktree create|remove|path|prune <id>');
    }
    case 'run': {
      needInit();
      const id = req(sub, 'job id');
      const name = req(rest[0], 'command name');
      if (flags.background) return out(wt.startBackground(root, config, id, name), flags);
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
      const r = pr.integrate(root, config, req(sub, 'job id'), { strategy: flags.strategy });
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
      if (sub === 'merge') return out(pr.mergePr(root, config, id), flags);
      throw new ForgeError('usage: forge pr find|open|sync|merge <id>');
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
    case 'dash':
      return dash(root, config, flags);
    default:
      throw new ForgeError(`unknown command "${cmd}"\n\n${HELP()}`);
  }
}
