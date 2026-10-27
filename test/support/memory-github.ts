// An in-memory GitHub for in-process PR tests: the GitHub adapter lib/engine/pr/ takes, over records
// shaped like gh's JSON. Reads go through the parsers the gh adapter uses, so a test plants hostile or
// missing fields with put() and exercises the real validation. No process, PATH or env is touched, so
// tests that use it can run concurrently. Spawned CLIs can't take it: they use fakeGh.
import fs from 'node:fs';
import { ForgeError } from '#core/errors.ts';
import { parseClosing, parseFeedback, parsePr, parsePrBody, parseRun } from '#integrations/github/pull-requests.ts';
import { parseHeadChecks } from '#integrations/github/protection.ts';
import type { BranchRules, GitHub } from '#integrations/github/types.ts';

/** One adapter call as the memory GitHub saw it. */
export interface GitHubCall {
  op: keyof GitHub;
  slug?: string;
  number?: number;
  [arg: string]: unknown;
}

/** A complete same-repo PR record as gh prints it: #7, OPEN, forge/x → main, a 40-hex head, an empty rollup. */
export function ghPr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    state: 'OPEN',
    isDraft: false,
    isCrossRepository: false,
    headRefName: 'forge/x',
    baseRefName: 'main',
    headRefOid: 'a'.repeat(40),
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    statusCheckRollup: [],
    mergedAt: null,
    ...overrides,
  };
}

export interface MemoryGitHub extends GitHub {
  /** Stores a gh-JSON-shaped record exactly as given, keyed by its `number`. */
  put(raw: Record<string, unknown>, slug?: string): void;
  patch(number: number, fields: Record<string, unknown>, slug?: string): void;
  /** GitHub's GraphQL `pullRequest` node (reviewThreads, reviews, comments) for PR `number`. */
  setFeedback(number: number, pullRequestNode: unknown, slug?: string): void;
  /** GitHub's closedByPullRequestsReferences nodes for issue `issue`. */
  setClosing(issue: number, nodes: unknown, slug?: string): void;
  /** What branchRules answers for `base` (else every check optional: read, no checks, no reviews). */
  setBranchRules(base: string, rules: BranchRules, slug?: string): void;
  /** HEAD_CHECKS_QUERY's raw `.data` for commit `sha`, read through parseHeadChecks (else no checks, complete). */
  setHeadChecks(sha: string, data: unknown, slug?: string): void;
  /** `gh run view`'s JSON for workflow run `run`, read through parseRun (else viewRun throws `external`). rerunFailed never changes it or the rollup. */
  setRun(run: string, raw: unknown, slug?: string): void;
  /** Every later call of `op` fails with `error` (null clears it): reads and edits throw, merge and rerunFailed return it, branchRules answers unavailable. */
  fail(op: keyof GitHub, error: string | null): void;
  /** The raw record stored for PR `number`. */
  record(number: number, slug?: string): Record<string, unknown> | undefined;
  calls: GitHubCall[];
}

