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
// (readiness triage, lib/engine/trackers/triage.ts). Triage writes one indented `Needs info: …` line under such an
// item; that line is Forge's, never part of the item's body.
// An item's ref is the slug of its title, so refs survive reordering. A milestone is a level-2 heading
// (`## <title>`, its description as `> ` lines); its section, and the items in it, run to the next level-1
// or level-2 heading.
// Titles and descriptions are outside text: list and search return them cleaned by visibleText, and
// get fences the description behind `>` under Forge's column-0 provenance line, as GitHub's get does.
import fs from 'node:fs';
import path from 'node:path';
import { queryTerms, scoreItems } from '#core/job/issue-link.ts';
import { paths, resolveFrom, exists } from '#core/paths.ts';
import { ForgeError } from '#core/errors.ts';
import { withLock } from '#core/os/lock.ts';
import { importHeader, oneLineTitle, quote, slugify, visibleText } from '#core/text.ts';
import type { Hidden } from '#core/text.ts';
import type { Tracker, TrackerCtx, TrackerItem } from '#core/types.ts';

// `[^\n]`, not `.`: a title holding U+2028 is still an item, and oneLineTitle makes it one line.
const ITEM_RE = /^([-*])\s+\[([ xX~?\-])\]\s+([^\n]*?)(?:\s+→\s+(\S+))?\s*$/;

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
    const before = exists(f) ? fs.readFileSync(f, 'utf8') : null;
    const doc = parse(before ?? '# Backlog\n');
    const r = fn(doc);
    const after = doc.lines.join('\n');
    if (after !== before) fs.writeFileSync(f, after);
    return r;
  });
}

// A milestone is a level-2 heading; its section runs to the next level-1 or level-2 heading, or the end.
const isSectionEnd = (l: string): boolean => /^#{1,2}(\s|$)/.test(l);
const headingTitle = (l: string): string | null => (l.startsWith('## ') ? l.slice(3).trim() : null);

/** The milestone `title`'s section as line indexes: its heading and the line after its last; null when there is no such heading. */
function section(lines: string[], title: string): { head: number; end: number } | null {
  const head = lines.findIndex((l) => headingTitle(l) === title);
  if (head < 0) return null;
  let end = head + 1;
  while (end < lines.length && !isSectionEnd(lines[end])) end++;
  return { head, end };
}

/**
 * Puts an item's line and its indented body lines at the end of milestone `title`'s section, after its
 * last non-blank line, with a blank line between them and the heading or its description.
 */
function insertInSection(doc: BacklogDoc, title: string, block: string[]): void {
  const s = section(doc.lines, title);
  if (!s) throw new ForgeError(`no milestone "${title}" in ${doc.file ?? 'backlog'}`);
  let at = s.end;
  while (at > s.head + 1 && doc.lines[at - 1].trim() === '') at--;
  const last = doc.lines[at - 1];
  const afterItem = ITEM_RE.test(last) || /^\s{2,}\S/.test(last);
  doc.lines.splice(at, 0, ...(afterItem ? [] : ['']), ...block);
}

/** An item's description: its indented lines without triage's note. */
const description = (item: BacklogEntry): string => item.body.filter((l) => !isNote(l)).join('\n');

const toItem = (item: BacklogEntry): TrackerItem => ({
  ref: item.ref,
  title: oneLineTitle(item.title),
  body: visibleText(description(item)).text,
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
    if (!it) return null;
    const hidden: Hidden = { removed: 0, smuggled: false };
    const title = oneLineTitle(it.title, hidden);
    const desc = description(it);
    const quoted = desc.trim() ? quote(desc, hidden) : '';
    return { ...toItem(it), title, body: `${importHeader(`the local backlog item "${it.ref}"`, hidden)}\n\n${quoted}` };
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
      doc.file = file(ctx);
      const ref = slugify(item.title, 8);
      if (doc.items.some((i) => i.ref === ref)) return { ref };
      const body = [item.parentRef ? `Part of: ${item.parentRef}` : null, item.body?.trim()].filter(Boolean).join('\n');
      const block = [`- [ ] ${item.title}`, ...body.split('\n').filter(Boolean).map((l) => `  ${l}`)];
      if (item.milestone) {
        insertInSection(doc, item.milestone, block);
        return { ref, url: null };
      }
      while (doc.lines.length && doc.lines[doc.lines.length - 1] === '') doc.lines.pop();
      doc.lines.push(...block, '');
      return { ref, url: null };
    });
  },
  milestones(ctx) {
    const f = file(ctx);
    if (!exists(f)) return [];
    const doc = parse(fs.readFileSync(f, 'utf8'));
    const out: { title: string; openIssues: number | null; dueOn: string | null }[] = [];
    doc.lines.forEach((l, i) => {
      const title = headingTitle(l);
      if (title === null) return;
      const s = section(doc.lines.slice(i), title)!;
      const open = doc.items.filter((it) => it.line > i && it.line < i + s.end && (it.mark === ' ' || it.mark === '~' || it.mark === '?')).length;
      out.push({ title: oneLineTitle(title), openIssues: open, dueOn: null });
    });
    return out;
  },
  createMilestone(ctx, ms) {
    return edit(ctx, (doc) => {
      if (section(doc.lines, ms.title)) return { ref: ms.title, url: null };
      while (doc.lines.length && doc.lines[doc.lines.length - 1] === '') doc.lines.pop();
      const quoted = String(ms.description ?? '').split('\n').map((l) => (l ? `> ${l}` : '>'));
      doc.lines.push('', `## ${ms.title}`, ...quoted, '');
      return { ref: ms.title, url: null };
    });
  },
  milestoneAdd(ctx, ref, opts) {
    edit(ctx, (doc) => {
      doc.file = file(ctx);
      const it = find(doc, ref);
      if (!section(doc.lines, opts.milestone)) throw new ForgeError(`no milestone "${opts.milestone}" in ${doc.file}`);
      // Labels are GitHub's: the backlog has none.
      const block = doc.lines.splice(it.line, 1 + it.body.length);
      insertInSection(doc, opts.milestone, block);
    });
  },
  close(ctx, ref, opts = {}) {
    edit(ctx, (doc) => {
      const it = find(doc, ref);
      rewrite(doc, it, opts.reason === 'not-planned' ? '-' : 'x', it.job);
    });
  },
} satisfies Tracker;
