import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { query, userId, useSemanticSearch } = await req.json();

    if (!query || !userId) {
      throw new Error('Missing required fields');
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    let messages;
    
    // Use semantic search if requested and embeddings are available
    if (useSemanticSearch) {
      try {
        // Generate embedding for the search query
        const embeddingResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-embedding`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: query }),
        });

        if (!embeddingResponse.ok) {
          console.error('Failed to generate query embedding, falling back to keyword search');
          throw new Error('Embedding generation failed');
        }

        const embeddingData = await embeddingResponse.json();
        const queryEmbedding = embeddingData.embedding;

        // Use the semantic search function
        const { data: semanticResults, error: semanticError } = await supabaseClient
          .rpc('search_messages_by_embedding', {
            query_embedding: queryEmbedding,
            match_threshold: 0.3, // Minimum similarity threshold (0-1)
            match_count: 50,
            filter_user_id: userId,
          });

        if (semanticError) {
          console.error('Semantic search error:', semanticError);
          throw semanticError;
        }

        // Fetch conversation titles for semantic results
        const conversationIds = [...new Set(semanticResults?.map((m: any) => m.conversation_id))];
        const { data: conversations } = await supabaseClient
          .from('conversations')
          .select('id, title')
          .in('id', conversationIds);

        const convMap = new Map(conversations?.map(c => [c.id, c.title]) || []);

        messages = semanticResults?.map((msg: any) => ({
          ...msg,
          conversations: { title: convMap.get(msg.conversation_id) || 'Untitled' }
        }));

      } catch (semanticError) {
        console.error('Semantic search failed, falling back to keyword search:', semanticError);
        // Fall back to keyword search
        const { data: keywordResults, error: keywordError } = await supabaseClient
          .from('messages')
          .select('*, conversations!inner(title)')
          .eq('user_id', userId)
          .or(`content.ilike.%${query}%,topic.ilike.%${query}%`)
          .order('created_at', { ascending: false })
          .limit(50);

        if (keywordError) throw keywordError;
        messages = keywordResults;
      }
    } else {
      // Standard keyword search
      const { data: keywordResults, error: keywordError } = await supabaseClient
        .from('messages')
        .select('*, conversations!inner(title)')
        .eq('user_id', userId)
        .or(`content.ilike.%${query}%,topic.ilike.%${query}%`)
        .order('created_at', { ascending: false })
        .limit(50);

      if (keywordError) throw keywordError;
      messages = keywordResults;
    }

    // Group results by conversation
    const groupedResults: { [key: string]: any } = {};
    messages?.forEach((msg: any) => {
      const convId = msg.conversation_id;
      if (!groupedResults[convId]) {
        groupedResults[convId] = {
          conversation_id: convId,
          conversation_title: msg.conversations?.title || 'Untitled',
          messages: [],
        };
      }
      groupedResults[convId].messages.push({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        topic: msg.topic,
        created_at: msg.created_at,
        similarity: msg.similarity || undefined,
      });
    });

    const results = Object.values(groupedResults);

    return new Response(
      JSON.stringify({ results, total: messages?.length || 0 }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in search-memory function:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
