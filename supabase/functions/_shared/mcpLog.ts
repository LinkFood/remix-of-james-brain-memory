/**
 * logMcpCalls — parse a Claude Messages API response for mcp_tool_use +
 * mcp_tool_result block pairs and persist each call to ct_mcp_calls.
 *
 * Safe to call any time mcp_servers was passed to Claude. No-op if the
 * response has no MCP blocks.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

interface Block {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  server_name?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeResponseLike {
  content?: Block[] | unknown;
}

const MAX_RESULT_CHARS = 8000;

function truncateResult(result: unknown): unknown {
  if (result === null || result === undefined) return null;
  try {
    const s = JSON.stringify(result);
    if (s.length <= MAX_RESULT_CHARS) return result;
    return { _truncated: true, _original_length: s.length, preview: s.slice(0, MAX_RESULT_CHARS) };
  } catch {
    return { _truncated: true, preview: String(result).slice(0, MAX_RESULT_CHARS) };
  }
}

export async function logMcpCalls(
  supabase: SupabaseClient,
  source: string,
  response: ClaudeResponseLike,
  extras?: { user_id?: string | null; related_to?: string | null },
): Promise<{ logged: number }> {
  const blocks = Array.isArray(response?.content) ? response.content as Block[] : [];
  if (blocks.length === 0) return { logged: 0 };

  // Map tool_use_id -> {tool_name, server_name, input}
  const uses = new Map<string, { tool_name: string; server_name: string; input: unknown }>();
  for (const b of blocks) {
    if (b.type === 'mcp_tool_use' && typeof b.id === 'string') {
      uses.set(b.id, {
        tool_name: b.name ?? 'unknown',
        server_name: b.server_name ?? 'unknown',
        input: b.input ?? null,
      });
    }
  }

  const rows: Record<string, unknown>[] = [];
  for (const b of blocks) {
    if (b.type === 'mcp_tool_result' && typeof b.tool_use_id === 'string') {
      const use = uses.get(b.tool_use_id);
      if (!use) continue;
      rows.push({
        source,
        server_name: use.server_name,
        tool_name: use.tool_name,
        tool_use_id: b.tool_use_id,
        input: use.input,
        result: truncateResult(b.content),
        is_error: !!b.is_error,
        user_id: extras?.user_id ?? null,
        related_to: extras?.related_to ?? null,
      });
    }
  }

  // Also log tool_use without matching result (in-flight / model error cases)
  const matchedIds = new Set(rows.map(r => r.tool_use_id as string));
  for (const [id, use] of uses) {
    if (matchedIds.has(id)) continue;
    rows.push({
      source,
      server_name: use.server_name,
      tool_name: use.tool_name,
      tool_use_id: id,
      input: use.input,
      result: null,
      is_error: false,
      user_id: extras?.user_id ?? null,
      related_to: extras?.related_to ?? null,
    });
  }

  if (rows.length === 0) return { logged: 0 };

  try {
    const { error } = await supabase.from('ct_mcp_calls').insert(rows);
    if (error) {
      console.warn('[mcpLog] insert failed:', error.message);
      return { logged: 0 };
    }
    return { logged: rows.length };
  } catch (e) {
    console.warn('[mcpLog] exception:', e instanceof Error ? e.message : e);
    return { logged: 0 };
  }
}
