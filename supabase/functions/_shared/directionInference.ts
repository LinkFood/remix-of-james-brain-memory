/**
 * Shared direction inference for UW flow alerts.
 *
 * Extracted from ct-print-grader so other functions (notably
 * ct-prediction-backfill) can re-apply the exact same logic to existing
 * track rows without copy-paste drift.
 *
 * The RepeatedHits-on-null-flag branch (commit 05792c0) is the load-bearing
 * fix: cheap OTM/0DTE buyers routinely lift at the bid (MM willing to sell),
 * which inverts total_bid_side_prem and bear-tagged a +475% NVDA 0DTE call
 * on 2026-04-24. Trust the rule's directional intent: call=ask-aggressive,
 * put=bid-aggressive when no explicit aggressor flag is present.
 */

export type Direction = 'up' | 'down';

export interface FlowAlertRow {
  alert_id: string;
  ticker: string;
  side: string | null;
  is_ask: boolean | null;
  is_bid: boolean | null;
  strike?: number | null;
  expiry?: string | null;
  executed_at?: string | null;
  ingested_at?: string;
  option_symbol?: string | null;
  price?: number | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any;
}

export interface DirectionInference {
  direction: Direction;
  source: string;
}

export function inferDirection(row: FlowAlertRow): DirectionInference | null {
  const side = (row.side ?? '').toLowerCase();
  if (side !== 'call' && side !== 'put') return null;

  const raw = row.raw ?? {};
  const askPremRaw = raw['total_ask_side_prem'];
  const bidPremRaw = raw['total_bid_side_prem'];
  const askPrem = askPremRaw == null ? null : Number(askPremRaw);
  const bidPrem = bidPremRaw == null ? null : Number(bidPremRaw);
  const askPremValid = askPrem !== null && Number.isFinite(askPrem);
  const bidPremValid = bidPrem !== null && Number.isFinite(bidPrem);

  // Mid-print check: both sides effectively zero — no directional signal.
  if (askPremValid && bidPremValid && askPrem < 1 && bidPrem < 1) {
    return null;
  }

  // Determine ask-vs-bid pressure.
  let aggressiveAsk = false;
  let aggressiveBid = false;
  let sourceTag: 'ask' | 'bid' | null = null;

  if (row.is_ask === true) {
    aggressiveAsk = true;
    sourceTag = 'ask';
  } else if (row.is_bid === true) {
    aggressiveBid = true;
    sourceTag = 'bid';
  } else {
    // No explicit aggressor flag. UW's RepeatedHits* rules ARE accumulation
    // by definition — repeated fills into the same contract. Cheap OTM/0DTE
    // buyers routinely lift at the bid (MM willing to sell), which inverts
    // total_bid_side_prem and bear-tagged a +475% NVDA 0DTE call on 2026-04-24.
    // Trust the rule's directional intent: call=ask-aggressive, put=bid-aggressive.
    const alertRule = typeof raw['alert_rule'] === 'string' ? raw['alert_rule'] : '';
    const isRepeatedHits = alertRule.startsWith('RepeatedHits');
    if (isRepeatedHits) {
      if (side === 'call') { aggressiveAsk = true; sourceTag = 'ask'; }
      else { aggressiveBid = true; sourceTag = 'bid'; }
    } else if (askPremValid && bidPremValid) {
      if (askPrem > bidPrem) {
        aggressiveAsk = true;
        sourceTag = 'ask';
      } else if (bidPrem > askPrem) {
        aggressiveBid = true;
        sourceTag = 'bid';
      } else {
        return null; // tied, no edge
      }
    } else if (askPremValid && askPrem > 0 && (!bidPremValid || bidPrem === 0)) {
      aggressiveAsk = true;
      sourceTag = 'ask';
    } else if (bidPremValid && bidPrem > 0 && (!askPremValid || askPrem === 0)) {
      aggressiveBid = true;
      sourceTag = 'bid';
    } else {
      return null;
    }
  }

  // Map side + ask/bid → direction.
  let direction: Direction;
  if (aggressiveAsk) {
    direction = side === 'call' ? 'up' : 'down';
  } else if (aggressiveBid) {
    // call selling = bearish; put selling = bullish
    direction = side === 'call' ? 'down' : 'up';
  } else {
    return null;
  }

  const source = `aggressive_${sourceTag}_${side}`;
  return { direction, source };
}
