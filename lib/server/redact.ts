// Known values taken out of what the server pages and streams: a log or transcript page, and a
// per-stream reader of a job's known values.
import { loadConfig } from '#core/config/load.ts';
import { knownValues, redactKnown } from '#engine/guard/known-secrets.ts';

/** A log or transcript page with known values taken out of each line; offsets stay the file's. */
export function redactPage<P extends { lines: { offset: number; line: string }[] }>(page: P, known: readonly string[]): P {
  return known.length ? { ...page, lines: page.lines.map((l) => ({ ...l, line: redactKnown(l.line, known) })) } : page;
}

/**
 * A reader of a job's known values for one open stream: a value a sink resolves while the stream is
 * open is redacted from then on. Re-read at most once a second, since a tail is hundreds of lines.
 */
export function knownReader(root: string, id: string): () => string[] {
  let cached: { at: number; values: string[] } | null = null;
  return () => {
    if (!cached || Date.now() - cached.at > 1000) cached = { at: Date.now(), values: knownValues(root, id, loadConfig(root).config) };
    return cached.values;
  };
}
