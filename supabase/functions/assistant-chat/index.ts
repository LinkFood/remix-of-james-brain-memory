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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { message, userId, conversationHistory = [] } = await req.json();

    if (!message || !userId) {
      return new Response(
        JSON.stringify({ error: 'Message and userId are required' }),
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

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY')!;

    const supabase = createClient(supabaseUrl, supabaseKey);

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

    // Step 5: Create system prompt
    const systemPrompt = `You are the user's personal assistant for their "Brain Dump" app. You ONLY know what they've dumped into their brain.

You have access to their stored entries: code snippets, lists (grocery, todo), ideas, notes, reminders, links, and more.

Your job is to:
1. Answer questions using ONLY their stored data
2. Help them find things they've saved
3. Compile related entries into summaries
4. Surface connections between entries
5. Be helpful and concise

If you don't have information about something, say "I don't see anything about that in your brain dump." Don't make things up.

For lists, show items clearly with checkboxes (✓ for checked, ○ for unchecked).
For code, mention the language if known.
Always cite which entry you're referring to when relevant.

${contextText ? `\n\nHere are relevant entries from the user's brain:\n\n${contextText}` : '\n\nThe user has no entries yet.'}`;

    // Step 6: Build conversation messages
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.slice(-6), // Keep last 6 messages for context
      { role: 'user', content: message },
    ];

    // Step 7: Call AI for response
    console.log('Generating assistant response...');
    const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages,
        max_tokens: 1024,
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

      throw new Error(`AI request failed: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    const response = aiData.choices[0]?.message?.content || 'I encountered an error. Please try again.';

    // Step 8: Check if the AI wants to create a new dump
    let newDumpCreated = null;

    // Simple heuristic: if user asks to "save", "add", "remember", or "dump" something
    const saveIntent = /\b(save|add|remember|dump|store|note down)\b/i.test(message);
    if (saveIntent) {
      // Extract what to save from the message
      const contentToSave = message
        .replace(/\b(please\s+)?(save|add|remember|dump|store|note down|this|that|to my brain|to brain dump|for me)\b/gi, '')
        .trim();

      if (contentToSave.length > 5) {
        try {
          const { data, error } = await supabase.functions.invoke('smart-save', {
            body: {
              content: contentToSave,
              userId,
              source: 'assistant',
            },
          });

          if (!error && data?.entry) {
            newDumpCreated = data.entry;
            console.log('Created new entry from assistant:', newDumpCreated.id);
          }
        } catch (saveError) {
          console.error('Failed to save from assistant:', saveError);
        }
      }
    }

    return new Response(
      JSON.stringify({
        response,
        sourcesUsed: contextEntries.map((e) => ({
          id: e.id,
          title: e.title,
          content_type: e.content_type,
          similarity: e.similarity,
        })),
        newDumpCreated,
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
