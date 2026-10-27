// GitHub Issues tracker via the gh CLI. Status mirroring is opt-in and independent:
//   statusSync: none     → only assignment + comments
//   statusSync: labels   → one "<prefix><status>" label at a time
//   statusSync: project  → a GitHub Projects (v2) single-select field, e.g. "Status"
//   statusSync: both
// Readiness triage's "<prefix>needs-info" label is used whatever statusSync says: such an issue is
// left out of ready lists, and a claim with label sync drops it like any other stale status label.
// Project coordinates come from tracker.github.project or the repo's project-config file
// (default .github/project-config.yml); projects need a token with the "project" scope.
// get fences an issue's text for agents; view returns it unfenced, for the dashboard's issue panel only.
import fs from 'node:fs';
import path from 'node:path';
import { paths, resolveFrom, exists } from '#core/paths.ts';
import { ForgeError } from '#core/errors.ts';
import { readJson, writeJsonAtomic } from '#core/os/fs.ts';
import { withLock } from '#core/os/lock.ts';
import { gh, ghJson } from './gh.ts';
import * as yaml from '#core/format/yaml.ts';
import { repoSlug } from './pull-requests.ts';
import { listJobs, isActive } from '#core/job/store.ts';
import { statusKey, STATUS_KEYS } from '#api/tracker.ts';
import { queryTerms } from '#core/job/issue-link.ts';
import { checkIssueRef, nativeRef, splitQualified } from '#core/job/issue-ref.ts';
import { localRepoSlug } from '../git/repo-slug.ts';
import { attributionForbidden, stripAttribution } from '#engine/guard/attribution.ts';
import { importHeader, oneLineTitle, quote } from '#core/text.ts';
import type { Hidden } from '#core/text.ts';
import type { LoadedJob, Tracker, TrackerCtx, TrackerItem } from '#core/types.ts';

/** A GitHub Project (v2) and its status field, from config or the project-config file: projectCoords. */
export interface ProjectCoords {
  owner: string;
  number: number;
  statusField: string;
  statusOptions: string[] | null;
}

/** At most this many issues come back from one search, before local re-ranking. */
const SEARCH_FETCH = 30;

/** An issue URL under the configured repo: https, github.com (or GH_HOST), path `/<owner>/<repo>/issues/<n>`. */
export function inRepo(url: unknown, slug: string): boolean {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    const hosts = new Set(['github.com', String(process.env.GH_HOST ?? '').toLowerCase()].filter(Boolean));
    return u.protocol === 'https:' && hosts.has(u.hostname.toLowerCase()) && new RegExp(`^/${escapeRe(slug)}/issues/\\d+$`, 'i').test(u.pathname);
  } catch {
    return false;
  }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ISSUE_NUMBER = /^[1-9][0-9]{0,9}$/;

/**
 * The issue number `ref` names in the repo `slug()` returns (the verb's -R), or a usage ForgeError.
 * gh lets a URL or `owner/repo#N` name its own repo ahead of -R and reads a leading `-` as a flag,
 * so only `12`, `#12` or this repo's `owner/repo#12` pass; the slug is read only for the last.
 */
export function issueNumber(ref: unknown, slug: () => string): string {
  const shown = JSON.stringify(String(ref).slice(0, 100));
  const refuse = (where: string) => new ForgeError(`the GitHub tracker takes an issue number in ${where}, not ${shown}`, 'usage', 'forge help tracker');
  const checked = checkIssueRef(ref, { tracker: 'github', slug: null });
  if ('error' in checked) throw refuse('this repo');
  if (ISSUE_NUMBER.test(checked.ref)) return checked.ref;
  const q = splitQualified(checked.ref);
  if (!q) throw refuse('this repo');
  const repo = slug();
  if (q.path.toLowerCase() !== repo.toLowerCase()) throw refuse(`this repo (${repo})`);
  return q.n;
}

/** repoSlug, read at most once: the guard's slug thunk and the verb's -R value. */
function slugOnce(ctx: TrackerCtx): () => string {
  let slug: string | null = null;
  return () => (slug ??= repoSlug(ctx.root, ctx.config));
}

const gcfg = (ctx: Pick<TrackerCtx, 'config'>) => ctx.config.tracker.github;

/** People with write access: their comments are imported by default, and their issues refresh on claim. */
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
export const trustedAssociation = (association: string | null): boolean => association !== null && TRUSTED.has(association);

