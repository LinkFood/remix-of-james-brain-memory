/**
 * eventCoherenceValidator — post-generation safety net for the
 * "Powell speech today" hallucination class.
 *
 * Pairs with `_shared/eventRecencyContext.ts`. After Claude emits its
 * narrative, scan the text for FORWARD-LEANING phrases ("watching for / ahead
 * of / waiting on / setup into / will release / coming up / before / pre-")
 * and cross-reference each against `context.organs.event_recency.just_happened`
 * — events that have ALREADY fired. Any forward-leaning phrase that names an
 * event already in just_happened is a `temporal_event_contradiction`.
 *
 * Defense-in-depth per Tenet 13. Structural prevention is `eventRecencyContext`
 * (the organ + preamble); this validator is the chain.
 *
 * **Defensive contract:** never throws. If scan fails or `event_recency` is
 * missing from context.organs, returns `ok=true` with a `meta` warning so
 * callers can log/observe but never block.
 *
 * @see contextHelper.ts §D10        — validator chain spec
 * @see temporalValidator.ts          — sibling validator pattern
 * @see docs/SYNTHESIS_LAYER_AUDIT.md §5g
 */

import type {
  ClaudeContext,
  ContextValidator,
  HelperResult,
  ValidatorResult,
  ValidatorWarning,
} from './contextHelper.ts';
import type { EventRecencyResult, RecencyEvent } from './eventRecencyContext.ts';

const VALIDATOR_NAME = 'event_coherence';
const VALIDATOR_VERSION = 'v1';

// Forward-leaning phrase patterns. Conservative — we only flag when the same
// phrase region also names an event we KNOW already happened. Generic forward
// language without a concrete event reference is allowed.
const FORWARD_PHRASE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'watching for', pattern: /\bwatching\s+for\b/gi },
  { label: 'waiting on', pattern: /\bwaiting\s+(?:on|for)\b/gi },
  { label: 'ahead of', pattern: /\bahead\s+of\b/gi },
  { label: 'setup into', pattern: /\bset(?:up|ting up)\s+(?:in)?to\b/gi },
  { label: 'will release', pattern: /\bwill\s+(?:release|report|announce|print)\b/gi },
  { label: 'coming up', pattern: /\bcoming\s+up\b/gi },
  { label: 'pre-', pattern: /\bpre-(?:earnings|fomc|cpi|jobs|nfp|fed|gdp|ppi)\b/gi },
  { label: 'before', pattern: /\bbefore\s+(?:the\s+)?(?:fomc|fed|earnings|cpi|nfp|jobs|powell|gdp|ppi)\b/gi },
  { label: 'positioning into', pattern: /\bpositioning\s+into\b/gi },
  { label: 'leading up to', pattern: /\bleading\s+up\s+to\b/gi },
  { label: 'awaiting', pattern: /\bawaiting\b/gi },
  { label: 'looking ahead to', pattern: /\blooking\s+ahead\s+to\b/gi },
  { label: 'in front of', pattern: /\bin\s+front\s+of\s+(?:the\s+)?(?:fomc|fed|earnings|cpi|nfp|jobs|powell|print)\b/gi },
];

// Keywords we extract from each just_happened event for matching against the
// scanned phrase context window.
type EventKeywords = {
  eventId: string;
  category: RecencyEvent['category'];
  source: RecencyEvent['source'];
  /** Lowercased keyword strings to test for substring presence in phrase. */
  keywords: string[];
  ticker: string | null;
  title: string;
  eventDate: string;
};

/**
 * Synonym families. When a title or event references ANY member of a family,
 * we treat the whole family as alias keywords. That's how "Fed holds rates"
 * (a news row) catches Claude saying "watching for FOMC" — the structural
 * synonym set is fed = fomc = powell = rate decision = central bank.
 */
const SYNONYM_FAMILIES: Array<readonly string[]> = [
  ['fomc', 'fed', 'powell', 'rate decision', 'central bank', 'fed meeting'],
  ['cpi', 'inflation print', 'cpi print'],
  ['nfp', 'jobs report', 'payrolls', 'jobs data'],
  ['gdp', 'gdp print'],
  ['ppi', 'ppi print'],
];

/**
 * Build keyword set per just_happened event. Conservative — we only match
 * when a CONCRETE keyword (not a generic word) appears near the forward
 * phrase. Generic words like "earnings" alone aren't enough; we want
 * "earnings" + a ticker, OR specific event names (fomc, cpi, powell, etc).
 *
 * When ANY synonym in a family hits the title or category, we add the WHOLE
 * family. That's the structural fix for "Fed holds rates steady" news rows
 * catching Claude's "watching for FOMC" — the system shouldn't care which
 * synonym the headline used vs. which Claude generated.
 */
function deriveKeywords(e: RecencyEvent): EventKeywords {
  const kws = new Set<string>();
  const titleLower = (e.title ?? '').toLowerCase();

  // Category-derived seeds.
  if (e.category === 'central_bank') {
    for (const s of SYNONYM_FAMILIES[0]) kws.add(s);
  }
  if (e.category === 'earnings' && e.ticker) {
    kws.add(`${e.ticker.toLowerCase()} earnings`);
    kws.add(`${e.ticker.toLowerCase()} report`);
    kws.add(`${e.ticker.toLowerCase()} print`);
    kws.add(`${e.ticker.toLowerCase()} results`);
  }

  // Title-driven family expansion — applies to econ + news both.
  for (const family of SYNONYM_FAMILIES) {
    if (family.some((m) => titleLower.includes(m))) {
      for (const s of family) kws.add(s);
    }
  }

  // News-specific extras: fold in per-ticker earnings if the headline names
  // earnings AND has affected tickers.
  if (e.category === 'news') {
    if (titleLower.includes('earnings')) {
      for (const t of e.tickers_affected) {
        kws.add(`${t.toLowerCase()} earnings`);
        kws.add(`${t.toLowerCase()} report`);
      }
    }
  }

  return {
    eventId: e.id,
    category: e.category,
    source: e.source,
    keywords: Array.from(kws),
    ticker: e.ticker,
    title: e.title ?? '',
    eventDate: e.event_date,
  };
}

