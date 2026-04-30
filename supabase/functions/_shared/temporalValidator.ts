/**
 * Post-generation temporal-coherence safety net.
 *
 * Pairs with `_shared/temporalContext.ts`. After a Claude consumer
 * (morning brief, EOD report, tape reader, specialists, etc.) emits its
 * narrative, pass that text through `validateTemporalCoherence()`.
 * Haiku (~$0.005 per call) reads the text against the session date and
 * returns any temporal contradictions it finds — phrases that talk about
 * "today" but mean a different date, day-name mismatches, repeated
 * yesterday-as-today framing.
 *
 * Best-effort. On Haiku failure or parse failure, returns ok=true with
 * empty contradictions — never blocks the caller. Callers decide whether
 * to regenerate, persist with a `validator_warnings` field, or surface
 * a banner. See project_co_trader_morning_brief_temporal_bug_2026_04_30.md.
 */

import { callClaude, CLAUDE_MODELS, parseTextContent, parseToolUse } from './anthropic.ts';

const NY_TIMEZONE = 'America/New_York';

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export type TemporalSeverity = 'critical' | 'warning';

export interface TemporalContradiction {
  /** Exact phrase from the validated text that contradicts the anchor. */
  quote: string;
  /** Why it's a contradiction. */
  issue: string;
  /** 'critical' = factually wrong date. 'warning' = ambiguous/likely wrong. */
  severity: TemporalSeverity;
}

export interface TemporalValidationResult {
  /** True iff no contradictions found OR validator failed (best-effort, never blocks). */
  ok: boolean;
  /** List of contradictions Haiku flagged. Empty when ok=true. */
  contradictions: TemporalContradiction[];
  /** Raw Haiku response text — for debugging or audit logging. */
  raw_text?: string;
}

interface ValidateOptions {
  /** Optional ticker context to scope examples (e.g. 'NVDA, AAPL'). */
  tickerContext?: string;
  /** Override max output tokens. Default 500. */
  maxOutputTokens?: number;
}

/**
 * Day-of-week name for a YYYY-MM-DD string in America/New_York.
 * Returns null on malformed input.
 */
function dayNameForSessionDate(sessionDate: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) return null;
  // Anchor at NY noon-ish (17:00 UTC = 12pm or 1pm ET — same calendar day year-round).
  const date = new Date(`${sessionDate}T17:00:00Z`);
  if (isNaN(date.getTime())) return null;
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TIMEZONE,
    weekday: 'short',
  }).format(date);
  switch (weekday) {
    case 'Sun': return DAY_NAMES[0];
    case 'Mon': return DAY_NAMES[1];
    case 'Tue': return DAY_NAMES[2];
    case 'Wed': return DAY_NAMES[3];
    case 'Thu': return DAY_NAMES[4];
    case 'Fri': return DAY_NAMES[5];
    case 'Sat': return DAY_NAMES[6];
    default: return null;
  }
}

/**
 * Defensive JSON-array extractor. Haiku may emit:
 *   - clean JSON: `[]` or `[{...}]`
 *   - prose-wrapped JSON: "Here are the issues:\n[...]"
 *   - code-fenced JSON: ```json\n[...]\n```
 *   - prose with no JSON at all (treat as no-issues)
 */
function extractJsonArray(text: string): unknown[] | null {
  if (!text) return null;
  const trimmed = text.trim();
  // Fast path: clean JSON array.
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to regex extraction
    }
  }
  // Regex: greedy match for outermost [...] block.
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    return null;
  }
  return null;
}

/**
 * Coerce a single Haiku-emitted item into a strict TemporalContradiction.
 * Drops items without quote+issue. Defaults severity to 'warning'.
 */
function coerceContradiction(raw: unknown): TemporalContradiction | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const quote = typeof obj.quote === 'string' ? obj.quote.trim() : '';
  const issue = typeof obj.issue === 'string' ? obj.issue.trim() : '';
  if (!quote || !issue) return null;
  const sev = obj.severity === 'critical' ? 'critical' : 'warning';
  return { quote, issue, severity: sev };
}