/** tracker.github.comments' rule, which get and view share: `all` keeps every comment, `collaborators` only write access. */
function keptComments(ctx: Pick<TrackerCtx, 'config'>, comments: unknown): { kept: any[]; dropped: number } {
  const all = Array.isArray(comments) ? comments : [];
  const everyone = gcfg(ctx).comments === 'all';
  const kept = all.filter((c: any) => everyone || TRUSTED.has(c?.authorAssociation));
  return { kept, dropped: all.length - kept.length };
}

/**
 * The issue author's association with the repo, from the REST API: `gh issue view` gives each
 * comment's association but not the author's. Null when gh fails or the ref isn't a number.
 */
export function issueAuthorAssociation(ctx: TrackerCtx, ref: string): string | null {
  if (!/^\d+$/.test(ref)) return null;
  const r = gh(ctx.root, ['api', `repos/${repoSlug(ctx.root, ctx.config)}/issues/${ref}`, '--jq', '.author_association'], { allowFail: true });
  const a = r.ok ? r.stdout.trim() : '';
  return /^[A-Z_]{1,40}$/.test(a) ? a : null;
}

export function projectCoords(ctx: TrackerCtx): ProjectCoords | null {
  const p = gcfg(ctx).project;
  let owner: string | null = p.owner;
  let number: number | null = p.number;
  let statusField: string | undefined = p.statusField;
  let statusOptions: string[] | null = null;
  const file = p.config ? resolveFrom(ctx.root, p.config) : null;
  if (file && exists(file)) {
    try {
      const pc = yaml.parse(fs.readFileSync(file, 'utf8')) ?? {};
      owner ??= pc.project?.owner ?? pc.repository?.owner;
      number ??= pc.project?.number;
      if (pc.fields?.status?.name) statusField = p.statusField ?? pc.fields.status.name;
      statusOptions = pc.fields?.status?.options ?? null;
    } catch (e) {
      throw new ForgeError(`${file}: ${(e as Error).message}`);
    }
  }
  if (!owner || !number) return null;
  return { owner: String(owner), number: Number(number), statusField: statusField ?? 'Status', statusOptions };
}

/**
 * Explicit config wins; otherwise status keys are matched to option names by meaning, which
 * handles decorated names like "🏗 In Progress" without the user spelling them out.
 */
export function statusMap(ctx: Pick<TrackerCtx, 'config'>, options: string[]): Record<string, string | null> {
  const hints: Record<string, RegExp[]> = {
    queued: [/\btodo\b|to do|ready|queued/i, /backlog/i],
    'in-progress': [/in.?progress|doing|active|working/i],
    review: [/review/i],
    blocked: [/blocked|on.?hold|paused|waiting/i],
    done: [/\bdone\b|complete|closed|shipped/i],
    cancelled: [/cancel|won.?t|not.?planned|dropped/i],
  };
  const out: Record<string, string | null> = {};
  for (const key of STATUS_KEYS) {
    const explicit = gcfg(ctx).project.statusMap?.[key];
    if (explicit !== undefined) {
      out[key] = explicit;
      continue;
    }
    out[key] = null;
    for (const re of hints[key]) {
      const hit = options.find((o) => re.test(o));
      if (hit) {
        out[key] = hit;
        break;
      }
    }
  }
  return out;
}

function projectIds(ctx: TrackerCtx) {
  const coords = projectCoords(ctx);
  if (!coords) throw new ForgeError('statusSync includes "project" but no project is configured (tracker.github.project or .github/project-config.yml)');
  const cacheFile = path.join(paths(ctx.root).runtime, 'github-project.json');
  const cache = readJson(cacheFile, {});
  const key = `${coords.owner}/${coords.number}/${coords.statusField}`;
  if (cache[key]) return { ...coords, ...cache[key] };
  const proj = ghJson(ctx.root, ['project', 'view', String(coords.number), '--owner', coords.owner, '--format', 'json']);
  const fields = ghJson(ctx.root, ['project', 'field-list', String(coords.number), '--owner', coords.owner, '--format', 'json', '--limit', '100']);
  const field = (fields.fields ?? []).find((f: any) => f.name === coords.statusField);
  if (!field) throw new ForgeError(`project ${coords.owner}/${coords.number} has no field "${coords.statusField}"`);
  const ids = { projectId: proj.id, fieldId: field.id, options: Object.fromEntries((field.options ?? []).map((o: any) => [o.name, o.id])) };
  cache[key] = ids;
  writeJsonAtomic(cacheFile, cache);
  return { ...coords, ...ids };
}

