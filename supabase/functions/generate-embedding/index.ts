/**
 * generate-embedding — Vector Embeddings (DISABLED)
 * 
 * Embedding models are not available on the current AI gateway.
 * Returns 501 so all callers cleanly fall back to keyword search.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);

  // Return 501 Not Implemented so callers fall back to keyword search
  console.log('generate-embedding called — returning 501 (embeddings not available)');
  return new Response(
    JSON.stringify({
      error: 'Embedding generation is not currently available. Callers should use keyword search instead.',
      code: 'EMBEDDINGS_UNAVAILABLE',
    }),
    {
      status: 501,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  );
});
