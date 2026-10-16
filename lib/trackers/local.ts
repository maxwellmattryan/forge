// Markdown backlog tracker. Format (one item per checkbox, optional indented description):
//
//   - [ ] Add dark mode toggle
//     Users want a theme switch in settings.
//   - [~] Reading time on posts → 3f-reading-time-k2j9
//   - [x] 404 page
//   - [?] Faster search
//     Needs info: acceptance criteria or a reproduction
//
// "[ ]" is ready, "[~]" is claimed by a job, "[x]" is done, "[-]" is dropped, and "[?]" needs info
// (readiness triage, lib/triage.ts). Triage writes one indented `Needs info: …` line under such an
// item; that line is Forge's, never part of the item's body.
// An item's ref is the slug of its title, so refs survive reordering.
import fs from 'node:fs';
import path from 'node:path';
import { queryTerms, scoreItems } from '../issue-link.ts';
import { paths, resolveFrom, exists } from '../paths.ts';
import { ForgeError, slugify, withLock } from '../util.ts';
import type { Tracker, TrackerCtx, TrackerItem } from '../types.ts';

const ITEM_RE = /^([-*])\s+\[([ xX~?\-])\]\s+(.*?)(?:\s+→\s+(\S+))?\s*$/;

/** A parsed backlog line: its checkbox mark, the job it points at and its indented description. */
interface BacklogEntry {
  ref: string;
  title: string;
  mark: string;
  job: string | null;
  line: number;
  body: string[];
}

/** backlog.md split into lines, with the items found in it. */
interface BacklogDoc {
  lines: string[];
  items: BacklogEntry[];
  file?: string;
}

function file(ctx: TrackerCtx): string {
  return resolveFrom(ctx.root, ctx.config.tracker.local.path);
}

function parse(text: string): BacklogDoc {
  const lines = text.split('\n');
  const items: BacklogEntry[] = [];
  lines.forEach((l, i) => {
    const m = l.match(ITEM_RE);
    if (m && !/^\s/.test(l)) {
      items.push({ ref: slugify(m[3], 8), title: m[3], mark: m[2].toLowerCase(), job: m[4] ?? null, line: i, body: [] });
    } else if (items.length && /^\s{2,}\S/.test(l) && items[items.length - 1].line + items[items.length - 1].body.length + 1 === i) {
      items[items.length - 1].body.push(l.trim());
    }
  });
  return { lines, items };
}

const statusOf = (mark: string): string => ({ ' ': 'ready', '~': 'in-progress', x: 'done', '-': 'dropped', '?': 'needs-info' } as Record<string, string>)[mark] ?? 'ready';

/** Triage's note line, as parse() keeps it (trimmed). */
const NOTE = 'Needs info: ';
const isNote = (l: string): boolean => l.startsWith(NOTE);

function edit<T>(ctx: TrackerCtx, fn: (doc: BacklogDoc) => T): T {
  const f = file(ctx);
  return withLock(path.join(paths(ctx.root).locks, 'backlog'), () => {
    const doc = parse(exists(f) ? fs.readFileSync(f, 'utf8') : '# Backlog\n');
    const r = fn(doc);
    fs.writeFileSync(f, doc.lines.join('\n'));
    return r;
  });
}

const toItem = (item: BacklogEntry): TrackerItem => ({
  ref: item.ref,
  title: item.title,
  body: item.body.filter((l) => !isNote(l)).join('\n'),
  status: statusOf(item.mark),
  claimedBy: item.job,
  url: null,
  labels: [],
  needsInfo: item.mark === '?',
});

function find(doc: BacklogDoc, ref: string): BacklogEntry {
  const it = doc.items.find((i) => i.ref === ref);
  if (!it) throw new ForgeError(`no backlog item "${ref}" in ${doc.file ?? 'backlog'}`);
  return it;
}

function rewrite(doc: BacklogDoc, it: BacklogEntry, mark: string, job: string | null): void {
  doc.lines[it.line] = `- [${mark}] ${it.title}${job ? ` → ${job}` : ''}`;
}

export default {
  name: 'local',
  list(ctx, opts = {}) {
    const f = file(ctx);
    if (!exists(f)) return [];
    const items = parse(fs.readFileSync(f, 'utf8')).items.map(toItem);
    const out = opts.ready ? items.filter((i) => i.status === 'ready') : items;
    return opts.limit ? out.slice(0, opts.limit) : out;
  },
  search(ctx, query, opts) {
    const f = file(ctx);
    if (!exists(f)) return [];
    const open = parse(fs.readFileSync(f, 'utf8')).items.map(toItem).filter((i) => i.status === 'ready' || i.status === 'in-progress' || i.status === 'needs-info');
    return scoreItems(open, queryTerms(query)).slice(0, opts.limit);
  },
  get(ctx, ref) {
    const f = file(ctx);
    if (!exists(f)) return null;
    const it = parse(fs.readFileSync(f, 'utf8')).items.find((i) => i.ref === ref);
    return it ? toItem(it) : null;
  },
  claim(ctx, ref, job) {
    return edit(ctx, (doc) => {
      const it = find(doc, ref);
      if (it.mark === '~' && it.job && it.job !== job.id) return { ok: false, reason: `already claimed by job ${it.job}` };
      if (it.mark === 'x') return { ok: false, reason: 'item is already done' };
      rewrite(doc, it, '~', job.id);
      return { ok: true };
    });
  },
  update(ctx, ref, job) {
    edit(ctx, (doc) => {
      const it = doc.items.find((i) => i.ref === ref);
      if (!it) return;
      if (job.state === 'done') rewrite(doc, it, 'x', job.id);
      else if (job.state === 'cancelled') rewrite(doc, it, ' ', null);
      else rewrite(doc, it, '~', job.id);
    });
  },
  comment() {},
  setNeedsInfo(ctx, ref, note) {
    edit(ctx, (doc) => {
      const it = find(doc, ref);
      // Claimed, done and dropped items are someone's decision: triage never touches them.
      if (it.mark !== ' ' && it.mark !== '?') return;
      const k = it.body.findIndex(isNote);
      const at = it.line + 1 + (k < 0 ? it.body.length : k);
      if (note === null) {
        if (k >= 0) doc.lines.splice(at, 1);
        rewrite(doc, it, ' ', it.job);
        return;
      }
      const line = `  ${NOTE}${String(note).replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)}`;
      if (k >= 0) doc.lines[at] = line;
      else doc.lines.splice(at, 0, line);
      rewrite(doc, it, '?', it.job);
    });
  },
  create(ctx, item) {
    return edit(ctx, (doc) => {
      const ref = slugify(item.title, 8);
      if (doc.items.some((i) => i.ref === ref)) return { ref };
      while (doc.lines.length && doc.lines[doc.lines.length - 1] === '') doc.lines.pop();
      doc.lines.push(`- [ ] ${item.title}`);
      const body = [item.parentRef ? `Part of: ${item.parentRef}` : null, item.body?.trim()].filter(Boolean).join('\n');
      for (const l of body.split('\n').filter(Boolean)) doc.lines.push(`  ${l}`);
      doc.lines.push('');
      return { ref, url: null };
    });
  },
  close(ctx, ref, opts = {}) {
    edit(ctx, (doc) => {
      const it = find(doc, ref);
      rewrite(doc, it, opts.reason === 'not-planned' ? '-' : 'x', it.job);
    });
  },
} satisfies Tracker;
