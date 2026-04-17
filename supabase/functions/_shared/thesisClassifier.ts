/**
 * thesisClassifier — cheap regex mapper from a trade's free-text thesis
 * to one of a fixed set of themes. Used for P&L-by-theme analytics.
 *
 * Rules are intentionally simple and ordered by specificity:
 *   1. thesis_invalidation  — explicit "invalidate/kill/cut"
 *   2. regime_flip          — "regime/flip/inversion"
 *   3. structural_tightness — "tight/near wall/gamma flip/pinning"
 *   4. convergence          — "convergence/multi-signal/alignment"
 *   5. gap                  — "gap/overnight/opening"
 *   6. news_driven          — news keywords (fed, cpi, earnings, etc)
 *   7. other                — fallback
 *
 * No LLM. Safe to call at insert time and during backfill.
 */

export type ThesisTheme =
  | 'convergence'
  | 'structural_tightness'
  | 'gap'
  | 'news_driven'
  | 'regime_flip'
  | 'thesis_invalidation'
  | 'other';

const RULES: Array<{ theme: ThesisTheme; re: RegExp }> = [
  { theme: 'thesis_invalidation',  re: /invalidat|\bkill\b|\bcut\b/i },
  { theme: 'regime_flip',          re: /regime|\bflip\b|inversion/i },
  { theme: 'structural_tightness', re: /\btight\b|near wall|gamma flip|pinning/i },
  { theme: 'convergence',          re: /convergence|multi[- ]signal|alignment/i },
  { theme: 'gap',                  re: /\bgap\b|overnight|opening/i },
  { theme: 'news_driven',          re: /\bnews\b|headline|iran|tariff|\bfed\b|\bcpi\b|powell|earnings|\bfda\b/i },
];

export function classifyThesis(thesis: string | null | undefined): ThesisTheme {
  if (!thesis || typeof thesis !== 'string') return 'other';
  const t = thesis.trim();
  if (t.length === 0) return 'other';
  for (const { theme, re } of RULES) {
    if (re.test(t)) return theme;
  }
  return 'other';
}