function projectStatuses(ctx: TrackerCtx): Map<string, { status: string | null; priority: string | null }> {
  const coords = projectCoords(ctx);
  if (!coords) return new Map();
  const res = ghJson(ctx.root, ['project', 'item-list', String(coords.number), '--owner', coords.owner, '--format', 'json', '--limit', '1000']);
  const fieldKey = coords.statusField.toLowerCase();
  const map = new Map<string, { status: string | null; priority: string | null }>();
  for (const it of res.items ?? []) if (it.content?.url) map.set(it.content.url, { status: it[fieldKey] ?? null, priority: it.priority ?? null });
  return map;
}

/** A GitHub login as attribution: only characters a login (or a bot's `[bot]`/app path) uses. */
function login(v: unknown): string {
  return (typeof v === 'string' ? v : '').replace(/[^A-Za-z0-9_\-[\]/]/g, '') || 'unknown';
}

const toItem = (i: any): TrackerItem => ({
  ref: String(i.number),
  title: oneLineTitle(i.title),
  url: i.url,
  body: i.body,
  labels: (i.labels ?? []).map((l: any) => l.name),
  assignees: (i.assignees ?? []).map((a: any) => a.login),
  status: null,
  priority: null,
  claimedBy: null,
});

/** Readiness triage's label: `<prefix>needs-info`. */
const needsLabel = (ctx: Pick<TrackerCtx, 'config'>): string => `${gcfg(ctx).labels.prefix}needs-info`;

function myLogin(ctx: TrackerCtx): string {
  return gh(ctx.root, ['api', 'user', '-q', '.login']).stdout.trim();
}

/**
 * Creates each milestone wave label once, without --force, so an existing label's colour and description
 * are never overwritten. Wave labels carry no tracker.github.labels.prefix: list() reads a prefixed label as
 * a Forge claim and would hide the issue from triage.
 */
function ensureLabels(ctx: TrackerCtx, slug: string, labels: string[]): void {
  for (const l of labels) gh(ctx.root, ['label', 'create', l, '-R', slug, '--color', '0E8A16', '--description', 'Forge: milestone wave'], { allowFail: true });
}

function activeLocalJob(ctx: TrackerCtx, ref: string): LoadedJob | null {
  const slug = localRepoSlug(ctx.root, ctx.config);
  return listJobs(ctx.root).find((j) => isActive(j) && j.issues.some((i) => nativeRef(i, 'github', slug) === String(ref))) ?? null;
}

/**
 * `gh issue list` with `extra` flags, as items: project status and priority merged in when a project is
 * in use (its failure thrown only when `strict`), then needsInfo and claimedBy marked. list and scope share it.
 */
function listIssues(ctx: TrackerCtx, extra: string[], limit: number, strict: boolean): TrackerItem[] {
  const slug = repoSlug(ctx.root, ctx.config);
  const ready = gcfg(ctx).ready;
  const args = ['issue', 'list', '-R', slug, '--state', 'open', '--json', 'number,title,url,labels,assignees', '--limit', String(limit), ...extra];
  const items: TrackerItem[] = ghJson(ctx.root, args).map(toItem);
  const useProject = projectCoords(ctx) && (ready.projectStatus || ['project', 'both'].includes(gcfg(ctx).statusSync));
  if (useProject) {
    try {
      const statuses = projectStatuses(ctx);
      // gh issue list always returns url (it is in --json).
      for (const it of items) Object.assign(it, statuses.get(it.url!) ?? {});
    } catch (e) {
      if (strict) throw e;
    }
  }
  const prefix = gcfg(ctx).labels.prefix;
  const needs = needsLabel(ctx);
  for (const it of items) {
    it.needsInfo = (it.labels ?? []).includes(needs);
    const job = activeLocalJob(ctx, it.ref);
    if (job) it.claimedBy = job.id;
    else if ((it.labels ?? []).some((l: string) => l.startsWith(prefix) && l !== `${prefix}queued` && l !== needs)) it.claimedBy = 'forge (label)';
  }
  return items;
}

/** A milestone or label as a gh flag's value: a non-empty string that can never read as a flag itself. */
function scopeValue(kind: 'milestone' | 'label', v: unknown): string {
  if (typeof v !== 'string' || !v || v.startsWith('-') || /[\x00-\x1f\x7f]/.test(v))
    throw new ForgeError(`a mandate's ${kind} must be a non-empty string that does not start with "-" (got ${JSON.stringify(String(v)).slice(0, 60)})`);
  return v;
}

