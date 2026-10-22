// Config sinks (docs/CONFIG.md "Config sinks"): `components[].config` lists where a component takes
// its configuration (env vars, an env file, a JSON/YAML/TOML file, a project script), and Forge
// renders them with the job's values before each of that component's commands. This module is pure:
// validation, expressions and renderers that return strings. Writing, git and processes live in
// config-sinks-apply.ts. No import from schema.ts: components.ts loads this while schema.ts loads it.

import { PROTO_KEYS, deepMerge, isMap, show } from './shape.ts';
import { isInsidePath } from './util.ts';
import * as yaml from './yaml.ts';

const SINK_KINDS = ['env', 'env-file', 'file', 'command'] as const;
export const SINK_FORMATS = ['json', 'yaml', 'toml'] as const;
export const SINK_MODES = ['template', 'merge'] as const;

export type SinkFormat = (typeof SINK_FORMATS)[number];
export type SinkMode = (typeof SINK_MODES)[number];

/** The job values an expression can name; `component.dir` is the absolute `<worktree>/<path>`. */
export const EXPRESSION_ROOTS = ['job', 'port', 'worktree', 'branch', 'base', 'component.name', 'component.path', 'component.dir'] as const;
/** Namespaces held for later features; naming one is a render error citing the issue. */
const RESERVED_NAMESPACES: Record<string, string> = { endpoint: '#195', backing: '#193' };
const RESERVED_FEATURES: Record<string, string> = { endpoint: 'endpoints', backing: 'backing services' };

export interface ExprContext {
  job: string;
  port: number | null;
  worktree: string;
  branch: string;
  base: string;
  component: { name: string; path: string; dir: string };
  /** A declared secret's value (lib/secret-refs.ts), resolved only when an expression reaches it. */
  secret?: (name: string) => string;
}

/** `{secret.NAME}`: NAME as declared under `secrets`. */
const SECRET_REF = /^secret\.([A-Za-z_][A-Za-z0-9_]*)$/;
const secretOf = (name: string): string | null => SECRET_REF.exec(name)?.[1] ?? null;

/** A string, number, boolean or null, or a map of those (merge `values`). */
export type SinkValue = string | number | boolean | null | { [k: string]: SinkValue };

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An env-file value written without quotes. */
const BARE_VALUE = /^[A-Za-z0-9_./:@%+,-]*$/;

const reservedOf = (name: string): string | null => Object.keys(RESERVED_NAMESPACES).find((ns) => name === ns || name.startsWith(`${ns}.`)) ?? null;
const isKnownRoot = (name: string): boolean => (EXPRESSION_ROOTS as readonly string[]).includes(name);

// ---------- validation ----------

/** Why `name` can't be an env, env-file or command-values variable, or null. */
function nameProblem(name: string): string | null {
  if (!ENV_NAME.test(name)) return 'must match ^[A-Za-z_][A-Za-z0-9_]*$';
  if (name.startsWith('FORGE_') || name === 'PORT') return "can't start with FORGE_ or be PORT, which Forge sets itself";
  return null;
}

/** The `{x}` expressions of `v` whose root is neither known nor reserved, nor a secret reference. */
function unknownExpressions(v: string): string[] {
  const out: string[] = [];
  for (const m of v.matchAll(/\{([^{}]*)\}/g)) {
    const name = m[1];
    if (IDENTIFIER.test(name) && !isKnownRoot(name) && !reservedOf(name) && !secretOf(name)) out.push(`{${name}}`);
  }
  return out;
}

/** The `{secret.NAME}` references of `v` that name no declared secret; none when `declared` is not given. */
function undeclaredSecrets(v: string, declared: ReadonlySet<string> | undefined): string[] {
  if (!declared) return [];
  const out: string[] = [];
  for (const m of v.matchAll(/\{([^{}]*)\}/g)) {
    const s = secretOf(m[1]);
    if (s && !declared.has(s)) out.push(`{secret.${s}}`);
  }
  return out;
}

/** Every unknown-expression and undeclared-secret problem of one string value. */
function expressionProblems(v: string, at: string, declared: ReadonlySet<string> | undefined): string[] {
  return [
    ...unknownExpressions(v).map((e) => `${at} uses unknown expression ${e}; known roots are ${EXPRESSION_ROOTS.map((r) => `{${r}}`).join(' ')}`),
    ...undeclaredSecrets(v, declared).map((e) => `${at} names undeclared secret ${e}; declare it under secrets`),
  ];
}

/** Problems with one flat `name: expression` map (env, env-file values, command values). */
function flatProblems(values: unknown, at: string, declared?: ReadonlySet<string>): string[] {
  if (!isMap(values)) return [`${at} must be a map of variable names to strings (got ${show(values, Infinity)})`];
  const problems: string[] = [];
  for (const [name, v] of Object.entries(values)) {
    const bad = nameProblem(name);
    if (bad) problems.push(`${at} variable ${show(name, Infinity)} ${bad}`);
    if (isMap(v)) problems.push(`${at}.${name} must be a string; quote the expression ("{port}"), since unquoted YAML reads {port} as a map (got ${show(v, Infinity)})`);
    else if (typeof v !== 'string') problems.push(`${at}.${name} must be a string (got ${show(v, Infinity)})`);
    else problems.push(...expressionProblems(v, `${at}.${name}`, declared));
  }
  return problems;
}

