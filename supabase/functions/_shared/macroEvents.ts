/**
 * macroEvents.ts — canonical classifier for macro calendar events.
 *
 * ct_events.event_type only has 'earnings'|'fda'|'econ' (constrained). All
 * macro releases (FOMC, CPI, PPI, etc.) land under event_type='econ' with
 * their specific release name in the `title` column. This module maps those
 * free-text titles into a small set of canonical keys downstream code can
 * filter on.
 *
 * Seven canonical macro types. Anything else on an econ row returns null.
 */

export type MacroEventType =
  | 'fomc'
  | 'cpi'
  | 'ppi'
  | 'jobs'
  | 'employment'
  | 'gdp'
  | 'fed_speak'
  | 'retail_sales';

export const MACRO_EVENT_TYPES: readonly MacroEventType[] = [
  'fomc',
  'cpi',
  'ppi',
  'jobs',
  'employment',
  'gdp',
  'fed_speak',
  'retail_sales',
] as const;

/**
 * Classify an econ-row title into one of the canonical macro types.
 * Returns null if the title doesn't match any canonical bucket — the UI
 * should drop those rows (treating them as noise, not macro signal).
 *
 * Pattern order matters: FOMC/fed speak must be checked before 'jobs'
 * because headline "Fed's Powell Speaks on Employment" would otherwise
 * hit both buckets.
 */
export function classifyMacroEvent(title: string | null | undefined): MacroEventType | null {
  if (!title) return null;
  const t = title.toLowerCase();

  // FOMC: rate decision / minutes / projections / dot plot. Checked before
  // fed_speak so "FOMC Press Conference" lands on 'fomc', not fed_speak.
  if (/\bfomc\b/.test(t)) return 'fomc';
  if (/\bfed funds\b/.test(t) && /(decision|rate|target)/.test(t)) return 'fomc';
  if (/\binterest rate decision\b/.test(t) && /\b(fed|usa|us)\b/.test(t)) return 'fomc';

  // CPI — headline or core. Distinguish from PPI (both have "price index").
  if (/\bcpi\b/.test(t)) return 'cpi';
  if (/\bconsumer price\b/.test(t)) return 'cpi';

  // PPI — producer price index.
  if (/\bppi\b/.test(t)) return 'ppi';
  if (/\bproducer price\b/.test(t)) return 'ppi';

  // Employment — broad monthly NFP / unemployment / ADP. Distinguish
  // from jobless claims (weekly).
  if (/\bnon[- ]?farm\b/.test(t)) return 'employment';
  if (/\bnfp\b/.test(t)) return 'employment';
  if (/\bunemployment rate\b/.test(t)) return 'employment';
  if (/\badp (non[- ]?farm|employment|payroll)/.test(t)) return 'employment';
  if (/\bemployment (change|situation|report)\b/.test(t)) return 'employment';

  // Jobs — weekly jobless claims (initial + continuing).
  if (/\bjobless claims\b/.test(t)) return 'jobs';
  if (/\binitial claims\b/.test(t)) return 'jobs';
  if (/\bcontinuing claims\b/.test(t)) return 'jobs';
  if (/\bjolts\b/.test(t)) return 'jobs'; // Job Openings & Labor Turnover

  // GDP — quarterly, advance/preliminary/final.
  if (/\bgdp\b/.test(t)) return 'gdp';
  if (/\bgross domestic product\b/.test(t)) return 'gdp';

  // Fed speak — any Fed governor / president named speaker. Check AFTER
  // FOMC so "FOMC Chair Powell Speaks" lands on fomc, not fed_speak.
  // Common UW calendar names: "Fed's Powell Speaks", "Fed Chair Powell Speech".
  if (/\bfed(eral reserve)? (chair|governor|president)\b/.test(t) && /(speak|speech|testi|remark)/.test(t)) return 'fed_speak';
  if (/\bfed's\b/.test(t) && /(speak|speech|testi|remark)/.test(t)) return 'fed_speak';
  if (/^powell\b/.test(t) && /(speak|speech|testi|remark)/.test(t)) return 'fed_speak';

  // Retail sales — headline + control group.
  if (/\bretail sales\b/.test(t)) return 'retail_sales';
  if (/\bcore retail\b/.test(t)) return 'retail_sales';

  return null;
}

/**
 * Score per-event impact for UI color-coding. High-impact events deserve
 * the red border and drive the 48h/1h watcher pings + Slack notifications.
 *
 *   high   → fomc, cpi, ppi, employment, gdp
 *   medium → jobs (weekly claims), retail_sales
 *   low    → fed_speak (unless governor-level, which the classifier already
 *            upgrades some of to FOMC)
 *
 * Ingester-supplied `importance` overrides when present (UW sometimes
 * encodes 1/2/3 on the raw row).
 */
export type MacroImpact = 'high' | 'medium' | 'low';

export function macroImpact(
  macroType: MacroEventType,
  ingesterImportance?: number | null,
): MacroImpact {
  if (ingesterImportance != null) {
    if (ingesterImportance >= 3) return 'high';
    if (ingesterImportance === 2) return 'medium';
    if (ingesterImportance <= 1) return 'low';
  }
  switch (macroType) {
    case 'fomc':
    case 'cpi':
    case 'ppi':
    case 'employment':
    case 'gdp':
      return 'high';
    case 'jobs':
    case 'retail_sales':
      return 'medium';
    case 'fed_speak':
      return 'low';
  }
}

/**
 * Human-readable label for the UI + Slack headers.
 */
export function macroLabel(macroType: MacroEventType): string {
  switch (macroType) {
    case 'fomc':         return 'FOMC';
    case 'cpi':          return 'CPI';
    case 'ppi':          return 'PPI';
    case 'jobs':         return 'Jobless Claims';
    case 'employment':   return 'Employment';
    case 'gdp':          return 'GDP';
    case 'fed_speak':    return 'Fed Speak';
    case 'retail_sales': return 'Retail Sales';
  }
}