export default {
  name: 'github',
  list(ctx, opts = {}) {
    const ready = gcfg(ctx).ready;
    const extra: string[] = [];
    if (opts.ready) {
      for (const l of ready.labels ?? []) extra.push('--label', l);
      if (ready.assignee) extra.push('--assignee', ready.assignee);
      if (ready.milestone) extra.push('--milestone', ready.milestone);
    }
    let items = listIssues(ctx, extra, opts.limit ?? 100, Boolean(ready.projectStatus && opts.ready));
    if (opts.ready) {
      const exclude = new Set(ready.excludeLabels ?? []);
      items = items.filter((it) => !it.claimedBy && !it.needsInfo && !(it.labels ?? []).some((l: string) => exclude.has(l)));
      if (ready.projectStatus) items = items.filter((it) => it.status === ready.projectStatus);
    }
    return items;
  },
  scope(ctx, q) {
    // Checked before gh runs: the contract already refuses these, and gh would read a leading `-` as a flag.
    const extra: string[] = [];
    if (q.milestone !== null) extra.push('--milestone', scopeValue('milestone', q.milestone));
    for (const l of q.labels) extra.push('--label', scopeValue('label', l));
    const limit = Number.isSafeInteger(q.limit) && q.limit > 0 ? q.limit : 100;
    return listIssues(ctx, extra, limit, false);
  },
  search(ctx, query, opts) {
    const slug = repoSlug(ctx.root, ctx.config);
    // Only plain words reach GitHub's search syntax: qualifiers (`repo:`, `is:`, `label:` …), quotes,
    // parentheses, negation and OR are all dropped, so a query can't widen or redirect the search.
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const found = new Map<number, TrackerItem>();
    const searchOnce = (q: string) => {
      const args = ['issue', 'list', '-R', slug, '--state', 'open', '--search', q, '--json', 'number,title,url,labels,body', '--limit', String(SEARCH_FETCH)];
      for (const i of ghJson(ctx.root, args)) {
        // Belt and braces: an item from anywhere but the configured repo is never a candidate.
        if (!inRepo(i?.url, slug) || found.has(i.number)) continue;
        found.set(i.number, { ...toItem(i), body: String(i.body ?? '') });
      }
    };
    searchOnce(terms.join(' '));
    // GitHub ANDs the words; when that is too narrow, any of them will do.
    if (found.size < opts.limit && terms.length > 1) searchOnce(terms.join(' OR '));
    const items = [...found.values()].slice(0, SEARCH_FETCH);
    for (const it of items) it.claimedBy = activeLocalJob(ctx, it.ref)?.id ?? null;
    return items;
  },
  get(ctx, ref) {
    const repo = slugOnce(ctx);
    const n = issueNumber(ref, repo);
    const slug = repo();
    const r = gh(ctx.root, ['issue', 'view', '-R', slug, '--json', 'number,title,body,url,labels,assignees,comments,state,author', '--', n], { allowFail: true });
    if (!r.ok) return null;
    const i = JSON.parse(r.stdout);
    const item = toItem(i);
    item.needsInfo = (item.labels ?? []).includes(needsLabel(ctx));
    // One count over everything an agent reads from the issue, for the provenance line.
    const hidden: Hidden = { removed: 0, smuggled: false };
    item.title = oneLineTitle(i.title, hidden);
    const body = String(i.body ?? '').trim();
    const quoted = body ? quote(body, hidden) : '';
    const { kept, dropped } = keptComments(ctx, i.comments);
    const comments = kept.slice(-15).map((c: any) => {
      const assoc = String(c.authorAssociation ?? 'NONE').toLowerCase().replace(/[^a-z_]/g, '') || 'none';
      return `**@${login(c.author?.login)}** (${assoc}):\n${quote(c.body, hidden)}`;
    });
    item.body = [
      importHeader(`GitHub issue #${Number.isSafeInteger(i.number) ? i.number : String(ref).replace(/\D/g, '')} by @${login(i.author?.login)}`, hidden),
      '',
      quoted,
      comments.length ? `\n---\n### Recent comments\n\n${comments.join('\n\n')}` : '',
      dropped ? `\n_${dropped} comment(s) from people without write access omitted (tracker.github.comments: all to include them)._` : '',
    ].join('\n');
    item.status = i.state;
    return item;
  },
  view(ctx, ref) {
    const repo = slugOnce(ctx);
    const n = issueNumber(ref, repo);
    const slug = repo();
    const fields = 'number,title,body,url,labels,assignees,comments,state,author,milestone,createdAt,updatedAt';
    const r = gh(ctx.root, ['issue', 'view', '-R', slug, '--json', fields, '--', n], { allowFail: true });
    if (!r.ok) throw new ForgeError(`gh issue view #${n} failed: ${oneLineTitle(String(r.stderr ?? '').split('\n')[0] ?? '').slice(0, 200) || 'gh failed'}`, 'external');
    const i = JSON.parse(r.stdout);
    const { kept, dropped } = keptComments(ctx, i.comments);
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    // Unfenced on purpose: this is the panel's text, never an agent's (lib/engine/trackers/view.ts), and md() escapes it.
    return {
      ref: String(i.number ?? n),
      title: oneLineTitle(i.title),
      url: str(i.url),
      state: typeof i.state === 'string' ? i.state.toLowerCase() : null,
      body: String(i.body ?? ''),
      comments: kept.map((c: any) => ({ author: login(c?.author?.login), at: str(c?.createdAt), body: String(c?.body ?? '') })),
      hiddenComments: dropped,
      labels: (i.labels ?? []).map((l: any) => l?.name).filter((l: unknown) => typeof l === 'string'),
      assignees: (i.assignees ?? []).map((a: any) => a?.login).filter((a: unknown) => typeof a === 'string'),
      milestone: i.milestone?.title ? oneLineTitle(i.milestone.title) : null,
      author: i.author?.login ? login(i.author.login) : null,
      createdAt: str(i.createdAt),
      updatedAt: str(i.updatedAt),
    };
  },
  claim(ctx, ref, job) {
    const repo = slugOnce(ctx);
    const n = issueNumber(ref, repo);
    return withLock(path.join(paths(ctx.root).locks, `github-${n}`), () => {
      const other = activeLocalJob(ctx, n);
      if (other && other.id !== job.id) return { ok: false, reason: `already claimed by local job ${other.id}` };
      const slug = repo();
      const issue = ghJson(ctx.root, ['issue', 'view', '-R', slug, '--json', 'assignees,state', '--', n]);
      if (issue.state !== 'OPEN') return { ok: false, reason: 'issue is not open' };
      if (gcfg(ctx).claim.assign) {
        const me = myLogin(ctx);
        const others = (issue.assignees ?? []).map((a: any) => a.login).filter((l: string) => l !== me);
        if (others.length) return { ok: false, reason: `assigned to ${others.join(', ')}` };
        gh(ctx.root, ['issue', 'edit', '-R', slug, '--add-assignee', '@me', '--', n]);
      }
      this.update(ctx, n, job);
      return { ok: true };
    });
  },
  update(ctx, ref, job) {
    const repo = slugOnce(ctx);
    const n = issueNumber(ref, repo);
    const sync = gcfg(ctx).statusSync;
    if (sync === 'none') return;
    const key = statusKey(job);
    const slug = repo();
    if (sync === 'labels' || sync === 'both') {
      const prefix = gcfg(ctx).labels.prefix;
      const issue = ghJson(ctx.root, ['issue', 'view', '-R', slug, '--json', 'labels', '--', n]);
      const stale = issue.labels.map((l: any) => l.name).filter((name: string) => name.startsWith(prefix) && name !== `${prefix}${key}`);
      gh(ctx.root, ['label', 'create', `${prefix}${key}`, '-R', slug, '--color', '6E56CF', '--description', 'Forge status', '--force'], { allowFail: true });
      const args = ['issue', 'edit', '-R', slug, '--add-label', `${prefix}${key}`];
      for (const s of stale) args.push('--remove-label', s);
      args.push('--', n);
      gh(ctx.root, args);
    }
    if (sync === 'project' || sync === 'both') {
      const ids = projectIds(ctx);
      const target = statusMap(ctx, Object.keys(ids.options))[key];
      if (!target) return;
      const optionId = ids.options[target];
      if (!optionId) throw new ForgeError(`project field "${ids.statusField}" has no option "${target}"`);
      const url = `https://github.com/${slug}/issues/${n}`;
      const item = ghJson(ctx.root, ['project', 'item-add', String(ids.number), '--owner', ids.owner, '--url', url, '--format', 'json']);
      gh(ctx.root, ['project', 'item-edit', '--id', item.id, '--project-id', ids.projectId, '--field-id', ids.fieldId, '--single-select-option-id', optionId]);
    }
  },
  comment(ctx, ref, body) {
    const repo = slugOnce(ctx);
    const n = issueNumber(ref, repo);
    const slug = repo();
    const text = attributionForbidden(ctx.config) ? stripAttribution(body) : body;
    gh(ctx.root, ['issue', 'comment', '-R', slug, '--body-file', '-', '--', n], { input: `${text}\n\n<!-- forge -->` });
  },
  create(ctx, item) {
    const slug = repoSlug(ctx.root, ctx.config);
    const raw = [item.parentRef ? `Part of #${item.parentRef}` : null, item.body?.trim()].filter(Boolean).join('\n\n');
    const body = attributionForbidden(ctx.config) ? stripAttribution(raw) : raw;
    const args = ['issue', 'create', '-R', slug, '--title', item.title, '--body-file', '-'];
    for (const l of item.labels ?? []) args.push('--label', l);
    if (item.milestone) {
      ensureLabels(ctx, slug, item.labels ?? []);
      // `=`-joined, so a title can never be read as an option.
      args.push(`--milestone=${item.milestone}`);
    }
    const url = gh(ctx.root, args, { input: body || ' ' }).stdout.trim().split('\n').pop() ?? '';
    return { ref: url.match(/\/issues\/(\d+)/)?.[1] ?? url, url };
  },
  createMilestone(ctx, ms) {
    // The paths are built from repoSlug's checked slug only; the title and description go in -f key=value arguments.
    const slug = repoSlug(ctx.root, ctx.config);
    const open = ghJson(ctx.root, ['api', `repos/${slug}/milestones?state=open&per_page=100`]);
    const same = Array.isArray(open) ? open.find((m: any) => m && m.title === ms.title) : undefined;
    if (same) return { ref: String(same.number), url: typeof same.html_url === 'string' ? same.html_url : null };
    const description = attributionForbidden(ctx.config) ? stripAttribution(ms.description) : ms.description;
    const made = ghJson(ctx.root, ['api', '-X', 'POST', `repos/${slug}/milestones`, '-f', `title=${ms.title}`, '-f', `description=${description}`]);
    if (!Number.isSafeInteger(made?.number)) throw new ForgeError(`gh api repos/${slug}/milestones returned no milestone number`, 'external');
    return { ref: String(made.number), url: typeof made.html_url === 'string' ? made.html_url : null };
  },
  milestoneAdd(ctx, ref, opts) {
    const repo = slugOnce(ctx);
    const n = issueNumber(ref, repo);
    const slug = repo();
    ensureLabels(ctx, slug, opts.labels);
    const args = ['issue', 'edit', '-R', slug, `--milestone=${opts.milestone}`];
    for (const l of opts.labels) args.push('--add-label', l);
    args.push('--', n);
    gh(ctx.root, args);
  },
  milestones(ctx) {
    // The path is built from repoSlug's checked slug only, so nothing outside reaches gh's argv.
    const slug = repoSlug(ctx.root, ctx.config);
    const raw = ghJson(ctx.root, ['api', `repos/${slug}/milestones?state=open&per_page=100`]);
    if (!Array.isArray(raw)) throw new ForgeError(`gh api repos/${slug}/milestones printed no list`, 'external');
    return raw
      .filter((m: any) => m && typeof m === 'object')
      .map((m: any) => ({
        title: oneLineTitle(m.title),
        openIssues: Number.isSafeInteger(m.open_issues) && m.open_issues >= 0 ? (m.open_issues as number) : null,
        dueOn: typeof m.due_on === 'string' ? oneLineTitle(m.due_on).slice(0, 40) : null,
      }));
  },
  setNeedsInfo(ctx, ref, note) {
    // The note is the local backlog's; on GitHub the label is the mark and triage's comment the text.
    const repo = slugOnce(ctx);
    const n = issueNumber(ref, repo);
    const slug = repo();
    const label = needsLabel(ctx);
    if (note === null) {
      gh(ctx.root, ['issue', 'edit', '-R', slug, '--remove-label', label, '--', n]);
      return;
    }
    gh(ctx.root, ['label', 'create', label, '-R', slug, '--color', 'D97706', '--description', 'Forge: needs more information', '--force'], { allowFail: true });
    gh(ctx.root, ['issue', 'edit', '-R', slug, '--add-label', label, '--', n]);
  },
  close(ctx, ref, opts = {}) {
    const repo = slugOnce(ctx);
    const n = issueNumber(ref, repo);
    gh(ctx.root, ['issue', 'close', '-R', repo(), '--reason', opts.reason === 'not-planned' ? 'not planned' : 'completed', '--', n]);
  },
} satisfies Tracker;
