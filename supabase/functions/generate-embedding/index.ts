/**
 * generate-embedding — Vector Embeddings via Voyage AI
 *
 * Uses voyage-3-lite (512 dimensions, $0.02/M tokens).
 * Requires VOYAGE_API_KEY in Supabase secrets.
 * Falls back gracefully if key not configured.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isServiceRoleRequest } from '../_shared/auth.ts';

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = 'voyage-3-lite';

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);

  // Auth gate: only internal service-role calls allowed
  // Note: Supabase relay strips auth tokens from external requests, so external
  // calls always fail here. Internal function-to-function calls bypass the relay.
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const apiKey = Deno.env.get('VOYAGE_API_KEY');
    if (!apiKey) {
      console.error('generate-embedding: VOYAGE_API_KEY not configured');
      return new Response(
        JSON.stringify({ error: 'Embedding service not configured', code: 'NOT_CONFIGURED' }),
        { status: 501, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body = await req.json();
    const text = body.text as string;
    const inputType = (body.input_type === 'query') ? 'query' : 'document';

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: 'text field is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Truncate to ~8000 chars to stay within token limits
    const truncated = text.slice(0, 8000);

    const voyageRes = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: VOYAGE_MODEL,
        input: [truncated],
        input_type: inputType,
      }),
    });

    if (!voyageRes.ok) {
      const errText = await voyageRes.text();
      console.error('Voyage API error:', voyageRes.status, errText);
      return new Response(
        JSON.stringify({ error: `Embedding API failed: ${voyageRes.status}`, detail: errText.slice(0, 200) }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const voyageData = await voyageRes.json();
    const embedding = voyageData.data?.[0]?.embedding;

    if (!embedding || !Array.isArray(embedding)) {
      console.error('Voyage returned unexpected format:', JSON.stringify(voyageData).slice(0, 200));
      return new Response(
        JSON.stringify({ error: 'Embedding API returned unexpected format' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`generate-embedding: ${embedding.length}-dim vector for ${truncated.length} chars (tokens: ${voyageData.usage?.total_tokens || '?'})`);

    return new Response(
      JSON.stringify({
        embedding,
        dimensions: embedding.length,
        model: VOYAGE_MODEL,
        tokens: voyageData.usage?.total_tokens || 0,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('generate-embedding error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
