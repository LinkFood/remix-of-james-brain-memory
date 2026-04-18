/**
 * tradeAudit — fire-and-forget writer for ct_trade_audit rows.
 *
 * Three commit paths call writeTradeAudit() immediately after inserting a
 * ct_trades row:
 *   - ct-claude-trade-open       (source='claude-trade-open', 9:26 ET)
 *   - ct-alert-book-commit       (source='alert-book-commit', intraday)
 *   - ct-chat (commit command)   (source='chat', manual slash-command)
 *
 * Principles:
 *   - NEVER block the trade commit path. All errors are swallowed and logged.
 *   - raw_claude_response capped at RAW_RESPONSE_CAP_BYTES. Over-cap rows get
 *     a trailing "…[truncated N bytes]" marker so downstream viewers know.
 *   - Empty / null fields are fine — this table is best-effort forensics, not
 *     a hard foreign-key consistency guarantee.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

// 20KB cap per constraint. Raw Claude responses for 3-trade commits run ~2-4KB;
// chat responses can blow up past 50KB when they paste MCP output. Cap generous
// enough to preserve the reasoning, tight enough to keep rows printable.
export const RAW_RESPONSE_CAP_BYTES = 20_000;

export interface TradeAuditInput {
  trade_id: string;
  source: 'claude-trade-open' | 'alert-book-commit' | 'manual' | 'chat';
  uw_state_snapshot?: unknown;
  mcp_calls?: unknown;
  active_biases?: unknown;
  sizing_computed?: unknown;
  market_regime?: string | null;
  heartbeat_id?: string | null;
  triggering_alert_id?: string | null;
  triggering_flag_id?: string | null;
  prompt_version?: string | null;
  raw_claude_response?: string | null;
}

/**
 * Cap a raw response at RAW_RESPONSE_CAP_BYTES. Adds a trailing marker if
 * truncated so auditors know content is missing (vs legitimately short).
 */
export function capRawResponse(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  // Use Buffer/TextEncoder byte length rather than .length (chars) so the cap
  // is a real byte cap. Deno supports TextEncoder natively.
  const encoder = new TextEncoder();
  const bytes = encoder.encode(raw);
  if (bytes.byteLength <= RAW_RESPONSE_CAP_BYTES) return raw;
  // Slice at cap, then re-decode. May chop a multibyte char; acceptable for
  // a truncation marker. Fall back to char-slice if bytes decode errors.
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const sliced = decoder.decode(bytes.slice(0, RAW_RESPONSE_CAP_BYTES));
  const dropped = bytes.byteLength - RAW_RESPONSE_CAP_BYTES;
  return `${sliced}…[truncated ${dropped} bytes]`;
}

/**
 * Derive market_regime string from a heartbeat _snapshot. Best-effort — many
 * legitimate shapes, so all branches fail closed to null.
 */
export function deriveMarketRegime(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const s = snapshot as Record<string, unknown>;

  const spxMacro = s.spx_macro as Record<string, unknown> | undefined;
  const regime = typeof spxMacro?.regime === 'string' ? (spxMacro!.regime as string) : null;

  const vix = typeof s.vix === 'number' ? (s.vix as number)
            : typeof spxMacro?.vix === 'number' ? (spxMacro!.vix as number)
            : null;

  let vixTier: string | null = null;
  if (vix != null) {
    vixTier = vix < 15 ? 'vix<15' : vix < 20 ? 'vix15-20' : vix < 30 ? 'vix20-30' : 'vix>30';
  }

  if (regime && vixTier) return `${regime} · ${vixTier}`;
  return regime ?? vixTier ?? null;
}

/**
 * Shape a subset of recent ct_mcp_calls rows into the {tool, input_preview,
 * output_preview, ts} shape that ct_trade_audit.mcp_calls expects.
 */
export function shapeMcpCalls(rows: Array<Record<string, unknown>> | null | undefined): Array<Record<string, unknown>> {
  if (!rows || rows.length === 0) return [];
  return rows.map((r) => {
    const input = r.input;
    const result = r.result;
    return {
      tool: r.tool_name ?? null,
      input_preview: previewJson(input),
      output_preview: previewJson(result),
      ts: r.created_at ?? null,
      is_error: r.is_error ?? false,
    };
  });
}

/** Stringify-then-truncate for preview fields. 2KB per field keeps rows sane. */
function previewJson(v: unknown): string | null {
  if (v == null) return null;
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 2_000 ? `${s.slice(0, 2_000)}…` : s;
  } catch {
    return '[unserializable]';
  }
}

/**
 * Fire-and-forget audit write. Never throws. Never blocks.
 * Returns the promise so callers can `.catch()` for logging if they want,
 * but the standard use is `writeTradeAudit(...);` — drop the result on the floor.
 */
export function writeTradeAudit(
  supabase: SupabaseClient,
  input: TradeAuditInput,
): Promise<void> {
  const row = {
    trade_id:             input.trade_id,
    source:               input.source,
    uw_state_snapshot:    input.uw_state_snapshot ?? null,
    mcp_calls:            input.mcp_calls ?? null,
    active_biases:        input.active_biases ?? null,
    sizing_computed:      input.sizing_computed ?? null,
    market_regime:        input.market_regime ?? null,
    heartbeat_id:         input.heartbeat_id ?? null,
    triggering_alert_id:  input.triggering_alert_id ?? null,
    triggering_flag_id:   input.triggering_flag_id ?? null,
    prompt_version:       input.prompt_version ?? null,
    raw_claude_response:  capRawResponse(input.raw_claude_response),
  };

  return supabase
    .from('ct_trade_audit')
    .insert(row)
    .then(({ error }) => {
      if (error) {
        console.warn('[tradeAudit] insert failed:', error.message, 'trade_id=', input.trade_id);
      }
    })
    .catch((e: unknown) => {
      console.warn('[tradeAudit] insert threw:', e instanceof Error ? e.message : String(e));
    });
}
