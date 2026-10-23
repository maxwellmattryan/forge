// Version steps: a shape's version is its append-only list of named steps, length plus one. Two
// branches that each append a step conflict at the end of the list, where keeping both in merge order
// gives a valid list; a hand-set version number would merge cleanly into a broken one instead.

/** One named upgrade: entry `i` of a list takes a value from version `i + 1` to `i + 2`. */
export interface Step {
  readonly id: string;
  readonly up: (value: any) => any;
}

/** The version a list describes: version 1 is a shape's first form and has no step. */
export const versionOf = (steps: readonly unknown[]): number => steps.length + 1;

/** `value` upgraded from version `from` through every later step, in order. Version fields are the caller's. */
export function runSteps(steps: readonly Step[], value: any, from: number): any {
  let out = value;
  for (let i = Math.max(1, from) - 1; i < steps.length; i++) out = steps[i]!.up(out);
  return out;
}

const STEP_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_ID = 60;

/** One message per duplicate id and per id that is not kebab-case of at most 60 characters; [] for a valid list. */
export function stepProblems(list: readonly { readonly id: string }[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  list.forEach(({ id }, i) => {
    if (typeof id !== 'string' || !STEP_ID.test(id) || id.length > MAX_ID) problems.push(`id \`${id}\` at ${i} is not kebab-case of at most ${MAX_ID} characters`);
    if (seen.has(id)) problems.push(`duplicate id \`${id}\` at ${i}`);
    seen.add(id);
  });
  return problems;
}
