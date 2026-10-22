// Small leftovers with no better home: the current timestamp and a short random id.

export const now = (): string => new Date().toISOString();

export function shortId(): string {
  return Math.random().toString(36).slice(2, 6);
}
