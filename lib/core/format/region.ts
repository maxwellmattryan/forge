// Generated regions in docs: the text between a start and an end marker, which a generator replaces whole.
import { ForgeError } from '../errors.ts';

/** `text` with everything between `start` and `end` replaced by `body` on lines of its own; `file` names it in the error. */
export function replaceRegion(text: string, start: string, end: string, body: string, file: string): string {
  const s = text.indexOf(start);
  const e = s < 0 ? -1 : text.indexOf(end, s + start.length);
  if (s < 0 || e < 0) throw new ForgeError(`${file} has no ${start} … ${end} region`);
  return `${text.slice(0, s + start.length)}\n${body}\n${text.slice(e)}`;
}
