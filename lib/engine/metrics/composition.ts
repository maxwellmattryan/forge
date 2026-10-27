// What filled an agent run's context, estimated from its Claude Code transcript: the start prefix split into the Forge
// prompt and the harness, then the messages by kind and tool, scaled to the API's exact input totals.
import type { ContextComposition, ContextPart } from '#core/types.ts';

/** Characters per token for text the API never counted for us (the output estimate in usage.ts too). */
export const CHARS_PER_TOKEN = 3.5;
/** What one image block in a tool result counts as: its base64 length would overstate it by far. */
export const IMAGE_CHARS = 5000;
/** Named tool entries kept; the rest fold into `other`. */
export const MAX_TOOL_PARTS = 12;

/** A stored tool name: anything else (and any MCP server name failing it) is counted under `other`. */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const OTHER = 'other';

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
/** A request's whole input: fresh, cache read and cache write. */
const inputOf = (u: any): number => count(u?.input_tokens) + count(u?.cache_read_input_tokens) + count(u?.cache_creation_input_tokens);
const isAssistant = (o: any): boolean => o?.type === 'assistant' && Boolean(o.message?.usage);
const keyOf = (o: any): unknown => o.message?.id ?? o.uuid;

/** A transcript tool name as the key it is grouped under. Transcript text is untrusted: only a checked name is kept. */
function toolKey(name: unknown): string {
  if (typeof name !== 'string') return OTHER;
  if (name.startsWith('mcp__')) {
    const end = name.indexOf('__', 5);
    if (end > 5) {
      const server = name.slice(5, end);
      return TOOL_NAME.test(server) ? `mcp:${server}` : OTHER;
    }
  }
  return TOOL_NAME.test(name) ? name : OTHER;
}

/** The text length of a user line's own words: string content, or its `text` blocks. */
function userText(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const c of content) if (c?.type === 'text' && typeof c.text === 'string') n += c.text.length;
  return n;
}

/** A tool result's size: its string, or its text blocks plus IMAGE_CHARS per image. */
function resultChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const c of content) {
    if (c?.type === 'text' && typeof c.text === 'string') n += c.text.length;
    else if (c?.type === 'image') n += IMAGE_CHARS;
  }
  return n;
}

/**
 * The composition of the last request of the span `since` starts (the same cursor rule as summarise in usage.ts),
 * or null when the file has no assistant request or the span none. The first request's total input is the start
 * prefix: its Forge share is the role prompt plus the brief at CHARS_PER_TOKEN, capped at the prefix, and the rest is
 * the harness. What the last request adds on top of it is shared over the messages in between in proportion to their
 * characters, by largest remainder, so the parts are integers that sum to its exact total. Messages before the span
 * count as `carried`: a resumed agent's earlier runs.
 */
