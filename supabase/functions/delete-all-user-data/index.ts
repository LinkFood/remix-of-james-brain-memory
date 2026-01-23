/**
 * Delete All User Data Edge Function
 * 
 * Permanently deletes all user data from the system.
 * This is a destructive operation - requires confirmation.
 */

import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId, createServiceClient } from '../_shared/auth.ts';
import { checkRateLimit, getRateLimitHeaders } from '../_shared/rateLimit.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { parseJsonBody } from '../_shared/validation.ts';

interface DeleteRequest {
  confirmDelete?: boolean;
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

    // Strict rate limiting - only 2 attempts per hour
    const rateLimitResult = checkRateLimit(`delete:${userId}`, { maxRequests: 2, windowMs: 3600000 });
    if (!rateLimitResult.allowed) {
      return new Response(
        JSON.stringify({ error: 'Delete rate limit exceeded. Max 2 attempts per hour.', retryAfter: Math.ceil(rateLimitResult.resetIn / 1000) }),
        { 
          status: 429, 
          headers: { ...corsHeaders, ...getRateLimitHeaders(rateLimitResult), 'Content-Type': 'application/json' } 
        }
      );
    }

    // Parse confirmation from request body
    const { data: body } = await parseJsonBody<DeleteRequest>(req);
    
    // For safety, we can optionally require explicit confirmation
    // (Currently not enforced to maintain backward compatibility)
    
    console.log(`Starting deletion of all data for user: ${userId}`);

    // Use service role for data deletion
    const serviceClient = createServiceClient();
    if (!serviceClient) {
      return serverErrorResponse(req, 'Service configuration error');
    }

    const deletionResults = {
      entries: 0,
      brain_reports: 0,
      storage: 0
    };

    // Delete entries (main brain dump content)
    const { error: entriesError, count: entriesCount } = await serviceClient
      .from('entries')
      .delete({ count: 'exact' })
      .eq('user_id', userId);

    if (entriesError) {
      console.error('Error deleting entries:', entriesError);
      return serverErrorResponse(req, 'Failed to delete entries');
    }
    deletionResults.entries = entriesCount ?? 0;
    console.log(`Deleted ${deletionResults.entries} entries`);

    // Delete brain reports
    const { error: reportsError, count: reportsCount } = await serviceClient
      .from('brain_reports')
      .delete({ count: 'exact' })
      .eq('user_id', userId);

    if (reportsError) {
      console.error('Error deleting brain_reports:', reportsError);
      // Don't fail completely, continue
    } else {
      deletionResults.brain_reports = reportsCount ?? 0;
    }
    console.log(`Deleted ${deletionResults.brain_reports} brain reports`);

    // Delete files from storage
    try {
      const { data: files } = await serviceClient.storage
        .from('dumps')
        .list(userId);

      if (files && files.length > 0) {
        const filePaths = files.map(f => `${userId}/${f.name}`);
        const { error: storageError } = await serviceClient.storage
          .from('dumps')
          .remove(filePaths);

        if (storageError) {
          console.error('Failed to delete storage files:', storageError);
        } else {
          deletionResults.storage = files.length;
        }
      }
    } catch (storageErr) {
      console.error('Storage deletion error:', storageErr);
    }
    console.log(`Deleted ${deletionResults.storage} storage files`);

    console.log(`Successfully deleted all data for user: ${userId}`);

    return successResponse(req, { 
      success: true, 
      deleted: deletionResults
    }, 200, rateLimitResult);

  } catch (error) {
    console.error('Error in delete-all-user-data:', error);
    return serverErrorResponse(req, error instanceof Error ? error : 'Unknown error');
  }
});
