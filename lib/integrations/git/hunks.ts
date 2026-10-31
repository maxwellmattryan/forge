// Unified-diff spans: which base-side lines a diff touches, per path, from git's `-U0` output or a
// 3-line-context `gh pr diff`. Only paths and line numbers leave it, never diff text, because the diff
// may come from a fork PR's author (docs/architecture/overlap.md).

/** A base-side line span, 1-based and inclusive: `[k, k+1]` is the gap after line k, where an insertion lands. */
export type Span = [number, number];

const HUNK = /^@@ -(\d{1,9})(?:,(\d{1,9}))? \+\d{1,9}(?:,(\d{1,9}))? @@/;

/**
 * The path a `---` or `+++` line names, its `a/` or `b/` prefix stripped: null for `/dev/null` and for
 * a C-quoted path (git quotes one with a control or non-UTF-8 byte; Forge never unquotes it).
 */
function sidePath(line: string): string | null {
  const rest = line.slice(4);
  // git ends a path that has a space with a tab; what follows it is not part of the path.
  const tab = rest.indexOf('\t');
  const p = tab < 0 ? rest : rest.slice(0, tab);
  if (!p || p === '/dev/null' || p.startsWith('"')) return null;
  return /^[ab]\//.test(p) ? p.slice(2) || null : p;
}

/** `diff --git a/P b/P`'s P when both sides name the same path (no rename), else null. */
function gitLinePath(line: string): string | null {
  const s = line.slice('diff --git '.length);
  if (!s.startsWith('a/') || (s.length - 5) % 2 !== 0) return null;
  const p = s.slice(2, 2 + (s.length - 5) / 2);
  return p && s === `a/${p} b/${p}` ? p : null;
}

/** Adds `[a, b]` to `spans`, merging it into the last span when they touch or overlap (marks arrive in line order). */
function mark(spans: Span[], a: number, b: number): void {
  const last = spans[spans.length - 1];
  if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
  else spans.push([a, b]);
}

/**
 * Base-side spans per path. A hunk body is walked counting old-side lines: each `-` line marks its own
 * line; a run of `+` lines with no `-` in the same block (a pure insertion after old line k) marks
 * `[k, k+1]`; adjacent marks merge. A new file's path comes from `+++`, a deleted file's from `---`. A
 * binary file has no hunks and so no spans, and a C-quoted path is dropped.
 */
export function diffSpans(text: string): Map<string, Span[]> {
  const out = new Map<string, Span[]>();
  let minus: string | null = null;
  // The current file's spans; null while no file is open or its path was dropped.
  let spans: Span[] | null = null;
  let old = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let removed = false;
  let added = false;
  const endBlock = () => {
    if (spans && added && !removed) mark(spans, old, old + 1);
    removed = false;
    added = false;
  };
  for (const line of text.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0];
      if (c === '-') {
        old++;
        oldLeft--;
        removed = true;
        if (spans) mark(spans, old, old);
        continue;
      }
      if (c === '+') {
        newLeft--;
        added = true;
        continue;
      }
      if (c === '\\') continue;
      if (c === ' ' || line === '') {
        endBlock();
        old++;
        oldLeft--;
        newLeft--;
        continue;
      }
      // A line that can't be in a hunk body ends a malformed hunk early.
      oldLeft = 0;
      newLeft = 0;
    }
    endBlock();
    if (line.startsWith('diff --git ')) {
      minus = null;
      spans = null;
    } else if (line.startsWith('--- ')) {
      minus = sidePath(line);
      spans = null;
    } else if (line.startsWith('+++ ')) {
      // `+++ /dev/null` is a deleted file, named by its `---` side.
      const p = line.slice(4).startsWith('/dev/null') ? minus : sidePath(line);
      spans = p === null ? null : (out.get(p) ?? []);
      if (p !== null && spans) out.set(p, spans);
    } else {
      const h = HUNK.exec(line);
      if (!h) continue;
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      // With a count of 0 the start is the line an insertion follows; otherwise it is the first old line.
      old = count === 0 ? start : start - 1;
      oldLeft = count;
      newLeft = h[3] === undefined ? 1 : Number(h[3]);
    }
  }
  endBlock();
  for (const [p, s] of out) if (!s.length) out.delete(p);
  return out;
}

/** Every path a diff names, binary files included: `diff --git` when both sides agree, `rename from|to`, `---` and `+++`. Sorted, unique; C-quoted paths dropped. */
export function diffPaths(text: string): string[] {
  const out = new Set<string>();
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of text.split('\n')) {
    // Hunk bodies are skipped by their counts, so a changed line that reads like a header is never one.
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0];
      if (c === '-') {
        oldLeft--;
        continue;
      }
      if (c === '+') {
        newLeft--;
        continue;
      }
      if (c === '\\') continue;
      if (c === ' ' || line === '') {
        oldLeft--;
        newLeft--;
        continue;
      }
      oldLeft = 0;
      newLeft = 0;
    }
    let p: string | null = null;
    if (line.startsWith('diff --git ')) p = gitLinePath(line);
    else if (line.startsWith('--- ') || line.startsWith('+++ ')) p = sidePath(line);
    else if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
      const v = line.slice(line.startsWith('rename from ') ? 12 : 10);
      p = v.startsWith('"') ? null : v;
    } else {
      const h = HUNK.exec(line);
      if (h) {
        oldLeft = h[2] === undefined ? 1 : Number(h[2]);
        newLeft = h[3] === undefined ? 1 : Number(h[3]);
      }
    }
    if (p) out.add(p);
  }
  return [...out].sort();
}

/** For each intersecting pair of `a` and `b`, the span covering both: `[min(start), max(end)]`. Sorted, unique. */
export function sharedSpans(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  const seen = new Set<string>();
  for (const [s1, e1] of a)
    for (const [s2, e2] of b) {
      if (s1 > e2 || s2 > e1) continue;
      const s: Span = [Math.min(s1, s2), Math.max(e1, e2)];
      const k = `${s[0]}:${s[1]}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
  return out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}