export function composeContext(lines: readonly unknown[], opts: { since?: string | null; promptChars?: number } = {}): ContextComposition | null {
  const since = opts.since ? Date.parse(opts.since) : NaN;
  let skipping = !Number.isNaN(since);
  const inSpan: boolean[] = [];
  for (const line of lines) {
    const o = line as any;
    if (skipping && typeof o?.timestamp === 'string') skipping = !(Date.parse(o.timestamp) > since);
    inSpan.push(!skipping);
  }
  const first = lines.findIndex(isAssistant);
  if (first < 0) return null;
  let lastAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (inSpan[i] && isAssistant(lines[i])) {
      lastAt = i;
      break;
    }
  }
  if (lastAt < 0) return null;
  const prefix = inputOf((lines[first] as any).message.usage);
  const lastKey = keyOf(lines[lastAt]);
  const lastStart = lines.findIndex((l) => isAssistant(l) && keyOf(l) === lastKey);
  const total = inputOf((lines[lastStart] as any).message.usage);

  let briefChars = 0;
  for (let i = 0; i < first; i++) {
    const o = lines[i] as any;
    if (o?.type === 'user') briefChars += userText(o.message?.content);
  }
  const forgeEstimate = Math.ceil((count(opts.promptChars) + briefChars) / CHARS_PER_TOKEN);

  // Characters per category, in the order largest remainder breaks ties by: carried, tools, assistant, user.
  let carried = 0;
  let assistant = 0;
  let user = 0;
  const tools = new Map<string, number>();
  const toolNames = new Map<string, string>();
  for (let i = first; i < lastStart; i++) {
    const o = lines[i] as any;
    if (o?.type === 'assistant' && keyOf(o) === lastKey) continue;
    const content = o?.message?.content;
    if (o?.type === 'assistant' && Array.isArray(content)) {
      let n = 0;
      for (const c of content) {
        if (c?.type === 'text') n += String(c.text ?? '').length;
        else if (c?.type === 'thinking') n += String(c.thinking ?? '').length;
        else if (c?.type === 'tool_use') {
          if (typeof c.id === 'string') toolNames.set(c.id, toolKey(c.name));
          n += String(c.name ?? '').length + JSON.stringify(c.input ?? {}).length;
        }
      }
      if (inSpan[i]) assistant += n;
      else carried += n;
    } else if (o?.type === 'user') {
      let own = userText(content);
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type !== 'tool_result') continue;
          const n = resultChars(c.content);
          if (!inSpan[i]) own += n;
          else {
            const key = (typeof c.tool_use_id === 'string' ? toolNames.get(c.tool_use_id) : undefined) ?? OTHER;
            tools.set(key, (tools.get(key) ?? 0) + n);
          }
        }
      }
      if (inSpan[i]) user += userText(content);
      else carried += own;
    }
  }

  if (total < prefix) {
    const forgePrompt = Math.min(forgeEstimate, total);
    return { total, forgePrompt, harness: total - forgePrompt, carried: 0, tools: [], assistant: 0, user: 0 };
  }
  const forgePrompt = Math.min(prefix, forgeEstimate);
  const messages = total - prefix;
  const chars = [carried, ...tools.values(), assistant, user];
  const shares = largestRemainder(messages, chars);
  const out: ContextComposition = { total, forgePrompt, harness: prefix - forgePrompt, carried: 0, tools: [], assistant: 0, user: 0 };
  if (!shares) {
    out.harness += messages;
    return out;
  }
  out.carried = shares[0]!;
  out.tools = foldTools([...tools.keys()].map((name, i) => ({ name, tokens: shares[i + 1]! })));
  out.assistant = shares[tools.size + 1]!;
  out.user = shares[tools.size + 2]!;
  return out;
}

/**
 * `total` shared over `weights` in proportion, as integers that sum to it exactly: each gets its floor, and the
 * remainder goes one by one to the largest fractions, ties to the earlier entry. Null when the weights sum to 0.
 */
function largestRemainder(total: number, weights: number[]): number[] | null {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  // Integer arithmetic, so the remainders compare exactly: the products stay well inside 2^53.
  const floors = weights.map((w) => Math.floor((total * w) / sum));
  const rems = weights.map((w, i) => total * w - floors[i]! * sum);
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = weights.map((_, i) => i).sort((a, b) => rems[b]! - rems[a]! || a - b);
  for (const i of order) {
    if (left <= 0) break;
    floors[i] = floors[i]! + 1;
    left -= 1;
  }
  return floors;
}

/** Largest first (then by name), at most MAX_TOOL_PARTS named, the rest and any `other` as one last `other`, no zeros. */
function foldTools(parts: ContextPart[]): ContextPart[] {
  const named = parts.filter((p) => p.name !== OTHER).sort((a, b) => b.tokens - a.tokens || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const rest = parts.filter((p) => p.name === OTHER).concat(named.slice(MAX_TOOL_PARTS)).reduce((n, p) => n + p.tokens, 0);
  const out = named.slice(0, MAX_TOOL_PARTS).filter((p) => p.tokens > 0);
  if (rest > 0) out.push({ name: OTHER, tokens: rest });
  return out;
}
