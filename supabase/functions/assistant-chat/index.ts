/**
 * assistant-chat — Your Brain's Search Engine (Backend)
 * 
 * GOAL: "What was that thing..." → Found it.
 * 
 * This streams responses word-by-word for instant feel.
 * Rate limited. Searches embeddings. Shows sources.
 * 
 * NOW WITH: Weather awareness + Pre-stream save execution
 */

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

// Simple in-memory rate limiting (100 requests per minute per user)
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 100;
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const userLimit = rateLimitMap.get(userId);

  if (!userLimit || now > userLimit.resetTime) {
    rateLimitMap.set(userId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (userLimit.count >= RATE_LIMIT) {
    return false;
  }

  userLimit.count++;
  return true;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
  similarity?: number;
}

interface WeatherData {
  temperature: number;
  weatherCode: number;
  windSpeed: number;
  description: string;
  location: string;
}

// Weather code to description mapping (WMO codes)
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

// Check if snow is expected
function isSnowExpected(code: number): boolean {
  return [71, 73, 75, 77, 85, 86].includes(code);
}

// Fetch weather from Open-Meteo (free, no API key needed)
async function fetchWeather(lat = 40.7128, lon = -74.0060, location = "New York"): Promise<WeatherData | null> {
  try {
    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&temperature_unit=fahrenheit&timezone=auto`
    );
    
    if (!response.ok) {
      console.warn('Weather API failed:', response.status);
      return null;
    }
    
    const data = await response.json();
    const current = data.current_weather;
    
    return {
      temperature: Math.round(current.temperature),
      weatherCode: current.weathercode,
      windSpeed: Math.round(current.windspeed),
      description: getWeatherDescription(current.weathercode),
      location,
    };
  } catch (error) {
    console.warn('Failed to fetch weather:', error);
    return null;
  }
}

// Detect if user is asking about weather
function detectWeatherIntent(message: string): boolean {
  const weatherKeywords = /\b(snow|snowing|rain|raining|weather|forecast|temperature|cold|hot|storm|sunny|cloudy|freeze|freezing|sleet|hail|wind|windy|humid|degrees)\b/i;
  return weatherKeywords.test(message);
}

// Detect save intent and extract what to save
function detectSaveIntent(message: string): { hasSaveIntent: boolean; contentToSave: string; listName?: string } {
  const savePatterns = [
    /\b(add|put)\s+(.+?)\s+(?:to|on)\s+(?:my\s+)?(.+?)\s*(?:list)?$/i,
    /\b(add|put)\s+(.+?)\s+(?:to|on)\s+(.+?)$/i,
    /\b(save|remember|note|dump|store)\s+(?:that\s+)?(.+)/i,
    /\b(add)\s+(.+?)\s+(?:to\s+)?(?:my\s+)?(?:shopping|grocery|todo|to-do)/i,
  ];

  for (const pattern of savePatterns) {
    const match = message.match(pattern);
    if (match) {
      if (pattern === savePatterns[0] || pattern === savePatterns[1]) {
        return { hasSaveIntent: true, contentToSave: match[2].trim(), listName: match[3]?.trim() };
      }
      return { hasSaveIntent: true, contentToSave: match[2].trim() };
    }
  }

  // Fallback: general save intent
  const hasSaveIntent = /\b(save|add|remember|dump|store|note down)\b/i.test(message);
  if (hasSaveIntent) {
    const contentToSave = message
      .replace(/\b(please\s+)?(save|add|remember|dump|store|note down|this|that|to my brain|to brain dump|for me)\b/gi, '')
      .trim();
    return { hasSaveIntent: contentToSave.length > 5, contentToSave };
  }

  return { hasSaveIntent: false, contentToSave: '' };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY')!;

    const supabase = createClient(supabaseUrl, supabaseKey);

    // SECURITY FIX: Extract user ID from JWT instead of request body
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Authorization header required' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const jwt = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userId = user.id;

    const { message, conversationHistory = [], stream = true } = await req.json();

    if (!message) {
      return new Response(
        JSON.stringify({ error: 'Message is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check rate limit
    if (!checkRateLimit(userId)) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // === PRE-STREAM ACTIONS ===
    
    // 1. Check for save intent and execute BEFORE streaming
    const saveIntent = detectSaveIntent(message);
    let savedEntry: Entry | null = null;
    let saveError: string | null = null;
    
    if (saveIntent.hasSaveIntent && saveIntent.contentToSave) {
      console.log('Save intent detected, executing save before stream...');
      try {
        const saveResponse = await fetch(`${supabaseUrl}/functions/v1/smart-save`, {
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: saveIntent.listName 
              ? `${saveIntent.contentToSave} (${saveIntent.listName})` 
              : saveIntent.contentToSave,
            source: 'assistant',
          }),
        });

        if (saveResponse.ok) {
          const saveData = await saveResponse.json();
          if (saveData?.entry) {
            savedEntry = saveData.entry;
            console.log('Pre-stream save successful:', savedEntry?.id);
          }
        } else {
          saveError = 'Failed to save';
          console.warn('Pre-stream save failed:', await saveResponse.text());
        }
      } catch (err) {
        saveError = 'Failed to save';
        console.error('Pre-stream save error:', err);
      }
    }

    // 2. Check for weather intent and fetch data
    const weatherIntent = detectWeatherIntent(message);
    let weatherData: WeatherData | null = null;
    
    if (weatherIntent) {
      console.log('Weather intent detected, fetching weather...');
      // TODO: In future, get user's location from profile
      weatherData = await fetchWeather();
      console.log('Weather data:', weatherData);
    }

    // Step 1: Generate embedding for the user's message
    console.log('Generating embedding for query...');
    const embeddingResponse = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: message }),
    });

    let relevantEntries: Entry[] = [];

    if (embeddingResponse.ok) {
      const { embedding } = await embeddingResponse.json();

      // Step 2: Search for relevant entries
      console.log('Searching for relevant entries...');
      const { data: searchResults, error: searchError } = await supabase.rpc(
        'search_entries_by_embedding',
        {
          query_embedding: embedding,
          filter_user_id: userId,
          match_count: 10,
          match_threshold: 0.5,
        }
      );

      if (!searchError && searchResults) {
        relevantEntries = searchResults;
        console.log(`Found ${relevantEntries.length} relevant entries`);
      } else {
        console.warn('Semantic search failed:', searchError);
      }
    } else {
      console.warn('Failed to generate embedding, proceeding without semantic search');
    }

    // Step 3: Also fetch recent entries for context
    const { data: recentEntries } = await supabase
      .from('entries')
      .select('id, content, title, content_type, content_subtype, tags, importance_score, list_items, created_at')
      .eq('user_id', userId)
      .eq('archived', false)
      .order('created_at', { ascending: false })
      .limit(5);

    // Combine and deduplicate entries
    const allEntries = [...relevantEntries];
    if (recentEntries) {
      for (const entry of recentEntries) {
        if (!allEntries.find((e) => e.id === entry.id)) {
          allEntries.push(entry as Entry);
        }
      }
    }

    // Step 4: Build context from entries
    const contextEntries = allEntries.slice(0, 15);
    const contextText = contextEntries
      .map((entry) => {
        let entryText = `[${entry.content_type}${entry.content_subtype ? `/${entry.content_subtype}` : ''}] `;
        entryText += entry.title ? `"${entry.title}": ` : '';
        entryText += entry.content.slice(0, 500);
        if (entry.list_items && entry.list_items.length > 0) {
          entryText += `\nList items: ${entry.list_items.map((i) => `${i.checked ? '✓' : '○'} ${i.text}`).join(', ')}`;
        }
        if (entry.tags && entry.tags.length > 0) {
          entryText += ` [tags: ${entry.tags.join(', ')}]`;
        }
        return entryText;
      })
      .join('\n\n');

    // Build dynamic context for pre-executed actions
    let actionContext = '';
    
    if (savedEntry) {
      actionContext += `\n\n=== SAVE COMPLETED ===\nYou just saved "${saveIntent.contentToSave}" to "${savedEntry.title || savedEntry.content_type}". Confirm this briefly.\n`;
    } else if (saveIntent.hasSaveIntent && saveError) {
      actionContext += `\n\n=== SAVE FAILED ===\nFailed to save "${saveIntent.contentToSave}". Apologize briefly.\n`;
    }
    
    if (weatherData) {
      const snowWarning = isSnowExpected(weatherData.weatherCode) 
        ? '\n⚠️ SNOW IS EXPECTED. Mention this proactively.' 
        : '';
      actionContext += `\n\n=== CURRENT WEATHER (${weatherData.location}) ===
Temperature: ${weatherData.temperature}°F
Conditions: ${weatherData.description}
Wind: ${weatherData.windSpeed} mph${snowWarning}
Use this info proactively in your response.\n`;
    }

    // Step 5: Create system prompt - ACTION-ORIENTED, NO QUESTIONS
    const systemPrompt = `You are Jac, the user's personal brain assistant. You are OBEDIENT and ACTION-ORIENTED.

=== CRITICAL RULES ===
1. NEVER ask follow-up questions. Ever. Not "Is there anything else?" Not "Would you like me to...?" Just act.
2. NEVER ask for clarification. Infer from context. Make your best guess and execute.
3. When the user wants something saved, added, or remembered - it's ALREADY DONE (see action context below). Just confirm briefly.
4. Be CONCISE. One short confirmation. Done.
5. You are aware and intelligent - infer what they mean from context.
6. You are obedient - do exactly what they ask without questioning.

=== HOW TO RESPOND ===
WRONG: "I've added salt to your list! Is there anything else you'd like to add?"
RIGHT: "Done. Added salt to Shopping List."

WRONG: "Would you like me to create a new grocery list for that?"
RIGHT: "Added to your Grocery List. ✓"

WRONG: "I don't see a list for that. Should I create one?"
RIGHT: "Created new Shopping List with: Salt ✓"

=== WEATHER AWARENESS ===
When you have weather data, share it proactively. Be helpful about weather-related tasks.
If snow is expected and they're adding salt - connect the dots but stay brief.

=== YOUR CAPABILITIES ===
- Search and retrieve from the user's brain dump
- Help find things they've saved
- Compile and summarize related entries
- Surface connections between entries
- Saving/adding is handled BEFORE you respond - just confirm

=== LISTS ===
Show items with: ✓ (done) or ○ (pending)
Be brief. No fluff.

=== IF YOU DON'T KNOW ===
Say briefly: "Nothing in your brain about that." Don't apologize excessively.
${actionContext}
${contextText ? `\n\nUser's brain contents:\n\n${contextText}` : '\n\nUser has no entries yet.'}`;

    // Step 6: Build conversation messages
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.slice(-6), // Keep last 6 messages for context
      { role: 'user', content: message },
    ];

    // Prepare sources for response (send before streaming)
    const sourcesUsed = contextEntries.map((e) => ({
      id: e.id,
      title: e.title,
      content_type: e.content_type,
      similarity: e.similarity,
    }));

    // Step 7: Call AI for response (streaming or non-streaming)
    console.log(`Generating assistant response (stream: ${stream})...`);
    const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-3-flash-preview',
        messages,
        max_tokens: 4096,
        stream,
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error('AI response error:', aiResponse.status, errorText);

      if (aiResponse.status === 429) {
        return new Response(
          JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (aiResponse.status === 402) {
        return new Response(
          JSON.stringify({ error: 'AI credits exhausted. Please add more credits.' }),
          { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`AI request failed: ${aiResponse.status}`);
    }

    // If streaming, return the stream directly with sources prepended
    if (stream && aiResponse.body) {
      // Create a transform stream that prepends sources and saved entry as first SSE event
      const encoder = new TextEncoder();
      
      const transformStream = new TransformStream({
        start(controller) {
          // Send sources and saved entry as first event
          const metaEvent = `data: ${JSON.stringify({ 
            sources: sourcesUsed,
            savedEntry: savedEntry ? { id: savedEntry.id, title: savedEntry.title } : null,
            weather: weatherData,
          })}\n\n`;
          controller.enqueue(encoder.encode(metaEvent));
        },
        transform(chunk, controller) {
          controller.enqueue(chunk);
        },
      });

      const readableStream = aiResponse.body.pipeThrough(transformStream);

      return new Response(readableStream, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    // Non-streaming fallback
    const aiData = await aiResponse.json();
    const response = aiData.choices[0]?.message?.content || 'I encountered an error. Please try again.';

    return new Response(
      JSON.stringify({
        response,
        sourcesUsed,
        savedEntry: savedEntry ? { id: savedEntry.id, title: savedEntry.title } : null,
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
