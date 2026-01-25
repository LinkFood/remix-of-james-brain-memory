/**
 * elevenlabs-stt — Speech-to-Text for Brain Dumps
 * 
 * GOAL: Speak your dumps, don't type them.
 * 
 * Takes audio, returns text. Let the brain hear you.
 */

import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId } from '../_shared/auth.ts';
import { checkRateLimit, getRateLimitHeaders } from '../_shared/rateLimit.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';

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

    // Rate limiting - 20 requests per minute
    const rateLimitResult = checkRateLimit(`stt:${userId}`, { maxRequests: 20, windowMs: 60000 });
    if (!rateLimitResult.allowed) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded. Please try again later.', retryAfter: Math.ceil(rateLimitResult.resetIn / 1000) }),
        { 
          status: 429, 
          headers: { ...corsHeaders, ...getRateLimitHeaders(rateLimitResult), 'Content-Type': 'application/json' } 
        }
      );
    }

    // Check for API key
    const ELEVENLABS_API_KEY = Deno.env.get('ELEVENLABS_API_KEY');
    if (!ELEVENLABS_API_KEY) {
      console.error('ELEVENLABS_API_KEY not configured');
      return errorResponse(req, 'Voice service not configured', 503);
    }

    // Get the audio file from the request
    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return errorResponse(req, 'Expected multipart/form-data with audio file', 400);
    }

    const formData = await req.formData();
    const audioFile = formData.get('audio') as File;

    if (!audioFile) {
      return errorResponse(req, 'Audio file is required', 400);
    }

    // Limit audio size to 25MB
    const MAX_SIZE = 25 * 1024 * 1024;
    if (audioFile.size > MAX_SIZE) {
      return errorResponse(req, 'Audio file too large (max 25MB)', 400);
    }

    console.log(`[elevenlabs-stt] Transcribing ${audioFile.size} bytes, type: ${audioFile.type}`);

    // Build form data for ElevenLabs API
    const apiFormData = new FormData();
    apiFormData.append('file', audioFile);
    apiFormData.append('model_id', 'scribe_v2');
    apiFormData.append('tag_audio_events', 'false');
    apiFormData.append('diarize', 'false');

    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
      },
      body: apiFormData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[elevenlabs-stt] ElevenLabs API error:', response.status, errorText);

      // Pass through rate limit errors so client can use fallback
      if (response.status === 429) {
        return errorResponse(req, 'Voice service rate limit. Try again in a moment.', 429);
      }

      // Pass through 401 (unusual activity / free tier blocked) so client can fallback
      if (response.status === 401) {
        return errorResponse(req, 'Voice service unavailable. Please try browser speech.', 401);
      }

      return serverErrorResponse(req, 'Transcription failed');
    }

    const transcription = await response.json();
    console.log(`[elevenlabs-stt] Transcribed: "${transcription.text?.substring(0, 100)}..."`);

    return successResponse(req, {
      text: transcription.text || '',
      words: transcription.words || [],
    }, 200, rateLimitResult);

  } catch (error) {
    console.error('[elevenlabs-stt] Error:', error);
    return serverErrorResponse(req, error instanceof Error ? error : 'Unknown error');
  }
});
