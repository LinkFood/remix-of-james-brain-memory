/**
 * Backfill Embeddings Edge Function
 * 
 * Generates embeddings for entries that don't have them yet.
 * Useful for existing entries or after embedding failures.
 */

import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId, createServiceClient } from '../_shared/auth.ts';
import { checkRateLimit, getRateLimitHeaders } from '../_shared/rateLimit.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { parseJsonBody, parseNumber } from '../_shared/validation.ts';

interface BackfillRequest {
  batchSize?: number;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);

  try {
    // Authenticate user
    const { userId, error: authError } = await extractUserId(req);
    if (authError || !userId) {
      return errorResponse(req, authError || 'Authorization required', 401);
    }

    // Rate limiting - heavy operation (5 per hour)
    const rateLimitResult = checkRateLimit(`backfill:${userId}`, { maxRequests: 5, windowMs: 3600000 });
    if (!rateLimitResult.allowed) {
      return new Response(
        JSON.stringify({ error: 'Backfill rate limit exceeded. Max 5 per hour.', retryAfter: Math.ceil(rateLimitResult.resetIn / 1000) }),
        { 
          status: 429, 
          headers: { ...corsHeaders, ...getRateLimitHeaders(rateLimitResult), 'Content-Type': 'application/json' } 
        }
      );
    }

    // Parse request
    const { data: body } = await parseJsonBody<BackfillRequest>(req);
    const batchSize = parseNumber(body?.batchSize, { min: 1, max: 100, default: 50 }) || 50;

    console.log(`Starting backfill for user ${userId}, batch size: ${batchSize}`);

    // Use service role for data access
    const serviceClient = createServiceClient();
    if (!serviceClient) {
      return serverErrorResponse(req, 'Service configuration error');
    }

    // Fetch entries without embeddings
    const { data: entries, error: fetchError } = await serviceClient
      .from('entries')
      .select('id, content')
      .eq('user_id', userId)
      .is('embedding', null)
      .eq('archived', false)
      .limit(batchSize);

    if (fetchError) {
      console.error('Error fetching entries:', fetchError);
      return serverErrorResponse(req, 'Failed to fetch entries');
    }

    if (!entries || entries.length === 0) {
      console.log('No entries to process');
      return successResponse(req, { 
        message: 'No entries to process',
        processed: 0,
        failed: 0,
        remaining: 0,
        hasMore: false
      }, 200, rateLimitResult);
    }

    console.log(`Found ${entries.length} entries to process`);

    let processed = 0;
    let failed = 0;

    // Process entries in smaller batches to avoid rate limits
    const smallBatchSize = 10;
    for (let i = 0; i < entries.length; i += smallBatchSize) {
      const batch = entries.slice(i, i + smallBatchSize);
      
      await Promise.all(
        batch.map(async (entry) => {
          try {
            // Generate embedding
            const embeddingResponse = await fetch(
              `${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-embedding`,
              {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ text: entry.content }),
              }
            );

            if (!embeddingResponse.ok) {
              console.error(`Failed to generate embedding for entry ${entry.id}`);
              failed++;
              return;
            }

            const embeddingData = await embeddingResponse.json();
            // Format as Postgres vector literal
            const embedding = `[${embeddingData.embedding.join(',')}]`;

            // Update entry with embedding
            const { error: updateError } = await serviceClient
              .from('entries')
              .update({ embedding })
              .eq('id', entry.id);

            if (updateError) {
              console.error(`Failed to update entry ${entry.id}:`, updateError);
              failed++;
            } else {
              processed++;
              console.log(`Processed entry ${entry.id}`);
            }
          } catch (err) {
            console.error(`Error processing entry ${entry.id}:`, err);
            failed++;
          }
        })
      );

      // Small delay between batches to avoid rate limits
      if (i + smallBatchSize < entries.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Check if there are more entries to process
    const { count: remainingCount } = await serviceClient
      .from('entries')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('embedding', null)
      .eq('archived', false);

    console.log(`Completed: ${processed} processed, ${failed} failed, ${remainingCount || 0} remaining`);

    return successResponse(req, {
      message: `Processed ${processed} entries successfully, ${failed} failed`,
      processed,
      failed,
      remaining: remainingCount || 0,
      hasMore: (remainingCount || 0) > 0,
    }, 200, rateLimitResult);

  } catch (error) {
    console.error('Error in backfill-embeddings function:', error);
    return serverErrorResponse(req, error instanceof Error ? error : 'Unknown error');
  }
});
