/**
 * elevenlabs-tts — Text-to-Speech for Brain Responses
 * 
 * GOAL: Make your brain speak back to you.
 * 
 * Takes text, returns audio. Simple.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId } from '../_shared/auth.ts';
import { checkRateLimit, getRateLimitHeaders } from '../_shared/rateLimit.ts';
import { errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { sanitizeString, validateContentLength, parseJsonBody } from '../_shared/validation.ts';

interface TTSRequest {
  text: string;
  voiceId?: string;
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

    // Rate limiting - 30 requests per minute
    const rateLimitResult = checkRateLimit(`tts:${userId}`, { maxRequests: 30, windowMs: 60000 });
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

    // Parse request
    const { data: body, error: parseError } = await parseJsonBody<TTSRequest>(req);
    if (parseError || !body) {
      return errorResponse(req, parseError || 'Invalid request body', 400);
    }

    const text = sanitizeString(body.text);
    if (!text) {
      return errorResponse(req, 'Text is required', 400);
    }

    const validation = validateContentLength(text, 5000);
    if (!validation.valid) {
      return errorResponse(req, validation.error!, 400);
    }

    const voiceId = body.voiceId || 'JBFqnCBsd6RMkjVDRZzb'; // Default: George voice

    console.log(`[elevenlabs-tts] Generating speech for ${text.length} chars, voice: ${voiceId}`);

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.3,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[elevenlabs-tts] ElevenLabs API error:', response.status, errorText);
      
      if (response.status === 429) {
        return errorResponse(req, 'Voice service rate limit. Try again in a moment.', 429);
      }

      return serverErrorResponse(req, 'Voice generation failed');
    }

    const audioBuffer = await response.arrayBuffer();
    console.log(`[elevenlabs-tts] Generated ${audioBuffer.byteLength} bytes of audio`);

    return new Response(audioBuffer, {
      headers: {
        ...corsHeaders,
        ...getRateLimitHeaders(rateLimitResult),
        'Content-Type': 'audio/mpeg',
      },
    });

  } catch (error) {
    console.error('[elevenlabs-tts] Error:', error);
    return serverErrorResponse(req, error instanceof Error ? error : 'Unknown error');
  }
});
