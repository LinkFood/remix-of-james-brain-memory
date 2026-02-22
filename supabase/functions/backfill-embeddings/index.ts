/**
 * Backfill Embeddings Edge Function (DISABLED)
 * 
 * Embedding generation is not currently available.
 * Returns early with an informational message.
 */

import { handleCors } from '../_shared/cors.ts';
import { extractUserId } from '../_shared/auth.ts';
import { successResponse, errorResponse } from '../_shared/response.ts';

Deno.serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const { userId, error: authError } = await extractUserId(req);
    if (authError || !userId) {
      return errorResponse(req, authError || 'Authorization required', 401);
    }

    console.log('backfill-embeddings called — embeddings not available, returning early');

    return successResponse(req, {
      message: 'Embedding generation is not currently available. Keyword search is used instead.',
      processed: 0,
      failed: 0,
      remaining: 0,
      hasMore: false,
    });
  } catch (error) {
    console.error('Error in backfill-embeddings:', error);
    return errorResponse(req, 'Internal error', 500);
  }
});
