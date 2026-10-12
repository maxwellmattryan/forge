// Forge dashboard. Vanilla ES module, no build step. Talks only to the local `forge dash` server.
import { esc, num, usd, ago, toneChip } from './util.js';
import { budgetChip, budgetCell, budgetPanel } from './budget.js';
const TOKEN = document.querySelector('meta[name="forge-token"]')?.content ?? '';
const API_VERSION = 3;

const STAGES = ['backlog', 'plan', 'spec', 'design', 'build', 'verify', 'review', 'decide', 'integrate', 'pr', 'done'];
const CORE_STAGES = new Set(['backlog', 'spec', 'build', 'review', 'pr', 'done']);
const STAGE_LABEL = { backlog: 'Queued', plan: 'Plan', spec: 'Spec', design: 'Design', build: 'Build', verify: 'Verify', review: 'Review', decide: 'Decide', integrate: 'Integrate', pr: 'PR', done: 'Done' };
const WAIT_LABEL = {
  'spec-approval': 'Spec approval',
  input: 'Question for you',
  escalation: 'Escalated',
  infra: 'Infra steps',
  conflicts: 'Merge conflicts',
  'rounds-exhausted': 'Review rounds exhausted',
  'pr-review': 'PR review',
  external: 'External dependency',
  budget: 'Budget exceeded',
};

const ICONS = {
  pipeline: 'M3 5h4v14H3zM10 5h4v9h-4zM17 5h4v6h-4z',
  inbox: 'M4 13h4l2 3h4l2-3h4M4 13l2-8h12l2 8v6H4z',
  backlog: 'M5 6h14M5 12h14M5 18h9',
  agents: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  analytics: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  evals: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5 5 3.5 3.5M20.5 20.5 19 19M5 19l-1.5 1.5M20.5 3.5 19 5M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  moon: 'M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z',
  board: 'M3 4h7v16H3zM14 4h7v10h-7z',
  table: 'M3 5h18v14H3zM3 10h18M3 15h18M9 5v14',
  close: 'M6 6l12 12M18 6 6 18',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
};
const icon = (name, cls = 'size-4') =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[name]}"/></svg>`;

const VIEWS = [
  { id: 'pipeline', label: 'Pipeline', icon: 'pipeline' },
  { id: 'inbox', label: 'Needs you', icon: 'inbox' },
  { id: 'backlog', label: 'Backlog', icon: 'backlog' },
  { id: 'agents', label: 'Agents', icon: 'agents' },
  { id: 'analytics', label: 'Analytics', icon: 'analytics' },
  { id: 'evals', label: 'Evals', icon: 'evals' },
];

const store = {
  get(k, d) {
    try {
      return localStorage.getItem(`forge.${k}`) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`forge.${k}`, v);
    } catch {}
  },
};

const S = {
  data: null,
  dataKey: '',
  error: null,
  view: 'pipeline',
  layout: store.get('layout', 'board'),
  filter: store.get('filter', 'active'),
  window: store.get('window', '30'),
  stats: null,
  evals: null,
  roster: null,
  backlog: null,
  compare: { a: '', b: '', result: null },
  drawer: { id: null, detail: null, file: null, content: null, tab: 'files' },
};

// ---------- helpers ----------
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const tokensShort = (n) => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const dur = (ms) => {
  if (ms == null) return '—';
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${s}s`;
};
const safeUrl = (u) => (/^(https?:\/\/|#|\/(?!\/))/i.test(String(u ?? '')) ? String(u) : null);

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  const type = res.headers.get('content-type') ?? '';
  return type.includes('json') ? res.json() : res.text();
}

async function request(type, payload = {}) {
  try {
    const r = await api('/api/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-token': TOKEN },
      body: JSON.stringify({ type, ...payload }),
    });
    toast(r.launched ? `Queued "${type}" and launched an orchestrator` : `Queued "${type}". Your orchestrator session picks it up (/forge requests).`);
    refresh();
  } catch (e) {
    toast(`Request failed: ${e.message}`, true);
  }
}

let toastTimer;
function toast(msg, bad = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('text-bad', bad);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

function stateTone(job) {
  if (job.state === 'done') return 'ok';
  if (job.state === 'failed') return 'bad';
  if (job.state === 'cancelled') return 'muted';
  if (job.state === 'waiting') return job.waitingOn === 'pr-review' ? 'info' : 'warn';
  if (job.state === 'blocked') return 'bad';
  if (job.state === 'running') return 'accent';
  return 'muted';
}
const stateChip = (job) => toneChip(stateTone(job), job.state === 'waiting' ? WAIT_LABEL[job.waitingOn] ?? job.waitingOn : job.state);

const verdictChip = (name, v) => {
  const tone = v === 'PASS' ? 'ok' : v === 'CHANGES' ? 'bad' : v === 'MALFORMED' ? 'warn' : 'muted';
  return `<span class="chip ${{ ok: 'bg-ok/15 text-ok', bad: 'bg-bad/15 text-bad', warn: 'bg-warn/15 text-warn', muted: 'bg-raised text-muted' }[tone]}" title="${esc(name)}: ${esc(v ?? 'pending')}">${esc(name)}</span>`;
};

const prChip = (pr) => {
  if (!pr?.number) return '';
  const tone = pr.state === 'MERGED' ? 'ok' : pr.state === 'CLOSED' ? 'muted' : pr.conflicts ? 'bad' : pr.checks?.state === 'failing' ? 'bad' : pr.checks?.state === 'pending' ? 'warn' : 'info';
  const extra = pr.conflicts ? ' · conflicts' : pr.checks?.state && pr.checks.state !== 'none' ? ` · ${pr.checks.state}` : '';
  return toneChip(tone, `#${pr.number}${extra}`);
};

const progressBar = (p) =>
  p?.total
    ? `<div class="flex items-center gap-2"><div class="h-1.5 flex-1 rounded-full bg-raised overflow-hidden"><div class="h-full ember-bar" style="width:${Math.round((p.done / p.total) * 100)}%"></div></div><span class="text-[11px] text-muted tabular-nums">${p.done}/${p.total}</span></div>`
    : '';

// ---------- markdown (escape-first, so agent- or issue-supplied HTML never executes) ----------
function inline(s) {
  return s
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return `<code>${esc(part.slice(1, -1))}</code>`;
      let t = esc(part);
      t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
        const u = safeUrl(url.replace(/&amp;/g, '&'));
        return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
      });
      t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|\W)\*([^*\s][^*]*)\*/g, '$1<em>$2</em>').replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, '$1<em>$2</em>');
      t = t.replace(/\[(blocker|major|minor|nit)\]/gi, (m, sev) => {
        const tone = { blocker: 'bg-bad/15 text-bad', major: 'bg-warn/15 text-warn', minor: 'bg-info/15 text-info', nit: 'bg-raised text-muted' }[sev.toLowerCase()];
        return `<span class="chip ${tone}">${sev.toLowerCase()}</span>`;
      });
      return t;
    })
    .join('');
}

