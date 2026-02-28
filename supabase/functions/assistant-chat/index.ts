/**
 * assistant-chat — Your Brain's Search Engine (Backend)
 * 
 * NOW POWERED BY: Anthropic Claude via direct API
 * Stream transform: Claude SSE → OpenAI-compatible SSE (zero frontend changes)
 */

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { getAnthropicHeaders, ANTHROPIC_API_URL, CLAUDE_MODELS, ClaudeError, callClaude } from '../_shared/anthropic.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { escapeForLike } from '../_shared/validation.ts';

// Simple in-memory rate limiting (100 requests per minute per user)
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 100;
const RATE_LIMIT_WINDOW_MS = 60000;

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const userLimit = rateLimitMap.get(userId);
  if (!userLimit || now > userLimit.resetTime) {
    rateLimitMap.set(userId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (userLimit.count >= RATE_LIMIT) return false;
  userLimit.count++;
  return true;
}

interface Entry {
  id: string;
  content: string;
  title: string | null;
  content_type: string;
  content_subtype: string | null;
  tags: string[];
  importance_score: number | null;
  list_items: Array<{ text: string; checked: boolean }>;
  created_at: string;
  event_date?: string;
  event_time?: string;
  image_url?: string | null;
  similarity?: number;
}

interface WeatherData {
  temperature: number;
  weatherCode: number;
  windSpeed: number;
  description: string;
  location: string;
}

function getWeatherDescription(code: number): string {
  const descriptions: Record<number, string> = {
    0: 'Clear sky',
    1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Depositing rime fog',
    51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
    56: 'Light freezing drizzle', 57: 'Dense freezing drizzle',
    61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
    66: 'Light freezing rain', 67: 'Heavy freezing rain',
    71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
    85: 'Slight snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail',
  };
  return descriptions[code] || 'Unknown';
}

function isSnowExpected(code: number): boolean {
  return [71, 73, 75, 77, 85, 86].includes(code);
}

async function fetchWeather(lat = 32.7767, lon = -96.7970, location = "Dallas-Fort Worth"): Promise<WeatherData | null> {
  try {
    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&temperature_unit=fahrenheit&timezone=auto`
    );
    if (!response.ok) { console.warn('Weather API failed:', response.status); return null; }
    const data = await response.json();
    const current = data.current_weather;
    return {
      temperature: Math.round(current.temperature),
      weatherCode: current.weathercode,
      windSpeed: Math.round(current.windspeed),
      description: getWeatherDescription(current.weathercode),
      location,
    };
  } catch (error) { console.warn('Failed to fetch weather:', error); return null; }
}

function detectWeatherIntent(message: string): boolean {
  return /\b(snow|snowing|rain|raining|weather|forecast|temperature|cold|hot|storm|sunny|cloudy|freeze|freezing|sleet|hail|wind|windy|humid|degrees)\b/i.test(message);
}

function detectCalendarIntent(message: string): boolean {
  return /\b(cal[ae]nd[ae]r|schedule|scheduled|upcoming|events?|appointments?|plans?|this week|next week|tomorrow|today|weekend|when am i|when do i|what do i have|what'?s? (on|in) my)\b/i.test(message);
}

function detectWebSearchIntent(message: string, brainContext: string): { shouldSearch: boolean; searchQuery: string; reason: string } {
  const messageLower = message.toLowerCase();
  const personalPatterns = [
    /\b(my|mine)\s+(grocery|groceries|shopping|list|notes?|todo|tasks?|appointments?)/i,
    /\b(what|show|find|search)\s+(my|in my|from my)/i,
    /\bwhat (did|have) i\b/i,
    /\b(remember|recall|saved|dumped)\b/i,
    /\bmy brain\b/i,
  ];
  for (const pattern of personalPatterns) {
    if (pattern.test(messageLower)) return { shouldSearch: false, searchQuery: '', reason: 'personal_query' };
  }
  const learningPatterns = [
    { pattern: /\bhow (do|to|can)\s+(?:i\s+)?(?:learn|start|begin)/i, reason: 'learning_intent' },
    { pattern: /\b(tutorial|course|guide|documentation|docs)\b/i, reason: 'resource_request' },
    { pattern: /\b(latest|current|recent|new|2024|2025|2026)\b/i, reason: 'current_info' },
    { pattern: /\bwhat('s| is) (new|happening|trending)\b/i, reason: 'news_intent' },
    { pattern: /\b(best practices?|how does .* work|explain)\b/i, reason: 'knowledge_request' },
  ];
  for (const { pattern, reason } of learningPatterns) {
    if (messageLower.match(pattern)) {
      const searchQuery = message.replace(/^(hey |hi |jac |please |can you |could you )/i, '').replace(/\?+$/, '').trim();
      return { shouldSearch: true, searchQuery, reason };
    }
  }
  if (brainContext) {
    const techKeywords = /\b(learn|programming|code|framework|library|api|development)\b/i;
    if (techKeywords.test(brainContext) && /\b(should|focus|priority|next|start)\b/i.test(messageLower)) {
      return { shouldSearch: true, searchQuery: `${message} resources tutorials 2026`, reason: 'brain_context_learning' };
    }
  }
  return { shouldSearch: false, searchQuery: '', reason: 'no_match' };
}

interface WebSearchResult {
  answer?: string;
  results: Array<{ title: string; url: string; snippet: string; relevanceScore: number }>;
  contextForLLM: string;
  meta: { query: string; resultCount: number };
}

async function fetchWebContext(query: string, brainContext: string, supabaseUrl: string, authHeader: string): Promise<WebSearchResult | null> {
  try {
    console.log('Fetching web context for:', query);
    const response = await fetch(`${supabaseUrl}/functions/v1/jac-web-search`, {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, brainContext: brainContext.slice(0, 500), searchDepth: 'basic', maxResults: 5, includeAnswer: true }),
    });
    if (!response.ok) { console.warn('Web search failed:', response.status); return null; }
    const data = await response.json();
    console.log(`Web search returned ${data.meta?.resultCount || 0} results`);
    return data;
  } catch (err) { console.error('Web search error:', err); return null; }
}

/**
 * Transform Claude SSE stream → OpenAI-compatible SSE stream
 * This ensures zero frontend changes needed.
 */
function claudeToOpenAIStream(claudeBody: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';

  return new ReadableStream({
    async start(controller) {
      const reader = claudeBody.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Send [DONE] in OpenAI format
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          
          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            
            if (!line.startsWith('data: ')) continue;
            const jsonStr = line.slice(6);
            if (!jsonStr || jsonStr === '[DONE]') continue;
            
            try {
              const event = JSON.parse(jsonStr);
              
              // Claude event types we care about:
              // content_block_delta with type: text_delta
              if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                const openaiChunk = {
                  choices: [{ delta: { content: event.delta.text }, index: 0 }],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
              }
              // message_stop → we'll send [DONE] when the reader is done
            } catch {
              // Skip unparseable lines
            }
          }
        }
      } catch (err) {
        console.error('Stream transform error:', err);
        controller.error(err);
      }
    },
  });
}

serve(async (req) => {
  const corsPreflightResponse = handleCors(req);
  if (corsPreflightResponse) return corsPreflightResponse;

  const corsHeaders = getCorsHeaders(req);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Auth
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Authorization header required' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const jwt = authHeader.replace('Bearer ', '');
    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const authAny = authClient.auth as unknown as {
      getClaims?: (token: string) => Promise<{ data: { claims?: { sub?: string } } | null; error: { message: string } | null }>;
    };

    let userId: string | null = null;
    if (typeof authAny.getClaims === 'function') {
      const { data, error } = await authAny.getClaims(jwt);
      userId = data?.claims?.sub ?? null;
      if (error || !userId) {
        return new Response(JSON.stringify({ error: 'Invalid or expired token' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    } else {
      const { data: { user }, error: authError } = await authClient.auth.getUser(jwt);
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Invalid or expired token' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      userId = user.id;
    }

    const { message, conversationHistory = [], stream = true, entryContext = null } = await req.json();

    if (!message) {
      return new Response(JSON.stringify({ error: 'Message is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (!checkRateLimit(userId)) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // === PRE-STREAM ACTIONS ===
    const weatherIntent = detectWeatherIntent(message);
    const calendarIntent = detectCalendarIntent(message);
    let weatherData: WeatherData | null = null;
    if (weatherIntent) {
      console.log('Weather intent detected, fetching weather...');
      // Read location from user settings if available
      let userLat: number | undefined;
      let userLon: number | undefined;
      let userLocation: string | undefined;
      try {
        const { data: settings } = await supabase
          .from('user_settings')
          .select('settings')
          .eq('user_id', userId)
          .maybeSingle();
        const s = settings?.settings as Record<string, unknown> | null;
        if (s?.latitude && s?.longitude) {
          userLat = Number(s.latitude);
          userLon = Number(s.longitude);
          userLocation = (s.location_name as string) || undefined;
        }
      } catch (err) {
        console.warn('Failed to read user location settings:', err);
      }
      weatherData = await fetchWeather(userLat, userLon, userLocation);
    }

    let webSearchResult: WebSearchResult | null = null;

    // Search entries
    console.log('Performing search for:', message);
    let relevantEntries: Entry[] = [];

    if (message.length > 10) {
      try {
        const embResponse = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message, input_type: 'query' }),
        });
        if (embResponse.ok) {
          const embData = await embResponse.json();
          if (embData.embedding) {
            const { data: semanticResults } = await supabase.rpc('search_entries_by_embedding', {
              query_embedding: JSON.stringify(embData.embedding),
              match_threshold: 0.55,
              match_count: 10,
              filter_user_id: userId,
            });
            if (semanticResults && semanticResults.length > 0) {
              relevantEntries = semanticResults as Entry[];
              console.log(`Found ${relevantEntries.length} entries via semantic search`);
            }
          }
        }
      } catch (embErr) { console.warn('Semantic search failed:', embErr); }
    }
    
    const searchWords = message.toLowerCase().split(/\s+/)
      .filter((w: string) => w.length >= 2 && !/^(the|and|or|is|it|to|a|an|in|on|at|for|of|my|i|me|do|what|how|when|where|why)$/i.test(w))
      .slice(0, 5);
    
    const searchVariations = searchWords.flatMap((word: string) => {
      const variations = [word];
      if (word.endsWith('ies')) variations.push(word.slice(0, -3) + 'y');
      if (word.endsWith('es')) variations.push(word.slice(0, -2));
      if (word.endsWith('s') && !word.endsWith('ss')) variations.push(word.slice(0, -1));
      if (word.endsWith('ing')) variations.push(word.slice(0, -3));
      if (word.endsWith('ed')) variations.push(word.slice(0, -2));
      if (!word.endsWith('s')) variations.push(word + 's');
      if (!word.endsWith('ies') && word.endsWith('y')) variations.push(word.slice(0, -1) + 'ies');
      return [...new Set(variations)];
    });
    
    if (searchWords.length > 0) {
      // Build OR clause using ALL search words (not just the first one)
      const orClauses = searchWords
        .map((w: string) => {
          const ew = escapeForLike(w);
          return `content.ilike.%${ew}%,title.ilike.%${ew}%`;
        })
        .join(',');
      const { data: contentResults, error: searchError } = await supabase
        .from('entries')
        .select('id, content, title, content_type, content_subtype, tags, importance_score, list_items, created_at, event_date, event_time, image_url')
        .eq('user_id', userId)
        .eq('archived', false)
        .or(orClauses)
        .order('importance_score', { ascending: false, nullsFirst: false })
        .limit(15);
      if (!searchError && contentResults) {
        relevantEntries = contentResults as Entry[];
        console.log(`Found ${relevantEntries.length} entries via keyword search`);
      }

      if (relevantEntries.length < 10) {
        for (const variation of searchVariations.slice(0, 3)) {
          const { data: tagResults } = await supabase
            .from('entries')
            .select('id, content, title, content_type, content_subtype, tags, importance_score, list_items, created_at, event_date, event_time, image_url')
            .eq('user_id', userId)
            .eq('archived', false)
            .contains('tags', [variation])
            .order('importance_score', { ascending: false, nullsFirst: false })
            .limit(10);
          if (tagResults) {
            for (const entry of tagResults) {
              if (!relevantEntries.find((e) => e.id === entry.id)) relevantEntries.push(entry as Entry);
            }
          }
        }
      }
    }

    // Calendar entries
    let calendarEntries: Entry[] = [];
    const today = new Date().toISOString().split('T')[0];
    const { data: upcomingEvents } = await supabase
      .from('entries')
      .select('id, content, title, content_type, content_subtype, tags, importance_score, list_items, created_at, event_date, event_time, image_url')
      .eq('user_id', userId)
      .eq('archived', false)
      .not('event_date', 'is', null)
      .gte('event_date', today)
      .order('event_date', { ascending: true })
      .limit(15);
    if (upcomingEvents) calendarEntries = upcomingEvents as Entry[];

    // Recent entries
    const { data: recentEntries } = await supabase
      .from('entries')
      .select('id, content, title, content_type, content_subtype, tags, importance_score, list_items, created_at, event_date, event_time, image_url')
      .eq('user_id', userId)
      .eq('archived', false)
      .order('created_at', { ascending: false })
      .limit(8);

    const allEntries = [...calendarEntries, ...relevantEntries];
    if (recentEntries) {
      for (const entry of recentEntries) {
        if (!allEntries.find((e) => e.id === entry.id)) allEntries.push(entry as Entry);
      }
    }

    const contextEntries = allEntries.slice(0, 10);
    const contextText = contextEntries
      .map((entry) => {
        let entryText = `[${entry.content_type}${entry.content_subtype ? `/${entry.content_subtype}` : ''}] `;
        entryText += entry.title ? `"${entry.title}": ` : '';
        entryText += entry.content.slice(0, 500);
        if (entry.event_date) { entryText += `\n📅 Date: ${entry.event_date}`; if (entry.event_time) entryText += ` at ${entry.event_time}`; }
        if (entry.list_items && entry.list_items.length > 0) {
          entryText += `\nList items: ${entry.list_items.map((i) => `${i.checked ? '✓' : '○'} ${i.text}`).join(', ')}`;
        }
        if (entry.tags && entry.tags.length > 0) entryText += ` [tags: ${entry.tags.join(', ')}]`;
        return entryText;
      })
      .join('\n\n');

    let actionContext = '';
    if (weatherData) {
      const snowWarning = isSnowExpected(weatherData.weatherCode) ? '\n⚠️ SNOW IS EXPECTED. Mention this proactively.' : '';
      actionContext += `\n\n=== CURRENT WEATHER (${weatherData.location}) ===\nTemperature: ${weatherData.temperature}°F\nConditions: ${weatherData.description}\nWind: ${weatherData.windSpeed} mph${snowWarning}\n`;
    }

    if (calendarIntent || calendarEntries.length > 0) {
      if (calendarEntries.length > 0) {
        const calText = calendarEntries.map(e => {
          let line = `- ${e.title || 'Untitled'}`;
          if (e.event_date) line += ` — ${e.event_date}`;
          if (e.event_time) line += ` at ${e.event_time}`;
          return line;
        }).join('\n');
        actionContext += `\n\n=== YOUR CALENDAR (upcoming events) ===\n${calText}\nPresent these as the user's upcoming schedule when asked.\n`;
      } else if (calendarIntent) {
        actionContext += `\n\n=== YOUR CALENDAR ===\nNo upcoming events saved. Let the user know their calendar is empty and suggest they save events with dates.\n`;
      }
    }

    const webSearchIntent = detectWebSearchIntent(message, contextText);
    if (webSearchIntent.shouldSearch) {
      console.log(`Web search triggered (reason: ${webSearchIntent.reason})`);
      webSearchResult = await fetchWebContext(webSearchIntent.searchQuery, contextText, supabaseUrl, authHeader);
      if (webSearchResult?.contextForLLM) {
        actionContext += `\n\n=== REAL-TIME WEB CONTEXT ===\n${webSearchResult.contextForLLM}\n\nSynthesize with brain data. Cite sources when helpful.\n`;
      }
    }

    let viewingContext = '';
    if (entryContext) {
      viewingContext = `\n=== ENTRY YOU'RE VIEWING ===\nType: ${entryContext.content_type}\nTitle: ${entryContext.title || 'Untitled'}\nContent: ${entryContext.content}\n\nIf they reference "this entry" - they mean THIS entry.\n`;
    }

    const systemPrompt = `You are Jac, the user's personal brain assistant. You are OBEDIENT and ACTION-ORIENTED.

=== CRITICAL RULES ===
1. NEVER ask follow-up questions. Ever. Just act.
2. NEVER ask for clarification. Infer from context.
3. When the user wants something saved - it's ALREADY DONE. Just confirm briefly.
4. Be CONCISE. One short confirmation. Done.
5. You are aware and intelligent - infer what they mean from context.
6. You are obedient - do exactly what they ask without questioning.

=== HOW TO RESPOND ===
WRONG: "I've added salt to your list! Is there anything else you'd like to add?"
RIGHT: "Done. Added salt to Shopping List."

=== WEATHER AWARENESS ===
When you have weather data, share it proactively. Be helpful about weather-related tasks.

=== YOUR CAPABILITIES ===
- Search and retrieve from the user's LinkJac brain
- Help find things they've saved
- Compile and summarize related entries
- Surface connections between entries
- Saving/adding is handled BEFORE you respond - just confirm
- Show upcoming calendar events and schedule from saved entries
- ACCESS REAL-TIME WEB INFORMATION when needed
- For complex research, multi-step analysis, or agent tasks, suggest the user open the JAC Command Center at /jac

=== LISTS ===
Show items with: ✓ (done) or ○ (pending). Be brief.

=== IF YOU DON'T KNOW ===
Say briefly: "Nothing in your brain about that."
${actionContext}
${viewingContext}
${contextText ? `\n\nUser's brain contents:\n\n${contextText}` : '\n\nUser has no entries yet.'}`;

    // Sources for response
    const sourcesUsed = contextEntries.map((e) => ({
      id: e.id, title: e.title, content: e.content, content_type: e.content_type,
      content_subtype: e.content_subtype, tags: e.tags || [], importance_score: e.importance_score,
      created_at: e.created_at, event_date: e.event_date, event_time: e.event_time,
      list_items: e.list_items, image_url: e.image_url, similarity: e.similarity,
    }));

    // Build Claude messages (system prompt is a top-level field, not in messages)
    const claudeMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    // Add conversation history
    for (const msg of conversationHistory.slice(-6)) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        claudeMessages.push({ role: msg.role, content: msg.content });
      }
    }
    claudeMessages.push({ role: 'user', content: message });

    console.log(`Generating assistant response (stream: ${stream})...`);

    if (stream) {
      // Call Claude with streaming
      const anthropicHeaders = getAnthropicHeaders();
      const claudeStreamResponse = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: anthropicHeaders,
        body: JSON.stringify({
          model: CLAUDE_MODELS.sonnet,
          system: systemPrompt,
          messages: claudeMessages,
          max_tokens: 4096,
          stream: true,
        }),
      });

      if (!claudeStreamResponse.ok) {
        const errorText = await claudeStreamResponse.text();
        console.error('Claude streaming error:', claudeStreamResponse.status, errorText);
        if (claudeStreamResponse.status === 429) {
          return new Response(JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }),
            { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (claudeStreamResponse.status === 402) {
          return new Response(JSON.stringify({ error: 'AI credits exhausted.' }),
            { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        throw new Error(`Claude streaming failed: ${claudeStreamResponse.status}`);
      }

      // Transform Claude SSE → OpenAI SSE, prepend sources
      const encoder = new TextEncoder();
      const openAIStream = claudeToOpenAIStream(claudeStreamResponse.body!);

      const transformStream = new TransformStream({
        start(controller) {
          const metaEvent = `data: ${JSON.stringify({
            sources: sourcesUsed,
            webSources: webSearchResult?.results || [],
            savedEntry: null,
            weather: weatherData,
          })}\n\n`;
          controller.enqueue(encoder.encode(metaEvent));
        },
        transform(chunk, controller) {
          controller.enqueue(chunk);
        },
      });

      const finalStream = openAIStream.pipeThrough(transformStream);

      return new Response(finalStream, {
        headers: { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
      });
    }

    // Non-streaming fallback
    const claudeResponse = await callClaude({
      model: CLAUDE_MODELS.sonnet,
      system: systemPrompt,
      messages: claudeMessages,
      max_tokens: 4096,
    });

    const responseText = claudeResponse.content.find(c => c.type === 'text')?.text || 'I encountered an error. Please try again.';

    return new Response(
      JSON.stringify({
        response: responseText,
        sourcesUsed,
        webSources: webSearchResult?.results || [],
        savedEntry: null,
        weather: weatherData,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in assistant-chat function:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error occurred' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