export function memoryGitHub({ slug: home = 'o/r' }: { slug?: string } = {}): MemoryGitHub {
  const prs = new Map<string, Record<string, unknown>>();
  const feedback = new Map<string, unknown>();
  const closing = new Map<string, unknown>();
  const rules = new Map<string, BranchRules>();
  const heads = new Map<string, unknown>();
  const runs = new Map<string, unknown>();
  const failing = new Map<keyof GitHub, string>();
  const calls: GitHubCall[] = [];
  const key = (slug: string, n: number) => `${slug}#${n}`;
  const failIf = (op: keyof GitHub) => {
    const e = failing.get(op);
    if (e !== undefined) throw new ForgeError(e, 'external');
  };
  const stored = (slug: string, n: number): Record<string, unknown> => {
    const r = prs.get(key(slug, n));
    if (!r) throw new ForgeError(`gh pr view: no PR #${n} in ${slug}`, 'external');
    return r;
  };
  const read = <T>(op: keyof GitHub, args: Omit<GitHubCall, 'op'>, fn: () => T): T => {
    calls.push({ op, ...args });
    failIf(op);
    return fn();
  };
  return {
    calls,
    put(raw, slug = home) {
      prs.set(key(slug, Number(raw.number)), raw);
    },
    patch(number, fields, slug = home) {
      Object.assign(stored(slug, number), fields);
    },
    setFeedback(number, node, slug = home) {
      feedback.set(key(slug, number), node);
    },
    setClosing(issue, nodes, slug = home) {
      closing.set(key(slug, issue), nodes);
    },
    setBranchRules(base, r, slug = home) {
      rules.set(`${slug}\0${base}`, r);
    },
    setHeadChecks(sha, data, slug = home) {
      heads.set(`${slug}@${sha}`, data);
    },
    setRun(run, raw, slug = home) {
      runs.set(`${slug}!${run}`, raw);
    },
    fail(op, error) {
      if (error === null) failing.delete(op);
      else failing.set(op, error);
    },
    record: (number, slug = home) => prs.get(key(slug, number)),
    require() {
      calls.push({ op: 'require' });
    },
    repoSlug(_root, config) {
      calls.push({ op: 'repoSlug' });
      return config.tracker?.github?.repo ?? home;
    },
    view: (_cwd, slug, number) => read('view', { slug, number }, () => parsePr(stored(slug, number))),
    viewBody: (_cwd, slug, number) => read('viewBody', { slug, number }, () => parsePrBody(stored(slug, number))),
    list: (_cwd, slug, branch, state) =>
      read('list', { slug, branch, state }, () =>
        [...prs.entries()]
          .filter(([k, r]) => k.startsWith(`${slug}#`) && r.headRefName === branch && (state === 'all' || r.state === 'OPEN'))
          .slice(0, 5)
          .map(([, r]) => parsePr(r)),
      ),
    closing: (_cwd, slug, issue) => read('closing', { slug, issue }, () => parseClosing(closing.get(key(slug, issue)) ?? [])),
    feedback: (_cwd, slug, number) => read('feedback', { slug, number }, () => parseFeedback({ repository: { pullRequest: feedback.get(key(slug, number)) ?? {} } })),
    create: (_cwd, pr) =>
      read('create', { slug: pr.slug, base: pr.base, head: pr.head, title: pr.title, draft: pr.draft }, () => {
        const used = [...prs.keys()].filter((k) => k.startsWith(`${pr.slug}#`)).map((k) => Number(k.slice(pr.slug.length + 1)));
        const number = Math.max(0, ...used) + 1;
        const url = `https://github.com/${pr.slug}/pull/${number}`;
        prs.set(key(pr.slug, number), {
          number,
          url,
          state: 'OPEN',
          isDraft: pr.draft,
          isCrossRepository: false,
          headRefName: pr.head,
          baseRefName: pr.base,
          title: pr.title,
          body: fs.readFileSync(pr.bodyFile, 'utf8'),
          labels: [...pr.labels],
          reviewers: [...pr.reviewers],
          statusCheckRollup: [],
          mergedAt: null,
        });
        return { number, url };
      }),
    editBase: (_cwd, slug, number, base) =>
      read('editBase', { slug, number, base }, () => {
        stored(slug, number).baseRefName = base;
      }),
    editBody: (_cwd, slug, number, bodyFile) =>
      read('editBody', { slug, number, bodyFile }, () => {
        stored(slug, number).body = fs.readFileSync(bodyFile, 'utf8');
      }),
    ready: (_cwd, slug, number) =>
      read('ready', { slug, number }, () => {
        stored(slug, number).isDraft = false;
      }),
    merge(_cwd, slug, number, opts) {
      calls.push({ op: 'merge', slug, number, ...opts });
      const error = failing.get('merge');
      if (error !== undefined) return { ok: false, error };
      const r = prs.get(key(slug, number));
      if (!r) return { ok: false, error: `no PR #${number} in ${slug}` };
      if (opts.matchHead && opts.matchHead !== r.headRefOid) return { ok: false, error: "head commit doesn't match" };
      if (opts.auto) r.autoMerge = true;
      else Object.assign(r, { state: 'MERGED', mergedAt: new Date().toISOString() });
      return { ok: true };
    },
    branchRules(_cwd, slug, base) {
      calls.push({ op: 'branchRules', slug, base });
      const error = failing.get('branchRules');
      if (error !== undefined) return { status: 'unavailable', checks: [], reviews: null, error };
      return structuredClone(rules.get(`${slug}\0${base}`) ?? { status: 'read', checks: [], reviews: 0 });
    },
    headChecks: (_cwd, slug, sha) =>
      read('headChecks', { slug, sha }, () => {
        const k = `${slug}@${sha}`;
        return heads.has(k) ? parseHeadChecks(heads.get(k)) : { checks: [], complete: true };
      }),
    viewRun: (_cwd, slug, run) =>
      read('viewRun', { slug, run }, () => {
        const k = `${slug}!${run}`;
        if (!runs.has(k)) throw new ForgeError(`gh run view: no run ${run} in ${slug}`, 'external');
        return parseRun(runs.get(k));
      }),
    rerunFailed(_cwd, slug, run) {
      calls.push({ op: 'rerunFailed', slug, run });
      const error = failing.get('rerunFailed');
      return error !== undefined ? { ok: false, error } : { ok: true };
    },
  };
}
