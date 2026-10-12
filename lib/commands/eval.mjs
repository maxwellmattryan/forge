// @ts-check
import * as evals from '../evals.mjs';
import { ForgeError } from '../util.mjs';
import { bodyFrom, list, req } from './args.mjs';

/** @param {string} root @param {any} config @param {string|undefined} sub @param {string[]} rest @param {Record<string, any>} flags */
export async function evalCmd(root, config, sub, rest, flags) {
  switch (sub) {
    case 'list':
      return evals.listTasks(root).map(({ dir: _d, request: _r, ...t }) => t);
    case 'new':
      return evals.createTask(root, req(rest[0], 'name'), flags.title ?? rest[0], bodyFrom(flags) || req(flags.request, '--request or --body-file'));
    case 'mine':
      return evals.mineFromPr(root, config, Number(req(flags.pr, '--pr')), { name: flags.name, testPattern: flags['test-pattern'] });
    case 'start':
      return evals.startRun(root, config, { tasks: list(flags.tasks), tags: list(flags.tags), label: flags.label });
    case 'grade':
      return evals.gradeJob(root, config, req(rest[0], 'job id'));
    case 'runs':
      return evals.listRuns(root).map((r) => ({ id: r.id, label: r.label, status: r.status, configHash: r.configHash, forgeVersion: r.forgeVersion, summary: r.summary }));
    case 'report': {
      const r = evals.listRuns(root).find((x) => x.id === req(rest[0], 'run id'));
      if (!r) throw new ForgeError(`no run ${rest[0]}`);
      return r;
    }
    case 'compare':
      return evals.compareRuns(root, req(rest[0], 'run A'), req(rest[1], 'run B'));
    default:
      throw new ForgeError('usage: forge eval list|new|mine|start|grade|runs|report|compare');
  }
}
