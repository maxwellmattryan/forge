// The Office page's report card model: which card a mandate shows (the live one, or a closed mandate's
// closing summary card when the server sent one), how one figure renders (a value, pending, or nothing to
// measure, never 0 for either), and the interventions by gate in WAITING_ON order then none.
import { WAIT_LABEL } from './labels.ts';
import type { CardFigure, MandateReportCard, MandateRow, WaitingOn } from './types.ts';

/** One figure as the page renders it. */
export type FigureView = { kind: 'value'; value: number } | { kind: 'pending' } | { kind: 'none' };

/** A card figure's view: 'pending' and null never read as 0. */
export function figureView(f: CardFigure | number | null): FigureView {
  if (f === 'pending') return { kind: 'pending' };
  if (f === null) return { kind: 'none' };
  return { kind: 'value', value: f };
}

/** Where the shown card comes from: computed now, the closing summary's at close, or its rewrite once the outcomes were final. */
export type CardSource = 'live' | 'close' | 'final';

/** The one card a mandate's section shows, and its source line's time (null for live). */
export function shownCard(m: Pick<MandateRow, 'state' | 'card' | 'closing'>): { card: MandateReportCard; source: CardSource; at: string | null } {
  if (m.state !== 'closed' || !m.closing) return { card: m.card, source: 'live', at: null };
  const { card, outcomesFinalAt } = m.closing;
  return outcomesFinalAt === null ? { card, source: 'close', at: card.at } : { card, source: 'final', at: outcomesFinalAt };
}

/** The gates with interventions, in WAIT_LABEL's (WAITING_ON's) order then none; a zero count is dropped. */
export function gateCounts(byGate: MandateReportCard['interventions']['byGate']): { key: WaitingOn | 'none'; count: number }[] {
  const keys = [...(Object.keys(WAIT_LABEL) as WaitingOn[]), 'none' as const];
  return keys.flatMap((key) => {
    const count = byGate[key] ?? 0;
    return count > 0 ? [{ key, count }] : [];
  });
}

/** A card time as a local date. */
export const cardDate = (iso: string): string => new Date(iso).toLocaleDateString();