/** Problems with merge `values`: a nested map whose leaves are strings, numbers, booleans or null. */
function nestedProblems(values: unknown, at: string, declared?: ReadonlySet<string>): string[] {
  if (!isMap(values)) return [`${at} must be a map (got ${show(values, Infinity)})`];
  const problems: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    const here = `${at}.${k}`;
    if (PROTO_KEYS.has(k)) problems.push(`${here} is not an allowed key`);
    if (isMap(v)) problems.push(...nestedProblems(v, here, declared));
    else if (typeof v === 'string') problems.push(...expressionProblems(v, here, declared));
    else if (v !== null && typeof v !== 'number' && typeof v !== 'boolean') problems.push(`${here} must be a string, number, boolean, null or a map of those (got ${show(v, Infinity)})`);
  }
  return problems;
}

const pathProblem = (p: unknown, at: string): string | null => (isInsidePath(p) ? null : `${at} must be a relative path inside the component's directory (got ${show(p, Infinity)})`);

/**
 * Every problem with a component's `config` list, labelled `at` (`components "api".config`), in the
 * form validateConfig reports. `component` is the entry it sits on: a member-repo component has no
 * checkout in the job's worktree, so sinks are refused there. With `secretNames` (the declared
 * `secrets`), a `{secret.NAME}` naming none of them is a problem too.
 */
export function sinkProblems(sinks: unknown, at: string, component: { repo?: unknown }, secretNames?: ReadonlySet<string>): string[] {
  if (component.repo !== undefined && component.repo !== null) return [`${at} is only for a root-repo component; this one sets repo ${show(component.repo, Infinity)}`];
  if (!Array.isArray(sinks)) return [`${at} must be a list of sinks (got ${show(sinks, Infinity)})`];
  const problems: string[] = [];
  sinks.forEach((sink: unknown, i: number) => {
    const s = `${at}[${i}]`;
    const kinds = isMap(sink) ? SINK_KINDS.filter((k) => sink[k] !== undefined) : [];
    if (!isMap(sink) || kinds.length !== 1) return problems.push(`${s} must be a map with exactly one of ${SINK_KINDS.join(' | ')} (got ${show(sink, Infinity)})`);
    const kind = kinds[0];
    if (kind === 'env') return problems.push(...flatProblems(sink.env, `${s}.env`, secretNames));
    if (kind === 'env-file') {
      const bad = pathProblem(sink['env-file'], `${s}.env-file`);
      if (bad) problems.push(bad);
      if (sink.values !== undefined) problems.push(...flatProblems(sink.values, `${s}.values`, secretNames));
      return;
    }
    if (kind === 'command') {
      if (typeof sink.command !== 'string' || !sink.command.trim()) problems.push(`${s}.command must be a non-empty shell command (got ${show(sink.command, Infinity)})`);
      if (sink.values !== undefined) problems.push(...flatProblems(sink.values, `${s}.values`, secretNames));
      return;
    }
    const f = sink.file;
    if (!isMap(f)) return problems.push(`${s}.file must be a map with path, format and mode (got ${show(f, Infinity)})`);
    const bad = pathProblem(f.path, `${s}.file.path`);
    if (bad) problems.push(bad);
    const format = (SINK_FORMATS as readonly unknown[]).includes(f.format) ? (f.format as SinkFormat) : null;
    const mode = (SINK_MODES as readonly unknown[]).includes(f.mode) ? (f.mode as SinkMode) : null;
    if (!format) problems.push(`${s}.file.format must be one of ${SINK_FORMATS.join(' | ')} (got ${show(f.format, Infinity)})`);
    if (!mode) problems.push(`${s}.file.mode must be one of ${SINK_MODES.join(' | ')} (got ${show(f.mode, Infinity)})`);
    if (f.from !== undefined && f.from !== null) {
      const badFrom = pathProblem(f.from, `${s}.file.from`);
      if (badFrom) problems.push(badFrom);
    }
    if (format === 'toml' && mode === 'merge') problems.push(`${s}.file: toml supports mode template only (Forge has no TOML parser); use mode: template`);
    if (mode === 'template') {
      if (f.from === undefined || f.from === null) problems.push(`${s}.file.from is required with mode: template`);
      if (sink.values !== undefined) problems.push(`${s}.values is not allowed with mode: template; fill the template with expressions instead`);
    }
    if (mode === 'merge') {
      if (sink.values === undefined) problems.push(`${s}.values is required with mode: merge`);
      else problems.push(...nestedProblems(sink.values, `${s}.values`, secretNames));
    }
  });
  return problems;
}

// ---------- expressions ----------