/**
 * Pull the surrounding context for a regex match — up to N chars on each side,
 * trimmed at sentence boundaries when possible.
 */
function contextWindow(text: string, matchStart: number, matchEnd: number, radius = 80): string {
  const lo = Math.max(0, matchStart - 10);
  const hi = Math.min(text.length, matchEnd + radius);
  let snippet = text.slice(lo, hi);
  // Trim at the end of the next sentence boundary if any.
  const trailingDot = snippet.search(/[.!?\n]/);
  if (trailingDot > 20) {
    snippet = snippet.slice(0, trailingDot + 1);
  }
  return snippet.trim();
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

interface Hit {
  warning: ValidatorWarning;
}

function scanForContradictions(
  outputText: string,
  justHappenedEvents: RecencyEvent[],
): Hit[] {
  if (!outputText || justHappenedEvents.length === 0) return [];

  const eventKeywords = justHappenedEvents.map(deriveKeywords);
  const hits: Hit[] = [];
  const seenSignatures = new Set<string>(); // dedupe identical (eventId+matchStart) hits

  for (const { label, pattern } of FORWARD_PHRASE_PATTERNS) {
    // Reset lastIndex defensively (regex literals share state in some runtimes).
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    // Hard cap iterations to avoid pathological loops on very long output.
    let iterations = 0;
    const MAX_ITER = 200;
    while ((m = pattern.exec(outputText)) !== null && iterations < MAX_ITER) {
      iterations++;
      const matchStart = m.index;
      const matchEnd = matchStart + m[0].length;
      const window = contextWindow(outputText, matchStart, matchEnd);
      const windowLower = window.toLowerCase();

      for (const ek of eventKeywords) {
        // Cheap pre-check: at least one keyword substring must hit.
        const matchedKw = ek.keywords.find((k) => k && windowLower.includes(k));
        if (!matchedKw) continue;

        // Dedupe: same eventId in same window region.
        const sig = `${ek.eventId}::${Math.floor(matchStart / 40)}`;
        if (seenSignatures.has(sig)) continue;
        seenSignatures.add(sig);

        const issue = `Forward-leaning phrase "${label}" appears near "${matchedKw}", but event already fired on ${ek.eventDate} (source=${ek.source}, title="${ek.title}"). Re-frame as past, not upcoming.`;
        hits.push({
          warning: {
            validator: VALIDATOR_NAME,
            severity: 'critical',
            quote: window,
            issue,
          },
        });
        // Don't break — same phrase region may legitimately reference multiple
        // already-fired events; report each distinctly.
      }
      // Safety: avoid infinite loop if a non-global regex sneaks in.
      if (!pattern.global) break;
    }
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Public — convenience function + ContextValidator instance
// ---------------------------------------------------------------------------

/**
 * Convenience export: run the scan directly without going through the
 * validator chain. Returns `ok=true` on any failure mode (defensive).
 *
 * `context` MUST contain `organs.event_recency` populated by the orchestrator
 * for any flagging to occur. When missing, returns `ok=true` with a
 * meta warning string (for telemetry) — never blocks.
 */
export async function validateEventCoherence(
  outputText: string,
  context: ClaudeContext,
): Promise<ValidatorResult> {
  try {
    if (!outputText || typeof outputText !== 'string' || !outputText.trim()) {
      return { ok: true, warnings: [] };
    }

    const organ = context?.organs?.event_recency as
      | HelperResult<EventRecencyResult>
      | undefined;
    const recency = organ?.data;
    if (!recency) {
      // Defensive: missing organ means we can't validate. Emit a single
      // "warning" (severity warning, not critical) so the caller sees the
      // gap without it being treated as a contradiction.
      return {
        ok: true,
        warnings: [
          {
            validator: VALIDATOR_NAME,
            severity: 'warning',
            issue: 'event_recency organ missing from ClaudeContext.organs — coherence validation skipped',
          },
        ],
      };
    }

    // Build the just_happened pool: market-wide + per-ticker (deduped by id).
    const pool = new Map<string, RecencyEvent>();
    for (const e of recency.market_wide?.just_happened ?? []) pool.set(e.id, e);
    for (const t of recency.per_ticker ?? []) {
      for (const e of t.just_happened ?? []) pool.set(e.id, e);
    }

    if (pool.size === 0) {
      return { ok: true, warnings: [] };
    }

    const hits = scanForContradictions(outputText, Array.from(pool.values()));
    const warnings = hits.map((h) => h.warning);
    return { ok: warnings.length === 0, warnings };
  } catch (err) {
    // Best-effort. Never block. Log to console so orchestrator can pick up.
    console.warn('[eventCoherenceValidator] scan failed (non-blocking):', err);
    return {
      ok: true,
      warnings: [
        {
          validator: VALIDATOR_NAME,
          severity: 'warning',
          issue: `validator scan threw: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

const eventCoherenceValidator: ContextValidator = {
  name: VALIDATOR_NAME,
  version: VALIDATOR_VERSION,
  validate: validateEventCoherence,
};

export default eventCoherenceValidator;
