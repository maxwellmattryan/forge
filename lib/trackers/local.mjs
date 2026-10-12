// @ts-check
// Markdown backlog tracker. Format (one item per checkbox, optional indented description):
//
//   - [ ] Add dark mode toggle
//     Users want a theme switch in settings.
//   - [~] Reading time on posts → 3f-reading-time-k2j9
//   - [x] 404 page
//
// "[ ]" is ready, "[~]" is claimed by a job, "[x]" is done, "[-]" is dropped.
// An item's ref is the slug of its title, so refs survive reordering.
import fs from 'node:fs';
import path from 'node:path';
import { paths, resolveFrom, exists } from '../paths.mjs';
import { FactoryError, slugify, withLock } from '../util.mjs';

const ITEM_RE = /^([-*])\s+\[([ xX~\-])\]\s+(.*?)(?:\s+→\s+(\S+))?\s*$/;

/** @param {any} ctx */
function file(ctx) {
  return resolveFrom(ctx.root, ctx.config.tracker.local.path);
}

/** @param {string} text */
function parse(text) {
  const lines = text.split('\n');
  /** @type {{ref:string,title:string,mark:string,job:string|null,line:number,body:string[]}[]} */
  const items = [];
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

/** @param {string} mark */
const statusOf = (mark) => ({ ' ': 'ready', '~': 'in-progress', x: 'done', '-': 'dropped' })[mark] ?? 'ready';

/** @param {any} ctx @param {(doc:{lines:string[], items:any[]})=>void} fn */
function edit(ctx, fn) {
  const f = file(ctx);
  return withLock(path.join(paths(ctx.root).locks, 'backlog'), () => {
    const doc = parse(exists(f) ? fs.readFileSync(f, 'utf8') : '# Backlog\n');
    const r = fn(doc);
    fs.writeFileSync(f, doc.lines.join('\n'));
    return r;
  });
}

/** @param {any} item */
const toItem = (item) => ({
  ref: item.ref,
  title: item.title,
  body: item.body.join('\n'),
  status: statusOf(item.mark),
  claimedBy: item.job,
  url: null,
  labels: [],
});

/** @param {any} doc @param {string} ref */
function find(doc, ref) {
  const it = doc.items.find((/** @type {any} */ i) => i.ref === ref);
  if (!it) throw new FactoryError(`no backlog item "${ref}" in ${doc.file ?? 'backlog'}`);
  return it;
}

/** @param {any} doc @param {any} it @param {string} mark @param {string|null} job */
function rewrite(doc, it, mark, job) {
  doc.lines[it.line] = `- [${mark}] ${it.title}${job ? ` → ${job}` : ''}`;
}

/** @type {import('./index.mjs').Tracker} */
export default {
  name: 'local',
  list(ctx, opts = {}) {
    const f = file(ctx);
    if (!exists(f)) return [];
    const items = parse(fs.readFileSync(f, 'utf8')).items.map(toItem);
    const out = opts.ready ? items.filter((i) => i.status === 'ready') : items;
    return opts.limit ? out.slice(0, opts.limit) : out;
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
      const it = doc.items.find((/** @type {any} */ i) => i.ref === ref);
      if (!it) return;
      if (job.state === 'done') rewrite(doc, it, 'x', job.id);
      else if (job.state === 'cancelled') rewrite(doc, it, ' ', null);
      else rewrite(doc, it, '~', job.id);
    });
  },
  comment() {},
  create(ctx, item) {
    return edit(ctx, (doc) => {
      const ref = slugify(item.title, 8);
      if (doc.items.some((/** @type {any} */ i) => i.ref === ref)) return { ref };
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
};
