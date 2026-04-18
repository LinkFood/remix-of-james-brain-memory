/**
 * macroEvents.ts — frontend mirror of supabase/functions/_shared/macroEvents.ts.
 *
 * Keep these two files in sync. The edge-function copy is authoritative for
 * ingest + watcher logic; this copy exists so the React bundle doesn't pull
 * Deno imports. If you change one, change both.
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

export function classifyMacroEvent(title: string | null | undefined): MacroEventType | null {
  if (!title) return null;
  const t = title.toLowerCase();

  if (/\bfomc\b/.test(t)) return 'fomc';
  if (/\bfed funds\b/.test(t) && /(decision|rate|target)/.test(t)) return 'fomc';
  if (/\binterest rate decision\b/.test(t) && /\b(fed|usa|us)\b/.test(t)) return 'fomc';

  if (/\bcpi\b/.test(t)) return 'cpi';
  if (/\bconsumer price\b/.test(t)) return 'cpi';

  if (/\bppi\b/.test(t)) return 'ppi';
  if (/\bproducer price\b/.test(t)) return 'ppi';

  if (/\bnon[- ]?farm\b/.test(t)) return 'employment';
  if (/\bnfp\b/.test(t)) return 'employment';
  if (/\bunemployment rate\b/.test(t)) return 'employment';
  if (/\badp (non[- ]?farm|employment|payroll)/.test(t)) return 'employment';
  if (/\bemployment (change|situation|report)\b/.test(t)) return 'employment';

  if (/\bjobless claims\b/.test(t)) return 'jobs';
  if (/\binitial claims\b/.test(t)) return 'jobs';
  if (/\bcontinuing claims\b/.test(t)) return 'jobs';
  if (/\bjolts\b/.test(t)) return 'jobs';

  if (/\bgdp\b/.test(t)) return 'gdp';
  if (/\bgross domestic product\b/.test(t)) return 'gdp';

  if (/\bfed(eral reserve)? (chair|governor|president)\b/.test(t) && /(speak|speech|testi|remark)/.test(t)) return 'fed_speak';
  if (/\bfed's\b/.test(t) && /(speak|speech|testi|remark)/.test(t)) return 'fed_speak';
  if (/^powell\b/.test(t) && /(speak|speech|testi|remark)/.test(t)) return 'fed_speak';

  if (/\bretail sales\b/.test(t)) return 'retail_sales';
  if (/\bcore retail\b/.test(t)) return 'retail_sales';

  return null;
}

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