function md(src) {
  const lines = String(src ?? '').replace(/\r/g, '').split('\n');
  let html = '';
  let i = 0;
  const isBlock = (l) => /^(```|#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>|\||<!--|(-{3,}|\*{3,})\s*$)/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      html += `<pre><code>${esc(body.join('\n'))}</code></pre>`;
    } else if (/^<!--/.test(l)) {
      while (i < lines.length && !lines[i].includes('-->')) i++;
      i++;
    } else if (/^#{1,6}\s/.test(l)) {
      const level = Math.min(l.match(/^#+/)[0].length, 3);
      html += `<h${level}>${inline(l.replace(/^#+\s*/, ''))}</h${level}>`;
      i++;
    } else if (/^\s*([-*+]|\d+\.)\s/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
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
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r, idx) => !(idx === 1 && /^[\s|:-]+$/.test(r)));
      html += `<div class="overflow-x-auto"><table>${body.map((r, idx) => `<tr>${cells(r).map((c) => (idx === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join('')}</tr>`).join('')}</table></div>`;
    } else if (/^>/.test(l)) {
      const q = [];
      while (i < lines.length && /^>/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
      html += `<blockquote>${inline(q.join(' '))}</blockquote>`;
    } else if (/^(-{3,}|\*{3,})\s*$/.test(l)) {
      html += '<hr class="border-line my-3">';
      i++;
    } else if (!l.trim()) {
      i++;
    } else {
      const p = [];
      while (i < lines.length && lines[i].trim() && !isBlock(lines[i])) p.push(lines[i++]);
      if (!p.length) p.push(lines[i++]);
      html += `<p>${inline(p.join(' '))}</p>`;
    }
  }
  return html;
}

// ---------- data ----------
async function refresh() {
  try {
    const data = await api('/api/state');
    S.error = data.apiVersion > API_VERSION ? 'This data was written by a newer Forge. Restart `forge dash` after updating the plugin.' : null;
    const key = JSON.stringify({ ...data, now: undefined });
    if (key !== S.dataKey) {
      S.data = data;
      S.dataKey = key;
      render();
    }
    if (S.drawer.id) loadDrawer(false);
  } catch (e) {
    S.error = `Lost connection to the Forge server (${e.message}). Is \`forge dash\` still running?`;
    render();
  }
}

async function loadView() {
  try {
    if (S.view === 'analytics') {
      const since = S.window === 'all' ? '' : new Date(Date.now() - Number(S.window) * 86400000).toISOString();
      S.stats = await api(`/api/stats${since ? `?since=${encodeURIComponent(since)}` : ''}`);
    }
    if (S.view === 'evals') S.evals = await api('/api/evals');
    if (S.view === 'agents') S.roster = await api('/api/roster');
    if (S.view === 'backlog') S.backlog = await api('/api/backlog');
  } catch (e) {
    toast(e.message, true);
  }
  render();
}

// ---------- layout ----------
function renderNav() {
  const jobs = S.data?.jobs ?? [];
  const needs = jobs.filter((j) => (j.state === 'waiting' && j.waitingOn !== 'pr-review') || j.state === 'failed').length;
  const active = jobs.filter((j) => !['done', 'cancelled'].includes(j.state)).length;
  const badge = (id) => (id === 'pipeline' ? active : id === 'inbox' ? needs : 0);
  const items = VIEWS.map((v) => {
    const b = badge(v.id);
    const badgeHtml = b ? `<span class="text-[11px] tabular-nums ${v.id === 'inbox' ? 'chip bg-warn/15 text-warn' : 'text-muted'}">${b}</span>` : '';
    return `<a href="#/${v.id}" class="nav-item ${S.view === v.id ? 'active' : ''}"><span class="flex items-center gap-2">${icon(v.icon)}${v.label}</span>${badgeHtml}</a>`;
  }).join('');
  document.getElementById('nav').innerHTML = items;
  document.getElementById('mobile-nav').innerHTML = VIEWS.map((v) => `<a href="#/${v.id}" class="nav-item shrink-0 ${S.view === v.id ? 'active' : ''}">${v.label}${badge(v.id) ? ` <span class="text-muted">${badge(v.id)}</span>` : ''}</a>`).join('');
  document.getElementById('repo-name').textContent = S.data?.repo?.name ?? '';
  document.title = S.data?.repo?.name ? `Forge · ${S.data.repo.name}` : 'Forge';
  const sessions = new Set(jobs.filter((j) => j.owner && Date.now() - Date.parse(j.owner.heartbeat ?? j.owner.since) < 30 * 60000).map((j) => j.owner.session));
  document.getElementById('footer-sessions').innerHTML = `<span class="inline-block size-1.5 rounded-full ${sessions.size ? 'bg-ok' : 'bg-muted'} mr-1.5 align-middle"></span>${sessions.size} session${sessions.size === 1 ? '' : 's'} active`;
  const dark = document.documentElement.dataset.theme === 'dark';
  document.getElementById('theme-toggle').innerHTML = `<span class="flex items-center gap-2">${icon(dark ? 'sun' : 'moon')}${dark ? 'Light' : 'Dark'} theme</span>`;
  document.getElementById('footer-version').textContent = S.data ? `Forge v${S.data.forgeVersion} · api ${S.data.apiVersion}` : '';
}

function render() {
  renderNav();
  const el = document.getElementById('view');
  if (!S.data) {
    el.innerHTML = S.error ? banner(S.error) : '<div class="text-muted text-sm">Loading…</div>';
    return;
  }
  const body = { pipeline: viewPipeline, inbox: viewInbox, backlog: viewBacklog, agents: viewAgents, analytics: viewAnalytics, evals: viewEvals }[S.view]();
  el.innerHTML = (S.error ? banner(S.error) : '') + (!S.data.initialized ? banner('This repo has no .forge/config.yml yet. Run /forge init.') : '') + body;
}

const banner = (msg) => `<div class="card border-warn/40 bg-warn/10 text-warn px-4 py-3 text-sm mb-4">${esc(msg)}</div>`;
const pageHeader = (title, sub, right = '') =>
  `<div class="flex flex-wrap items-end justify-between gap-3 mb-5"><div><h1 class="text-xl font-semibold">${esc(title)}</h1>${sub ? `<p class="text-sm text-muted mt-0.5">${sub}</p>` : ''}</div><div class="flex flex-wrap items-center gap-2">${right}</div></div>`;
const empty = (msg) => `<div class="card px-4 py-10 text-center text-sm text-muted"><img src="/forge.png" alt="" class="size-10 mx-auto mb-3 rounded-lg opacity-80" />${msg}</div>`;

// ---------- pipeline ----------
function filteredJobs() {
  const jobs = (S.data?.jobs ?? []).filter((j) => j.kind !== 'eval' || S.filter === 'all');
  if (S.filter === 'active') return jobs.filter((j) => !['done', 'cancelled'].includes(j.state));
  if (S.filter === 'waiting') return jobs.filter((j) => ['waiting', 'blocked', 'failed'].includes(j.state));
  if (S.filter === 'done') return jobs.filter((j) => ['done', 'cancelled'].includes(j.state));
  return jobs;
}

function viewPipeline() {
  const all = S.data.jobs.filter((j) => j.kind !== 'eval');
  const counts = {
    all: S.data.jobs.length,
    active: all.filter((j) => !['done', 'cancelled'].includes(j.state)).length,
    waiting: all.filter((j) => ['waiting', 'blocked', 'failed'].includes(j.state)).length,
    done: all.filter((j) => ['done', 'cancelled'].includes(j.state)).length,
  };
  const filters = ['active', 'waiting', 'done', 'all']
    .map((f) => `<button data-action="filter" data-value="${f}" class="btn ${S.filter === f ? 'border-accent/60 text-fg' : 'text-muted'}">${f[0].toUpperCase() + f.slice(1)} <span class="text-muted tabular-nums">${counts[f]}</span></button>`)
    .join('');
  const toggle = `<div class="flex rounded-lg border border-line overflow-hidden">${['board', 'table']
    .map((l) => `<button data-action="layout" data-value="${l}" class="px-2.5 py-1.5 text-sm flex items-center gap-1.5 ${S.layout === l ? 'bg-raised text-fg' : 'text-muted'}">${icon(l)}${l[0].toUpperCase() + l.slice(1)}</button>`)
    .join('')}</div>`;
  const jobs = filteredJobs();
  const head = pageHeader('Pipeline', `${counts.active} active · base <code class="font-mono text-xs">${esc(S.data.config.base)}</code> · tracker ${esc(S.data.config.tracker)}`, `<div class="flex flex-wrap gap-1.5">${filters}</div>${toggle}<button class="btn btn-primary" data-action="req" data-type="next">Run next</button>`);
  if (!jobs.length) return head + empty('No jobs here yet. Start one with <code class="font-mono">/forge &lt;feature&gt;</code> or <code class="font-mono">/forge next</code>.');
  return head + (S.layout === 'table' ? jobsTable(jobs) : board(jobs));
}

function board(jobs) {
  const cols = STAGES.filter((s) => CORE_STAGES.has(s) || jobs.some((j) => j.stage === s));
  return `<div class="flex gap-3 overflow-x-auto pb-4 -mx-4 px-4 md:mx-0 md:px-0">${cols
    .map((stage) => {
      const list = jobs.filter((j) => j.stage === stage);
      return `<section class="w-72 shrink-0 card bg-panel/60 flex flex-col max-h-[calc(100vh-180px)]">
        <header class="flex items-center justify-between px-3 py-2.5 border-b border-line"><span class="text-sm font-medium">${STAGE_LABEL[stage]}</span><span class="text-xs text-muted tabular-nums">${list.length}</span></header>
        <div class="flex flex-col gap-2 p-2 overflow-y-auto">${list.map(card).join('') || '<div class="text-xs text-muted px-1 py-3 text-center">—</div>'}</div>
      </section>`;
    })
    .join('')}</div>`;
}

function card(j) {
  const verdicts = j.verdicts?.[j.round] ?? null;
  const verdictRow = j.reviewers?.length ? `<div class="flex flex-wrap gap-1">${j.reviewers.map((r) => verdictChip(r, verdicts?.[r])).join('')}</div>` : '';
  const running = Object.entries(j.agents ?? {}).filter(([, a]) => a.status === 'running').map(([role]) => role);
  return `<button data-action="open" data-id="${esc(j.id)}" class="text-left card bg-panel hover:border-accent/50 p-3 flex flex-col gap-2 ${j.state === 'waiting' && j.waitingOn !== 'pr-review' ? 'border-warn/50' : ''}">
    <div class="flex items-start justify-between gap-2"><span class="text-sm font-medium leading-5 line-clamp-2">${esc(j.title)}</span>${stateChip(j)}</div>
    <div class="flex flex-wrap items-center gap-1.5 text-[11px] text-muted font-mono">${j.source?.ref && !j.id.startsWith(String(j.source.ref)) ? `<span>${esc(j.source.ref)}</span>·` : /^\d+$/.test(String(j.source?.ref ?? '')) ? `<span>#${esc(j.source.ref)}</span>·` : ''}<span class="truncate max-w-40">${esc(j.id)}</span></div>
    ${progressBar(j.progress)}
    ${verdictRow}
    <div class="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
      ${j.round ? `<span>round ${j.round}/${j.maxRounds}</span>` : ''}${prChip(j.pr)}${budgetChip(j, S.data.config?.pipeline?.budget)}
      ${running.length ? `<span class="text-accent">● ${esc(running.join(', '))}</span>` : ''}
      <span class="ml-auto">${tokensShort(j.usage?.totalTokens)} tok · ${ago(j.updatedAt)}</span>
    </div>
  </button>`;
}

function jobsTable(jobs) {
  return `<div class="card overflow-x-auto"><table class="tbl"><thead><tr><th>Job</th><th>Stage</th><th>State</th><th>Round</th><th>Tasks</th><th>Verdicts</th><th>PR</th><th class="text-right">Tokens</th><th class="text-right">Est. cost</th><th>Budget</th><th>Updated</th></tr></thead><tbody>${jobs
    .map((j) => {
      const v = j.verdicts?.[j.round];
      return `<tr class="hover:bg-raised cursor-pointer" data-action="open" data-id="${esc(j.id)}">
        <td><div class="font-medium">${esc(j.title)}</div><div class="text-[11px] text-muted font-mono">${esc(j.id)}</div></td>
        <td>${STAGE_LABEL[j.stage] ?? esc(j.stage)}</td><td>${stateChip(j)}</td>
        <td class="tabular-nums">${j.round ? `${j.round}/${j.maxRounds}` : '—'}</td>
        <td class="tabular-nums">${j.progress?.total ? `${j.progress.done}/${j.progress.total}` : '—'}</td>
        <td><div class="flex flex-wrap gap-1">${(j.reviewers ?? []).map((r) => verdictChip(r, v?.[r])).join('')}</div></td>
        <td>${prChip(j.pr) || '—'}</td>
        <td class="text-right tabular-nums">${num(j.usage?.totalTokens)}</td><td class="text-right tabular-nums">${usd(j.usage?.estCostUsd)}</td><td class="whitespace-nowrap">${budgetCell(j, S.data.config?.pipeline?.budget)}</td>
        <td class="text-muted whitespace-nowrap">${ago(j.updatedAt)}</td></tr>`;
    })
    .join('')}</tbody></table></div>`;
}

// ---------- inbox ----------
function viewInbox() {
  const jobs = S.data.jobs;
  const urgent = jobs.filter((j) => (j.state === 'waiting' && j.waitingOn !== 'pr-review') || j.state === 'failed' || j.state === 'blocked');
  const prs = jobs.filter((j) => j.state === 'waiting' && j.waitingOn === 'pr-review');
  const reqs = S.data.requests ?? [];
  let html = pageHeader('Needs you', 'Decisions only a human can make. Actions are queued for your orchestrator session.');
  html += urgent.length ? `<div class="flex flex-col gap-3">${urgent.map(inboxCard).join('')}</div>` : empty('Nothing is waiting on you.');
  if (prs.length) {
    html += `<h2 class="text-sm font-semibold mt-8 mb-3">Open PRs awaiting review</h2><div class="card overflow-x-auto"><table class="tbl"><tbody>${prs
      .map((j) => {
        const u = safeUrl(j.pr?.url);
        return `<tr><td><button data-action="open" data-id="${esc(j.id)}" class="font-medium text-left hover:text-accent">${esc(j.title)}</button></td><td>${prChip(j.pr)}</td><td class="text-muted">${j.pr?.unresolvedThreads ? `${j.pr.unresolvedThreads} unresolved thread(s)` : 'no open threads'}${j.pr?.behindBy ? ` · ${j.pr.behindBy} behind` : ''}</td><td class="text-right whitespace-nowrap">${u ? `<a class="btn" href="${esc(u)}" target="_blank" rel="noopener">Open PR</a>` : ''} <button class="btn" data-action="req" data-type="rework" data-id="${esc(j.id)}" data-text="Address the PR feedback">Address feedback</button></td></tr>`;
      })
      .join('')}</tbody></table></div>`;
  }
  if (reqs.length) {
    html += `<h2 class="text-sm font-semibold mt-8 mb-3">Queued requests</h2><div class="card overflow-x-auto"><table class="tbl"><tbody>${reqs
      .map((r) => `<tr><td class="font-mono text-xs">${esc(r.type)}</td><td>${esc(r.job ?? '')}</td><td class="text-muted">${esc(r.text ?? '')}</td><td class="text-muted whitespace-nowrap">${r.status === 'in-progress' ? `handling (${esc(String(r.session ?? '').slice(0, 8))})` : 'queued'}</td><td class="text-muted whitespace-nowrap">${ago(r.createdAt)}</td></tr>`)
      .join('')}</tbody></table></div>`;
  }
  return html;
}

function inboxCard(j) {
  const w = j.state === 'failed' ? 'failed' : j.waitingOn;
  const id = esc(j.id);
  const note = `<textarea id="note-${id}" rows="2" class="w-full" placeholder="${w === 'input' ? 'Your answer…' : w === 'budget' ? 'Optional: new limits, e.g. usd=20 tokens=2000000' : 'Optional note for the agents…'}"></textarea>`;
  const actions = {
    'spec-approval': `<button class="btn btn-primary" data-action="req" data-type="approve" data-id="${id}">Approve spec</button><button class="btn" data-action="req" data-type="revise-spec" data-id="${id}" data-note="1">Request changes</button>`,
    input: `<button class="btn btn-primary" data-action="req" data-type="answer" data-id="${id}" data-note="1">Send answer</button>`,
    escalation: `<button class="btn btn-primary" data-action="req" data-type="approve" data-id="${id}">Approve</button><button class="btn" data-action="req" data-type="rework" data-id="${id}" data-note="1">Rework</button><button class="btn" data-action="req" data-type="cancel" data-id="${id}">Cancel job</button>`,
    'rounds-exhausted': `<button class="btn" data-action="req" data-type="rework" data-id="${id}" data-note="1">Another round</button><button class="btn" data-action="req" data-type="approve" data-id="${id}">Accept as is</button><button class="btn" data-action="req" data-type="cancel" data-id="${id}">Cancel job</button>`,
    budget: `<button class="btn btn-primary" data-action="req" data-type="approve" data-id="${id}" data-note="1">Approve &amp; continue</button><button class="btn" data-action="req" data-type="cancel" data-id="${id}">Cancel job</button>`,
    infra: `<button class="btn btn-primary" data-action="req" data-type="resume" data-id="${id}">Steps done, resume</button>`,
    conflicts: `<button class="btn btn-primary" data-action="req" data-type="rework" data-id="${id}" data-text="Resolve merge conflicts with the base branch">Fix conflicts now</button><button class="btn" data-action="req" data-type="resume" data-id="${id}">Leave for later</button>`,
    external: `<button class="btn" data-action="req" data-type="resume" data-id="${id}">Unblocked, resume</button>`,
    failed: `<button class="btn" data-action="req" data-type="resume" data-id="${id}">Retry</button><button class="btn" data-action="req" data-type="cancel" data-id="${id}">Cancel job</button>`,
  }[w] ?? `<button class="btn" data-action="req" data-type="resume" data-id="${id}">Resume</button>`;
  const doc = { 'spec-approval': 'spec.md', input: 'questions.md', escalation: 'decision.md', infra: 'runbook.md', 'rounds-exhausted': `review/round-${j.round}` }[w];
  return `<div class="card p-4 flex flex-col gap-3 border-warn/40">
    <div class="flex flex-wrap items-start justify-between gap-2"><div><button data-action="open" data-id="${id}" class="font-medium hover:text-accent text-left">${esc(j.title)}</button><div class="text-[11px] text-muted font-mono">${id}</div></div>${stateChip(j)}</div>
    ${j.reason ? `<div class="text-sm text-muted">${esc(j.reason)}</div>` : ''}
    ${w === 'budget' ? budgetPanel(j, S.data.config?.pipeline?.budget, { compact: true }) : ''}
    ${doc ? `<button class="text-sm text-accent self-start" data-action="open" data-id="${id}" data-file="${esc(doc)}">Read ${esc(doc)} →</button>` : ''}
    ${w === 'spec-approval' || w === 'input' || w === 'escalation' || w === 'rounds-exhausted' || w === 'budget' ? note : ''}
    <div class="flex flex-wrap gap-2">${actions}</div>
  </div>`;
}

// ---------- backlog ----------
function viewBacklog() {
  const b = S.backlog;
  const right = `<button class="btn" data-action="backlog-refresh">${icon('refresh')}Refresh</button><button class="btn btn-primary" data-action="req" data-type="next">Run next</button>`;
  let html = pageHeader('Backlog', b ? `From the <b>${esc(b.tracker)}</b> tracker` : 'Loading…', right);
  if (!b) return html;
  if (b.error) html += banner(b.error);
  if (!b.items?.length) return html + empty('The backlog is empty.');
  return (
    html +
    `<div class="card overflow-x-auto"><table class="tbl"><thead><tr><th>Ref</th><th>Title</th><th>Status</th><th>Priority</th><th>Claimed by</th><th></th></tr></thead><tbody>${b.items
      .map((i) => {
        const u = safeUrl(i.url);
        return `<tr><td class="font-mono text-xs">${u ? `<a href="${esc(u)}" target="_blank" rel="noopener" class="hover:text-accent">${/^\d+$/.test(i.ref) ? '#' : ''}${esc(i.ref)}</a>` : esc(i.ref)}</td><td>${esc(i.title)}<div class="flex flex-wrap gap-1 mt-1">${(i.labels ?? []).map((l) => `<span class="chip bg-raised text-muted">${esc(l)}</span>`).join('')}</div></td><td>${esc(i.status ?? '—')}</td><td>${esc(i.priority ?? '—')}</td><td class="text-muted">${i.claimedBy ? `<button data-action="open" data-id="${esc(i.claimedBy)}" class="hover:text-accent">${esc(i.claimedBy)}</button>` : '—'}</td><td class="text-right">${!i.claimedBy && !['done', 'dropped'].includes(i.status) ? `<button class="btn" data-action="req" data-type="run" data-ref="${esc(i.ref)}">Start</button>` : ''}</td></tr>`;
      })
      .join('')}</tbody></table></div>`
  );
}

// ---------- agents ----------
function viewAgents() {
  const jobs = S.data.jobs;
  const running = jobs.flatMap((j) => Object.entries(j.agents ?? {}).filter(([, a]) => a.status === 'running').map(([role, a]) => ({ job: j, role, ...a })));
  const sessions = {};
  for (const j of jobs) if (j.owner) (sessions[j.owner.session] ??= { ...j.owner, jobs: [] }).jobs.push(j);
  let html = pageHeader('Agents', 'Who is working on what, and the roster every job draws from.');
  html += `<h2 class="text-sm font-semibold mb-3">Running now</h2>`;
  html += running.length
    ? `<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${running
        .map((a) => `<button data-action="open" data-id="${esc(a.job.id)}" class="card p-3 text-left hover:border-accent/50"><div class="flex items-center justify-between"><span class="font-medium">${esc(a.role)}</span><span class="chip bg-accent/15 text-accent">${esc(a.model ?? 'model?')}</span></div><div class="text-sm text-muted mt-1 line-clamp-1">${esc(a.job.title)}</div><div class="text-[11px] text-muted mt-1">round ${a.round ?? '—'} · started ${ago(a.startedAt)}</div></button>`)
        .join('')}</div>`
    : empty('No agents running.');
  const ses = Object.values(sessions);
  html += `<h2 class="text-sm font-semibold mt-8 mb-3">Orchestrator sessions</h2>`;
  html += ses.length
    ? `<div class="card overflow-x-auto"><table class="tbl"><thead><tr><th>Session</th><th>Host</th><th>Jobs</th><th>Last seen</th></tr></thead><tbody>${ses
        .map((s) => {
          const live = Date.now() - Date.parse(s.heartbeat ?? s.since) < 30 * 60000;
          return `<tr><td class="font-mono text-xs"><span class="inline-block size-1.5 rounded-full ${live ? 'bg-ok' : 'bg-muted'} mr-1.5"></span>${esc(s.session)}</td><td>${esc(s.host ?? '—')}</td><td>${s.jobs.map((j) => `<button data-action="open" data-id="${esc(j.id)}" class="hover:text-accent mr-2">${esc(j.id)}</button>`).join('')}</td><td class="text-muted">${ago(s.heartbeat)}</td></tr>`;
        })
        .join('')}</tbody></table></div>`
    : empty('No sessions own a job right now.');
  const r = S.roster;
  if (r) {
    html += `<h2 class="text-sm font-semibold mt-8 mb-3">Roster</h2><div class="card overflow-x-auto"><table class="tbl"><thead><tr><th>Role</th><th>Model</th><th>Prompt hash</th><th>Repo addendum</th></tr></thead><tbody>${r.agents
      .map((a) => `<tr><td><div class="font-medium">${esc(a.role)}</div><div class="text-[11px] text-muted max-w-xl">${esc(a.description)}</div></td><td><span class="chip bg-raised">${esc(a.model)}</span></td><td class="font-mono text-xs text-muted">${esc(a.promptHash)}</td><td class="font-mono text-xs text-muted">${esc(a.addendum ?? '—')}</td></tr>`)
      .join('')}</tbody></table></div>`;
    html += `<h2 class="text-sm font-semibold mt-8 mb-3">Review panel</h2><div class="card overflow-x-auto"><table class="tbl"><thead><tr><th>Lens</th><th>Model</th><th>Runs when</th><th>Checklist</th><th>Hash</th></tr></thead><tbody>${r.reviewers
      .map((v) => `<tr><td class="font-medium">${esc(v.name)}</td><td><span class="chip bg-raised">${esc(v.model)}</span></td><td class="text-muted">${v.always ? 'always' : esc(v.when ?? 'when relevant')}</td><td class="font-mono text-xs text-muted">${esc(v.checklist ?? 'missing')}</td><td class="font-mono text-xs text-muted">${esc(v.checklistHash ?? '—')}</td></tr>`)
      .join('')}</tbody></table></div>`;
    if (r.learnings) html += `<p class="text-xs text-muted mt-3">Every agent also reads <code class="font-mono">${esc(r.learnings)}</code>.</p>`;
  }
  return html;
}

// ---------- analytics ----------
function viewAnalytics() {
  const s = S.stats;
  const sel = `<select data-action="window">${[['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['all', 'All time']]
    .map(([v, l]) => `<option value="${v}" ${S.window === v ? 'selected' : ''}>${l}</option>`)
    .join('')}</select>`;
  let html = pageHeader('Analytics', 'How Forge itself is performing. Comparable across repos because it measures the process, not the code.', sel);
  if (!s) return html + '<div class="text-muted text-sm">Loading…</div>';
  const q = s.quality;
  const cov = s.cost.reportingCoverage;
  const kpi = (label, value, sub = '') => `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub ? `<div class="text-[11px] text-muted">${sub}</div>` : ''}</div>`;
  const deltaCov = q.humanDeltaCoverage ?? { merged: 0, measured: 0 };
  html += `<div class="grid gap-3 grid-cols-2 lg:grid-cols-3">
    ${kpi('Jobs', num(s.counts.total), `${s.counts.active} active · ${s.counts.done} done · ${s.counts.cancelled} cancelled`)}
    ${kpi('First-pass review', pct(q.firstPassReviewRate), `avg ${q.avgRounds ?? '—'} rounds`)}
    ${kpi('Escalation rate', pct(q.escalationRate), `${q.humanReworks} human rework(s)`)}
    ${kpi('Human feedback on PRs', pct(q.humanFeedbackOnPrRate), 'PRs with unresolved threads')}
    ${kpi('Human delta after push', pct(q.humanDeltaRate ?? null), `median ${esc(q.medianHumanDeltaLines ?? '—')} lines · ${esc(deltaCov.measured)} of ${esc(deltaCov.merged)} merged measured`)}
    ${kpi('Median to PR', s.speed.medianMinutesToPr == null ? '—' : `${s.speed.medianMinutesToPr}m`, `to done ${s.speed.medianMinutesToDone ?? '—'}m`)}
    ${kpi('Verify first-pass', pct(q.verifyFirstPassRate), 'build/lint/test before review')}
    ${kpi('Tokens', tokensShort(s.cost.totalTokens), `${tokensShort(s.cost.avgTokensPerJob)} per job`)}
    ${kpi('API-equivalent cost', usd(s.cost.estCostUsd), `${usd(s.cost.avgCostPerJobUsd)} per job · coverage ${cov.withUsage}/${cov.agentRuns} (${cov.exact} exact)`)}
  </div>`;
  const maxRole = Math.max(1, ...Object.values(s.cost.byRole).map((v) => v.tokens));
  const usageTable = (title, rows, max) =>
    `<div class="card overflow-x-auto"><div class="px-3 pt-3 text-sm font-semibold">${title}</div><table class="tbl"><thead><tr><th>Name</th><th>Runs</th><th class="w-1/3">Tokens</th><th class="text-right">Est. cost</th></tr></thead><tbody>${Object.entries(rows)
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([k, v]) => `<tr><td class="font-medium">${esc(k)}</td><td class="tabular-nums">${v.runs}</td><td><div class="flex items-center gap-2"><div class="h-1.5 rounded-full ember-bar" style="width:${Math.max(2, (v.tokens / max) * 100)}%"></div><span class="text-[11px] text-muted tabular-nums">${tokensShort(v.tokens)}</span></div></td><td class="text-right tabular-nums">${usd(v.estCostUsd)}</td></tr>`)
      .join('') || '<tr><td colspan="4" class="text-muted">No usage recorded yet.</td></tr>'}</tbody></table></div>`;
  html += `<div class="grid gap-3 lg:grid-cols-2 mt-6">${usageTable('By role', s.cost.byRole, maxRole)}${usageTable('By model', s.cost.byModel, Math.max(1, ...Object.values(s.cost.byModel).map((v) => v.tokens)))}</div>`;
  const rv = Object.entries(s.reviewers);
  html += `<div class="card overflow-x-auto mt-6"><div class="px-3 pt-3 text-sm font-semibold">Review lenses</div><table class="tbl"><thead><tr><th>Lens</th><th>Reviews</th><th>Asked for changes</th></tr></thead><tbody>${rv
    .map(([k, v]) => `<tr><td class="font-medium">${esc(k)}</td><td class="tabular-nums">${v.reviews}</td><td class="tabular-nums">${pct(v.changeRate)}</td></tr>`)
    .join('') || '<tr><td colspan="3" class="text-muted">No reviews yet.</td></tr>'}</tbody></table></div>`;
  const jobs = S.data.jobs.filter((j) => j.kind !== 'eval' && j.usage?.totalTokens).sort((a, b) => b.usage.totalTokens - a.usage.totalTokens).slice(0, 25);
  if (jobs.length)
    html += `<div class="card overflow-x-auto mt-6"><div class="px-3 pt-3 text-sm font-semibold">Jobs by usage</div><table class="tbl"><thead><tr><th>Job</th><th>Rounds</th><th>Duration</th><th class="text-right">Tokens</th><th class="text-right">Est. cost</th><th>Usage source</th></tr></thead><tbody>${jobs
      .map((j) => `<tr class="hover:bg-raised cursor-pointer" data-action="open" data-id="${esc(j.id)}"><td>${esc(j.title)}</td><td class="tabular-nums">${j.round || '—'}</td><td class="tabular-nums">${dur((Date.parse(j.finishedAt ?? j.updatedAt) - Date.parse(j.createdAt)) || null)}</td><td class="text-right tabular-nums">${num(j.usage.totalTokens)}</td><td class="text-right tabular-nums">${usd(j.usage.estCostUsd)}</td><td class="text-muted">${j.usage.exact ? 'transcript' : 'reported total'}</td></tr>`)
      .join('')}</tbody></table></div>`;
  html += `<p class="text-[11px] text-muted mt-3">Costs are API list-price equivalents. Subscription plans are not billed per token.</p>`;
  return html;
}

// ---------- evals ----------
function viewEvals() {
  const e = S.evals;
  const right = `<button class="btn btn-primary" data-action="eval-run">Run eval</button>`;
  let html = pageHeader('Evals', 'Repeatable benchmarks of Forge. Runs are stamped with the Forge version and a hash of the repo’s Forge config, so you can tell whether a change helped.', right);
  if (!e) return html + '<div class="text-muted text-sm">Loading…</div>';
  html += `<div class="card p-4 mb-6 grid gap-3 md:grid-cols-4 items-end">
    <label class="flex flex-col gap-1 text-xs text-muted">Tags (comma separated)<input id="eval-tags" placeholder="replay, ui"></label>
    <label class="flex flex-col gap-1 text-xs text-muted">Tasks (comma separated)<input id="eval-tasks" placeholder="all"></label>
    <label class="flex flex-col gap-1 text-xs text-muted">Label<input id="eval-label" placeholder="baseline"></label>
    <div class="text-[11px] text-muted">${e.tasks.length} task(s) available. ${S.data.config.launcher ? 'A launcher is configured, so runs start immediately.' : 'Runs are queued for your orchestrator session.'}</div>
  </div>`;
  const runs = e.runs ?? [];
  if (runs.length) {
    const latest = runs[0].summary ?? {};
    const kpi = (label, value) => `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div></div>`;
    html += `<div class="grid gap-3 grid-cols-2 lg:grid-cols-5 mb-6">${kpi('Hidden-check pass', pct(latest.checkPassRate))}${kpi('Judge score', pct(latest.avgJudgeScore))}${kpi('First-pass review', pct(latest.firstPassRate))}${kpi('Avg tokens', tokensShort(latest.avgTokens))}${kpi('Avg cost', usd(latest.avgCostUsd))}</div>`;
    const opts = (sel) => runs.map((r) => `<option value="${esc(r.id)}" ${sel === r.id ? 'selected' : ''}>${esc(r.id)}${r.label ? ` (${esc(r.label)})` : ''}</option>`).join('');
    html += `<div class="card overflow-x-auto mb-6"><div class="px-3 pt-3 text-sm font-semibold">Runs</div><table class="tbl"><thead><tr><th>Run</th><th>Status</th><th>Config</th><th>Pass</th><th>Judge</th><th>First pass</th><th>Rounds</th><th>Escalated</th><th class="text-right">Tokens</th><th class="text-right">Cost</th><th class="text-right">Minutes</th></tr></thead><tbody>${runs
      .map((r) => {
        const s = r.summary ?? {};
        return `<tr><td><div class="font-mono text-xs">${esc(r.id)}</div><div class="text-[11px] text-muted">${esc(r.label ?? '')}</div></td><td>${toneChip(r.status === 'done' ? 'ok' : 'accent', r.status)}</td><td class="font-mono text-[11px] text-muted">${esc(r.configHash)}<br>v${esc(r.forgeVersion)}</td><td class="tabular-nums">${pct(s.checkPassRate)}</td><td class="tabular-nums">${pct(s.avgJudgeScore)}</td><td class="tabular-nums">${pct(s.firstPassRate)}</td><td class="tabular-nums">${s.avgRounds ?? '—'}</td><td class="tabular-nums">${pct(s.escalationRate)}</td><td class="text-right tabular-nums">${tokensShort(s.avgTokens)}</td><td class="text-right tabular-nums">${usd(s.avgCostUsd)}</td><td class="text-right tabular-nums">${s.avgMinutes ?? '—'}</td></tr>`;
      })
      .join('')}</tbody></table></div>`;
    html += `<div class="card p-4 mb-6"><div class="text-sm font-semibold mb-3">Compare runs</div><div class="flex flex-wrap gap-2 items-center"><select id="cmp-a">${opts(S.compare.a || runs[1]?.id)}</select><span class="text-muted">→</span><select id="cmp-b">${opts(S.compare.b || runs[0]?.id)}</select><button class="btn" data-action="compare">Compare</button></div>${S.compare.result ? compareTable(S.compare.result) : ''}</div>`;
  } else {
    html += empty('No eval runs yet. Add tasks with <code class="font-mono">forge eval mine --pr &lt;n&gt;</code> (replays a merged PR, using its tests as the hidden check) or <code class="font-mono">forge eval new</code>, then press Run eval.');
  }
  if (e.tasks.length)
    html += `<div class="card overflow-x-auto mt-6"><div class="px-3 pt-3 text-sm font-semibold">Tasks</div><table class="tbl"><thead><tr><th>Task</th><th>Tags</th><th>Hidden check</th><th>Rubric</th><th>Source</th></tr></thead><tbody>${e.tasks
      .map((t) => {
        const u = safeUrl(t.source?.url);
        return `<tr><td><div class="font-medium">${esc(t.title)}</div><div class="font-mono text-[11px] text-muted">${esc(t.name)}</div></td><td>${(t.tags ?? []).map((g) => `<span class="chip bg-raised text-muted mr-1">${esc(g)}</span>`).join('')}</td><td>${t.check?.patch || t.check?.files ? toneChip('ok', 'yes') : toneChip('muted', 'none')}</td><td>${t.rubric ? toneChip('info', 'judge') : '—'}</td><td>${u ? `<a class="text-accent" href="${esc(u)}" target="_blank" rel="noopener">PR #${esc(t.source.pr)}</a>` : '—'}</td></tr>`;
      })
      .join('')}</tbody></table></div>`;
  return html;
}

function compareTable(c) {
  const better = { checkPassRate: 1, avgJudgeScore: 1, firstPassRate: 1, avgRounds: -1, escalationRate: -1, avgTokens: -1, avgCostUsd: -1, avgMinutes: -1 };
  const rows = Object.entries(c.delta)
    .filter(([k]) => k in better)
    .map(([k, d]) => {
      const tone = d.change == null || d.change === 0 ? 'text-muted' : Math.sign(d.change) === better[k] ? 'text-ok' : 'text-bad';
      return `<tr><td>${esc(k)}</td><td class="tabular-nums">${esc(d.a ?? '—')}</td><td class="tabular-nums">${esc(d.b ?? '—')}</td><td class="tabular-nums ${tone}">${d.change == null ? '—' : (d.change > 0 ? '+' : '') + d.change}</td></tr>`;
    })
    .join('');
  return `<div class="text-[11px] text-muted mt-3">config ${esc(c.a.configHash)} → ${esc(c.b.configHash)} · Forge v${esc(c.a.forgeVersion)} → v${esc(c.b.forgeVersion)}</div><table class="tbl mt-2"><thead><tr><th>Metric</th><th>A</th><th>B</th><th>Δ</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------- drawer ----------
async function openDrawer(id, file = null) {
  S.drawer = { id, detail: null, file, content: null, tab: 'files' };
  document.getElementById('drawer').classList.remove('translate-x-full');
  document.getElementById('drawer-backdrop').classList.remove('hidden');
  await loadDrawer(true);
}

function closeDrawer() {
  S.drawer = { id: null, detail: null, file: null, content: null, tab: 'files' };
  document.getElementById('drawer').classList.add('translate-x-full');
  document.getElementById('drawer-backdrop').classList.add('hidden');
}

async function loadDrawer(full) {
  const id = S.drawer.id;
  if (!id) return;
  try {
    const detail = await api(`/api/jobs/${encodeURIComponent(id)}`);
    if (S.drawer.id !== id) return;
    const changed = JSON.stringify(detail) !== JSON.stringify(S.drawer.detail);
    S.drawer.detail = detail;
    if (!S.drawer.file) {
      const pref = ['spec.md', 'decision.md', 'build.md', 'request.md'].find((f) => detail.files.includes(f));
      S.drawer.file = pref ?? detail.files[0] ?? null;
    } else if (!detail.files.includes(S.drawer.file)) {
      const match = detail.files.find((f) => f.startsWith(S.drawer.file));
      if (match) S.drawer.file = match;
    }
    if (S.drawer.file && (full || changed)) await loadFile(S.drawer.file, false);
    if (full || changed) renderDrawer();
  } catch (e) {
    document.getElementById('drawer').innerHTML = `<div class="p-6">${banner(e.message)}</div>`;
  }
}

async function loadFile(rel, rerender = true) {
  S.drawer.file = rel;
  if (rel.endsWith('.html')) S.drawer.content = { html: true };
  else S.drawer.content = { text: await api(`/api/jobs/${encodeURIComponent(S.drawer.id)}/file?path=${encodeURIComponent(rel)}`) };
  if (rerender) renderDrawer();
}

function renderDrawer() {
  const d = S.drawer.detail;
  if (!d) return;
  const j = d.job;
  const id = encodeURIComponent(j.id);
  const prUrl = safeUrl(j.pr?.url);
  const srcUrl = safeUrl(j.source?.url);
  const fact = (k, v) => `<div><div class="text-[11px] text-muted">${k}</div><div class="text-sm font-mono break-all">${v}</div></div>`;
  const rounds = Object.keys(j.verdicts ?? {}).map(Number).sort((a, b) => a - b);
  const reviewers = [...new Set([...(j.reviewers ?? []), ...rounds.flatMap((r) => Object.keys(j.verdicts[r] ?? {}))])];
  const matrix = rounds.length || Object.keys(j.verify ?? {}).length
    ? `<div class="card overflow-x-auto"><table class="tbl"><thead><tr><th>Round</th><th>Verify</th>${reviewers.map((r) => `<th>${esc(r)}</th>`).join('')}</tr></thead><tbody>${[...new Set([...rounds, ...Object.keys(j.verify ?? {}).map(Number)])]
        .sort((a, b) => a - b)
        .map((r) => `<tr><td class="tabular-nums">${r}</td><td>${j.verify?.[r] ? toneChip(j.verify[r] === 'PASS' ? 'ok' : 'bad', j.verify[r]) : '—'}</td>${reviewers.map((name) => `<td>${j.verdicts?.[r]?.[name] ? toneChip(j.verdicts[r][name] === 'PASS' ? 'ok' : 'bad', j.verdicts[r][name]) : '—'}</td>`).join('')}</tr>`)
        .join('')}</tbody></table></div>`
    : '';
  const usageRows = Object.entries(j.usage?.byRole ?? {});
  const usage = usageRows.length
    ? `<div class="card overflow-x-auto"><table class="tbl"><thead><tr><th>Agent</th><th>Runs</th><th class="text-right">Tokens</th><th class="text-right">Output</th><th class="text-right">Tools</th><th class="text-right">Time</th><th class="text-right">Est. cost</th></tr></thead><tbody>${usageRows
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="tabular-nums">${v.runs}</td><td class="text-right tabular-nums">${num(v.tokens)}</td><td class="text-right tabular-nums">${v.output ? num(v.output) : '—'}</td><td class="text-right tabular-nums">${num(v.toolUses)}</td><td class="text-right tabular-nums">${dur(v.durationMs)}</td><td class="text-right tabular-nums">${usd(v.estCostUsd)}</td></tr>`)
        .join('')}<tr class="font-medium"><td>Total</td><td></td><td class="text-right tabular-nums">${num(j.usage.totalTokens)}</td><td></td><td></td><td></td><td class="text-right tabular-nums">${usd(j.usage.estCostUsd)}</td></tr></tbody></table></div>`
    : '';
  const files = d.files.map((f) => `<button data-action="file" data-file="${esc(f)}" class="block w-full text-left truncate rounded px-2 py-1 text-xs font-mono ${S.drawer.file === f ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}">${esc(f)}</button>`).join('');
  let content = '<div class="text-sm text-muted">No files yet.</div>';
  if (S.drawer.file && S.drawer.content?.html) content = `<iframe sandbox="allow-scripts" class="w-full h-[70vh] rounded-lg border border-line bg-white" src="/api/jobs/${id}/raw?path=${encodeURIComponent(S.drawer.file)}"></iframe>`;
  else if (S.drawer.file && S.drawer.content) {
    const t = S.drawer.content.text ?? '';
    content = S.drawer.file.endsWith('.md') ? `<div class="prose-md">${md(t)}</div>` : `<pre class="text-[12px] font-mono whitespace-pre-wrap break-words bg-raised rounded-lg p-3">${esc(t)}</pre>`;
  }
  const timeline = d.events
    .slice()
    .reverse()
    .map((e) => {
      const detail =
        e.type === 'transition' ? `${esc(e.from?.stage)}/${esc(e.from?.state)} → <b>${esc(e.to?.stage)}/${esc(e.to?.state)}</b>${e.to?.waitingOn ? ` (${esc(e.to.waitingOn)})` : ''}${e.reason ? ` · ${esc(e.reason)}` : ''}`
        : e.type?.startsWith('agent-') ? `${esc(e.role)} ${e.model ? `(${esc(e.model)})` : ''}${e.usage ? ` · ${tokensShort(e.usage.totalTokens)} tok` : ''}${e.summary ? ` · ${esc(e.summary)}` : ''}`
        : e.type === 'command' ? `${esc(e.name)} ${e.ok ? '✓' : `✗ exit ${esc(e.exit)}`} · ${dur(e.durationMs)}`
        : e.type === 'note' ? esc(e.text)
        : e.type === 'human' ? `<b>${esc(e.action)}</b>${e.note ? ` · ${esc(e.note)}` : ''}`
        : esc(JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['v', 'ts', 'type'].includes(k))))).slice(0, 240);
      return `<li class="flex gap-3 py-1.5 border-b border-line text-xs"><span class="text-muted whitespace-nowrap w-16 shrink-0">${ago(e.ts)}</span><span class="font-mono text-accent shrink-0 w-28 truncate">${esc(e.type)}</span><span class="min-w-0 break-words">${detail}</span></li>`;
    })
    .join('');
  document.getElementById('drawer').innerHTML = `<div class="p-5 md:p-6 flex flex-col gap-5">
    <div class="flex items-start justify-between gap-3"><div class="min-w-0"><h2 class="text-lg font-semibold">${esc(j.title)}</h2><div class="text-xs text-muted font-mono">${esc(j.id)}</div></div><button data-action="close" class="btn">${icon('close')}</button></div>
    <div class="flex flex-wrap gap-1.5">${toneChip('muted', STAGE_LABEL[j.stage] ?? j.stage)}${stateChip(j)}${j.round ? toneChip('muted', `round ${j.round}/${j.maxRounds}`) : ''}${prChip(j.pr)}${j.kind !== 'feature' ? toneChip('info', j.kind) : ''}</div>
    ${j.reason ? `<div class="text-sm text-muted">${esc(j.reason)}</div>` : ''}
    ${progressBar(j.progress)}
    <div class="grid grid-cols-2 md:grid-cols-3 gap-3">${fact('Branch', esc(j.branch ?? '—'))}${fact('Base', esc(j.base ?? '—'))}${fact('Port', esc(j.port ?? '—'))}${fact('Worktree', esc(j.worktree ?? '—'))}${fact('PR', prUrl ? `<a class="text-accent" href="${esc(prUrl)}" target="_blank" rel="noopener">#${esc(j.pr.number)}</a>` : '—')}${fact('Source', srcUrl ? `<a class="text-accent" href="${esc(srcUrl)}" target="_blank" rel="noopener">${esc(j.source.ref ?? 'link')}</a>` : esc(j.source?.ref ?? '—'))}${fact('Session', esc(j.owner?.session ?? '—'))}${fact('Created', ago(j.createdAt))}${fact('Updated', ago(j.updatedAt))}</div>
    ${matrix}
    ${budgetPanel(j, S.data?.config?.pipeline?.budget)}
    ${usage}
    <div class="flex gap-1 border-b border-line">${['files', 'timeline'].map((t) => `<button data-action="tab" data-value="${t}" class="px-3 py-2 text-sm -mb-px border-b-2 ${S.drawer.tab === t ? 'border-accent text-fg' : 'border-transparent text-muted'}">${t[0].toUpperCase() + t.slice(1)}${t === 'timeline' ? ` <span class="text-muted">${d.events.length}</span>` : ''}</button>`).join('')}</div>
    ${S.drawer.tab === 'files' ? `<div class="grid md:grid-cols-[180px_1fr] gap-4"><div class="flex md:flex-col gap-0.5 overflow-x-auto md:overflow-visible">${files}</div><div class="min-w-0">${content}</div></div>` : `<ul>${timeline}</ul>`}
  </div>`;
}

// ---------- events ----------
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-action]');
  if (!t) return;
  const a = t.dataset.action;
  if (a === 'open') return openDrawer(t.dataset.id, t.dataset.file ?? null);
  if (a === 'close') return closeDrawer();
  if (a === 'file') return loadFile(t.dataset.file);
  if (a === 'tab') {
    S.drawer.tab = t.dataset.value;
    return renderDrawer();
  }
  if (a === 'filter') {
    S.filter = t.dataset.value;
    store.set('filter', S.filter);
    return render();
  }
  if (a === 'layout') {
    S.layout = t.dataset.value;
    store.set('layout', S.layout);
    return render();
  }
  if (a === 'backlog-refresh') {
    S.backlog = await api('/api/backlog?refresh=1').catch((e) => ({ items: [], error: e.message }));
    return render();
  }
  if (a === 'req') {
    const id = t.dataset.id ?? null;
    const noteEl = id ? document.getElementById(`note-${id}`) : null;
    const text = t.dataset.text ?? noteEl?.value?.trim() ?? null;
    if (t.dataset.note && !text && ['answer', 'revise-spec'].includes(t.dataset.type)) return toast('Write something first.', true);
    return request(t.dataset.type, { job: id, text: text || null, args: t.dataset.ref ? { ref: t.dataset.ref } : {} });
  }
  if (a === 'eval-run') {
    const val = (id) => document.getElementById(id)?.value?.trim() || null;
    return request('eval-run', { args: { tags: val('eval-tags'), tasks: val('eval-tasks'), label: val('eval-label') } });
  }
  if (a === 'compare') {
    S.compare.a = document.getElementById('cmp-a').value;
    S.compare.b = document.getElementById('cmp-b').value;
    try {
      S.compare.result = await api(`/api/evals/compare?a=${encodeURIComponent(S.compare.a)}&b=${encodeURIComponent(S.compare.b)}`);
    } catch (e) {
      toast(e.message, true);
    }
    return render();
  }
});

document.addEventListener('change', (ev) => {
  if (ev.target.dataset?.action === 'window') {
    S.window = ev.target.value;
    store.set('window', S.window);
    loadView();
  }
});

document.getElementById('drawer-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());
document.getElementById('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('theme', next);
  renderNav();
});

function route() {
  const v = location.hash.replace(/^#\/?/, '') || 'pipeline';
  S.view = VIEWS.some((x) => x.id === v) ? v : 'pipeline';
  render();
  loadView();
}
window.addEventListener('hashchange', route);

route();
refresh();
setInterval(() => document.visibilityState === 'visible' && refresh(), 2000);
setInterval(() => document.visibilityState === 'visible' && ['analytics', 'evals', 'agents'].includes(S.view) && loadView(), 15000);
