// Markdown for job files and tracker text, escape-first, so agent- or issue-supplied HTML never executes.
import { esc } from './util.ts';

export const safeUrl = (u: unknown): string | null => (/^(https?:\/\/|#|\/(?!\/))/i.test(String(u ?? '')) ? String(u) : null);

export function inline(s: string): string {
  return s
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return `<code>${esc(part.slice(1, -1))}</code>`;
      let t = esc(part);
      t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => {
        const u = safeUrl(url.replace(/&amp;/g, '&'));
        return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
      });
      t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre: string, url: string) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|\W)\*([^*\s][^*]*)\*/g, '$1<em>$2</em>').replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, '$1<em>$2</em>');
      t = t.replace(/\[(blocker|major|minor|nit)\]/gi, (m, sev: string) => {
        const tone = ({ blocker: 'bad', major: 'warn', minor: 'info', nit: 'muted' } as Record<string, string>)[sev.toLowerCase()];
        return `<span class="chip ${tone}">${sev.toLowerCase()}</span>`;
      });
      return t;
    })
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