const VALIDATOR_TOOL = {
  name: 'report_temporal_contradictions',
  description:
    'Report any temporal contradictions found in the narrative. ' +
    'Empty array means the narrative is temporally coherent with the session date.',
  input_schema: {
    type: 'object',
    properties: {
      contradictions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            quote: {
              type: 'string',
              description: 'Exact phrase copied verbatim from the narrative that contradicts the session date.',
            },
            issue: {
              type: 'string',
              description: 'Short explanation of why the phrase is a contradiction.',
            },
            severity: {
              type: 'string',
              enum: ['critical', 'warning'],
              description: "'critical' for a factually wrong date claim; 'warning' for an ambiguous or likely-wrong reference.",
            },
          },
          required: ['quote', 'issue', 'severity'],
        },
      },
    },
    required: ['contradictions'],
  },
} as const;

/**
 * Call Haiku to find temporal contradictions in `outputText` against
 * `sessionDate`. Best-effort — never throws, never blocks.
 *
 * Cost: ~$0.005 per call (Haiku 4.5, ~1-2k input tokens, capped output).
 */
export async function validateTemporalCoherence(
  outputText: string,
  sessionDate: string,
  options?: ValidateOptions,
): Promise<TemporalValidationResult> {
  if (!outputText || typeof outputText !== 'string' || !outputText.trim()) {
    return { ok: true, contradictions: [] };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
    return { ok: true, contradictions: [] };
  }

  const dayName = dayNameForSessionDate(sessionDate) ?? 'unknown weekday';
  const tickerLine = options?.tickerContext
    ? `Tickers in scope: ${options.tickerContext}.\n`
    : '';

  const systemPrompt =
    `You are a temporal-frame validator. The narrative below claims to describe activity on ` +
    `${sessionDate} (a ${dayName}).\n\n` +
    tickerLine +
    `Find any text that contradicts this date. Examples of contradictions:\n` +
    `- Says "today" to mean a different date\n` +
    `- Repeats yesterday's events as if today's (e.g., "MSFT dropped 3% today" when MSFT's drop was on a prior day)\n` +
    `- References "this Friday" when ${sessionDate}'s Friday hasn't happened yet, or has already passed\n` +
    `- Day names that don't match (e.g., calls today "Monday" when ${sessionDate} is ${dayName})\n` +
    `- Says an earnings report or news event is "today" when its actual date was prior\n\n` +
    `Be strict on day-name and explicit-date errors. Be lenient on phrases that COULD be ` +
    `historical references ("yesterday's close", "last Friday's data") — those are fine if framed as past.\n\n` +
    `Use the report_temporal_contradictions tool. If the narrative is coherent, call the tool with ` +
    `an empty contradictions array.`;

  const userMessage =
    `Narrative to validate (session date = ${sessionDate}, ${dayName}):\n\n` +
    `<<<NARRATIVE_START>>>\n${outputText}\n<<<NARRATIVE_END>>>`;

  let rawText = '';
  try {
    const response = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      tools: [VALIDATOR_TOOL],
      tool_choice: { type: 'tool', name: VALIDATOR_TOOL.name },
      max_tokens: options?.maxOutputTokens ?? 500,
      temperature: 0,
    });

    // Preferred path: forced tool-use returns structured input.
    const tool = parseToolUse(response);
    if (tool && tool.name === VALIDATOR_TOOL.name) {
      const arr = (tool.input as { contradictions?: unknown }).contradictions;
      rawText = JSON.stringify(tool.input);
      if (Array.isArray(arr)) {
        const list = arr
          .map(coerceContradiction)
          .filter((c): c is TemporalContradiction => c !== null);
        return {
          ok: list.length === 0,
          contradictions: list,
          raw_text: rawText,
        };
      }
      // Tool fired but contradictions wasn't an array — treat as no-issues.
      return { ok: true, contradictions: [], raw_text: rawText };
    }

    // Fallback path: model returned plain text (shouldn't happen with forced
    // tool-use but defend anyway). Parse JSON array from prose.
    rawText = parseTextContent(response);
    const arr = extractJsonArray(rawText);
    if (!arr) {
      return { ok: true, contradictions: [], raw_text: rawText };
    }
    const list = arr
      .map(coerceContradiction)
      .filter((c): c is TemporalContradiction => c !== null);
    return {
      ok: list.length === 0,
      contradictions: list,
      raw_text: rawText,
    };
  } catch (err) {
    // Best-effort: log and pass through without blocking the caller.
    console.warn('[temporalValidator] Haiku call failed (non-blocking):', err);
    return { ok: true, contradictions: [], raw_text: rawText };
  }
}
