// Markdown for job files and tracker text, escape-first, so agent- or issue-supplied HTML never executes.
import { esc } from './util.ts';

export const safeUrl = (u: unknown): string | null => (/^(https?:\/\/|#|\/(?!\/))/i.test(String(u ?? '')) ? String(u) : null);

const A = ' target="_blank" rel="noopener noreferrer"';
// A private-use character stands in for each rendered link while emphasis and chips run, so no
// pattern ever sees generated HTML. It is stripped from input first, so text can't forge one.
const SLOT = '';
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
// The lookbehind keeps today's rule (a bare URL starts a line or follows whitespace or `(`) while
// reading the real character before a gap, so text right after a link's `)` is never autolinked.
const BARE = /(?<![^\s(])https?:\/\/[^\s<)]+/g;
const TONE: Record<string, string> = { blocker: 'bad', major: 'warn', minor: 'info', nit: 'muted' };

// Emphasis then chips, over escaped text and slots only. The tags emitted hold no `*`, `_` or `[`,
// so the chip pass can't match inside what emphasis produced.
function decorate(t: string): string {
  return t
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/\[(blocker|major|minor|nit)\]/gi, (m, sev: string) => `<span class="chip ${TONE[sev.toLowerCase()]}">${sev.toLowerCase()}</span>`);
}

// One prose segment: explicit links, then bare URLs only in the gaps between them, each rendered once
// into a slot, so a URL inside a link's URL or label is never wrapped again.
function prose(part: string): string {
  const t = esc(part);
  const bare = new RegExp(BARE);
  const slots: string[] = [];
  let stream = '';
  let at = 0;
  const gap = (end: number) => {
    // Slicing at `end` stops a bare URL at the next link; lastIndex lets the lookbehind see the character before `at`.
    const view = t.slice(0, end);
    bare.lastIndex = at;
    for (let m; (m = bare.exec(view)); at = m.index + m[0].length) {
      stream += view.slice(at, m.index) + SLOT;
      slots.push(`<a href="${m[0]}"${A}>${m[0]}</a>`);
    }
    stream += view.slice(at);
    at = end;
  };
  for (const m of t.matchAll(LINK)) {
    gap(m.index);
    const u = safeUrl(m[2].replace(/&amp;/g, '&'));
    slots.push(u ? `<a href="${esc(u)}"${A}>${decorate(m[1])}</a>` : decorate(m[1]));
    stream += SLOT;
    at = m.index + m[0].length;
  }
  gap(t.length);
  let k = 0;
  // A function replacement inserts each slot verbatim and never rescans it.
  return decorate(stream).replace(new RegExp(SLOT, 'g'), () => slots[k++]);
}

export function inline(s: string): string {
  return s
    .replaceAll(SLOT, '')
    .split(/(`[^`]+`)/g)
    .map((part) => (/^`[^`]+`$/.test(part) ? `<code>${esc(part.slice(1, -1))}</code>` : prose(part)))
    .join('');
}

export function md(src: unknown): string {
  const lines = String(src ?? '').replace(/\r/g, '').split('\n');
  let html = '';
  let i = 0;
  const isBlock = (l: string) => /^(```|#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>|\||<!--|(-{3,}|\*{3,})\s*$)/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      html += `<pre><code>${esc(body.join('\n'))}</code></pre>`;
    } else if (/^<!--/.test(l)) {
      while (i < lines.length && !lines[i].includes('-->')) i++;
      i++;
    } else if (/^#{1,6}\s/.test(l)) {
      const level = Math.min(l.match(/^#+/)![0].length, 3);
      html += `<h${level}>${inline(l.replace(/^#+\s*/, ''))}</h${level}>`;
      i++;
    } else if (/^\s*([-*+]|\d+\.)\s/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items: string[] = [];
      while (i < lines.length && (/^\s*([-*+]|\d+\.)\s/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^\s*([-*+]|\d+\.)\s/.test(lines[i])) items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      const li = items.map((t) => {
        const box = t.match(/^\[([ xX~])\]\s*/);
        if (!box) return `<li>${inline(t)}</li>`;
        const mark = box[1] === ' ' ? '☐' : box[1] === '~' ? '◐' : '☑';
        return `<li class="list-none -ml-5"><span class="text-muted mr-1">${mark}</span>${inline(t.slice(box[0].length))}</li>`;
      });
      html += ordered ? `<ol>${li.join('')}</ol>` : `<ul>${li.join('')}</ul>`;
    } else if (/^\|/.test(l)) {
      const rows: string[] = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r: string) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r, idx) => !(idx === 1 && /^[\s|:-]+$/.test(r)));
      html += `<div class="overflow-x-auto"><table>${body.map((r, idx) => `<tr>${cells(r).map((c) => (idx === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join('')}</tr>`).join('')}</table></div>`;
    } else if (/^>/.test(l)) {
      const q: string[] = [];
      while (i < lines.length && /^>/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
      html += `<blockquote>${inline(q.join(' '))}</blockquote>`;
    } else if (/^(-{3,}|\*{3,})\s*$/.test(l)) {
      html += '<hr class="border-line my-3">';
      i++;
    } else if (!l.trim()) {
      i++;
    } else {
      const p: string[] = [];
      while (i < lines.length && lines[i].trim() && !isBlock(lines[i])) p.push(lines[i++]);
      if (!p.length) p.push(lines[i++]);
      html += `<p>${inline(p.join(' '))}</p>`;
    }
  }
  return html;
}