/** The value of one known root or secret reference; an unknown or reserved root throws. */
function lookup(name: string, ctx: ExprContext): string | number | null {
  switch (name) {
    case 'job':
      return ctx.job;
    case 'port':
      return ctx.port;
    case 'worktree':
      return ctx.worktree;
    case 'branch':
      return ctx.branch;
    case 'base':
      return ctx.base;
    case 'component.name':
      return ctx.component.name;
    case 'component.path':
      return ctx.component.path;
    case 'component.dir':
      return ctx.component.dir;
  }
  const secret = secretOf(name);
  if (secret) {
    if (!ctx.secret) throw new Error(`{${name}} needs a declared secret`);
    return ctx.secret(secret);
  }
  const ns = reservedOf(name);
  if (ns) throw new Error(`{${name}} needs ${RESERVED_FEATURES[ns]} (${RESERVED_NAMESPACES[ns]}), which this Forge does not support yet`);
  throw new Error(`unknown expression {${name}}; known roots are ${EXPRESSION_ROOTS.map((r) => `{${r}}`).join(' ')}`);
}

const asString = (v: string | number | null): string => (v === null ? '' : String(v));

/**
 * A config value: a string that is exactly one expression takes that expression's type (`"{port}"`
 * is the number, or null without a port); any other string is interpolated, null as ''. Braces
 * around anything that isn't an identifier path are literal.
 */
export function resolveValue(v: string, ctx: ExprContext): string | number | null {
  const whole = /^\{([^{}]*)\}$/.exec(v);
  if (whole && IDENTIFIER.test(whole[1])) return lookup(whole[1], ctx);
  return v.replace(/\{([^{}]*)\}/g, (m, name: string) => (IDENTIFIER.test(name) ? asString(lookup(name, ctx)) : m));
}

/** resolveValue stringified: what env, env-file and command values carry. */
export const resolveString = (v: string, ctx: ExprContext): string => asString(resolveValue(v, ctx));

/**
 * Fills a template file's text: only known and reserved roots are recognised, so JSON objects,
 * TOML inline tables and literal braces survive. A string is escaped as the content of a double-
 * quoted JSON string (valid inside quotes in JSON, YAML and TOML basic strings); a number or null is bare.
 */
export function fillTemplate(text: string, ctx: ExprContext): string {
  return text.replace(/\{([^{}]*)\}/g, (m, name: string) => {
    if (!IDENTIFIER.test(name) || (!isKnownRoot(name) && !reservedOf(name) && !secretOf(name))) return m;
    const v = lookup(name, ctx);
    return typeof v === 'string' ? JSON.stringify(v).slice(1, -1) : String(v);
  });
}

// ---------- renderers ----------

/** `NAME=value` lines in `values` order: bare when safe, else double-quoted with \\, \" and \n escaped. */
export function renderEnvFile(values: Record<string, string>, ctx: ExprContext): string {
  const lines = Object.entries(values).map(([name, expr]) => {
    const v = resolveString(expr, ctx);
    return `${name}=${BARE_VALUE.test(v) ? v : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`}`;
  });
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/** `values` with every string resolved (typed), as a fresh object. */
function resolveValues(values: Record<string, SinkValue>, ctx: ExprContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (PROTO_KEYS.has(k)) throw new Error(`config sink values key ${JSON.stringify(k)} is not allowed`);
    out[k] = isMap(v) ? resolveValues(v, ctx) : typeof v === 'string' ? resolveValue(v, ctx) : v;
  }
  return out;
}

/**
 * The merge base parsed in `format`: a map, or `{}` for null text. A parse failure keeps the parser's
 * message (which quotes the text around the error) as `cause` only, so the caller decides whether
 * the base is safe to quote.
 */
function parseBase(format: SinkFormat, text: string | null): Record<string, unknown> {
  if (text === null || !text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = format === 'json' ? JSON.parse(text) : yaml.parse(text);
  } catch (e) {
    throw new Error(`the merge base does not parse as ${format}`, { cause: e });
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isMap(parsed)) throw new Error(`the merge base is not a map`);
  return parsed;
}

/**
 * `values` (resolved) deep-merged over `baseText` and serialised in `format`: json as 2-space JSON
 * with a trailing newline, yaml through lib/yaml.ts. toml is never merged (validation refuses it).
 */
export function renderMerge(format: SinkFormat, baseText: string | null, values: Record<string, SinkValue>, ctx: ExprContext): string {
  if (format === 'toml') throw new Error('toml supports mode template only');
  const merged = deepMerge(parseBase(format, baseText), resolveValues(values, ctx), { base: 'merge base', over: 'config sink values' });
  return format === 'json' ? `${JSON.stringify(merged, null, 2)}\n` : yaml.stringify(merged);
}

/** `text` filled as a template; a json result must parse, or the error names `from` (never the filled text). */
export function renderTemplate(format: SinkFormat, text: string, ctx: ExprContext, from: string): string {
  const filled = fillTemplate(text, ctx);
  if (format === 'json') {
    try {
      JSON.parse(filled);
    } catch {
      throw new Error(`config sink template ${from} does not fill to valid JSON; check the quoting around its expressions`);
    }
  }
  return filled;
}
