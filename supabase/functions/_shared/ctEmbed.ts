/**
 * Co-Trader embedding helper — Voyage AI voyage-3-lite (512-dim)
 *
 * Writes to `ct_embeddings` with (item_type, item_id) composite key.
 * Metadata JSONB carries instrument(s), direction, conviction, etc.
 *
 * Honors THE EMBEDDING LAW (CLAUDE.md) for co-trader: every new
 * observation, flag, alert, thesis, lesson, or report embeds its
 * narrative content. Raw UW data is NOT embedded (per the
 * "don't embed recall-able data" principle).
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = 'voyage-3-lite';
const VOYAGE_DIM = 512;

export type CtItemType =
  | 'observation'
  | 'flag'
  | 'alert'
  | 'thesis'
  | 'lesson'
  | 'report'
  | 'news'
  | 'james_view';

export interface EmbedParams {
  item_type: CtItemType;
  item_id: string;
  text: string;            // rich text: "title | type | tags | content"
  metadata?: Record<string, unknown>;
  input_type?: 'document' | 'query';
}

/**
 * Embed via Voyage (no DB write). Useful for query-time searches.
 */
export async function voyageEmbed(
  text: string,
  input_type: 'document' | 'query' = 'document'
): Promise<number[]> {
  const key = Deno.env.get('VOYAGE_API_KEY');
  if (!key) throw new Error('VOYAGE_API_KEY not configured');

  const res = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: [text],
      model: VOYAGE_MODEL,
      input_type,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Voyage embed failed: ${res.status} ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { data: Array<{ embedding: number[] }> };
  const emb = data.data?.[0]?.embedding;
  if (!emb || emb.length !== VOYAGE_DIM) {
    throw new Error(`Voyage returned unexpected embedding (len=${emb?.length})`);
  }
  return emb;
}

/**
 * Embed and persist to ct_embeddings. Idempotent via
 * (item_type, item_id) UNIQUE constraint — upsert semantics.
 */
export async function embedCtItem(
  supabase: SupabaseClient,
  params: EmbedParams
): Promise<{ ok: boolean; error?: string }> {
  try {
    const embedding = await voyageEmbed(params.text, params.input_type ?? 'document');

    const { error } = await supabase.from('ct_embeddings').upsert({
      item_type: params.item_type,
      item_id: params.item_id,
      embedding: embedding as unknown as string, // pgvector accepts array cast to string
      metadata: params.metadata ?? {},
    }, { onConflict: 'item_type,item_id' });

    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Build rich-text embedding input from a ct_observations/flags/alerts row.
 * Mirrors JAC's `"title | type | tags | content"` pattern.
 */
export function buildCtRichText(parts: {
  state: string;                    // OBSERVATION | FLAG | ALERT
  instruments: string[];
  direction?: string;
  conviction?: number | null;
  horizon?: string | null;
  full_reasoning: string;
  glance?: string[];
}): string {
  const head = [
    parts.state,
    parts.instruments.join('+'),
    parts.direction ?? '',
    parts.conviction != null ? `conv${parts.conviction}` : '',
    parts.horizon ?? '',
  ].filter(Boolean).join(' | ');

  const glance = (parts.glance ?? []).join(' · ');
  return `${head}\n${glance}\n${parts.full_reasoning}`.trim();
}
