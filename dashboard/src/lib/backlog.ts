// The Backlog view's readiness column, kept here so it is tested without the Svelte compiler.
import type { BacklogItem } from './types.ts';

export type Readiness = 'needs-info' | 'ready' | 'untriaged';

/**
 * The tracker's mark wins: a marked item needs info whatever the cache says. Ready only when the last
 * triage said so and the item is unmarked; a human who cleared a mark by hand sees it untriaged.
 */
export function readiness(item: Pick<BacklogItem, 'needsInfo' | 'triage'>): Readiness {
  if (item.needsInfo) return 'needs-info';
  if (item.triage?.ready) return 'ready';
  return 'untriaged';
}
