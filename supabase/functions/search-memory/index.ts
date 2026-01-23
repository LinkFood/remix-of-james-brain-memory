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
    const { 
      query, 
      userId, 
      useSemanticSearch = true,
      startDate, 
      endDate,
      contentType,
      minImportance,
      maxImportance,
      tags,
      limit = 50
    } = await req.json();

    if (!query || !userId) {
      throw new Error('Missing required fields: query and userId');
    }

    console.log('Search request:', { query, userId, useSemanticSearch, contentType, tags });

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    let entries: any[] = [];
    
    // Use semantic search if requested
    if (useSemanticSearch) {
      try {
        console.log('Attempting semantic search...');
        
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
        
        console.log('Generated query embedding, searching...');

        // Use the semantic search function for entries
        const { data: semanticResults, error: semanticError } = await supabaseClient
          .rpc('search_entries_by_embedding', {
            query_embedding: `[${queryEmbedding.join(',')}]`,
            filter_user_id: userId,
            match_count: limit * 2, // Get more to filter
            match_threshold: 0.3,
          });
        
        if (semanticError) {
          console.error('Semantic search RPC error:', semanticError);
          throw semanticError;
        }
        
        console.log(`Semantic search returned ${semanticResults?.length || 0} results`);
        entries = semanticResults || [];

      } catch (semanticError) {
        console.error('Semantic search failed, falling back to keyword search:', semanticError);
        // Fall back to keyword search
        const { data: keywordResults, error: keywordError } = await supabaseClient
          .from('entries')
          .select('*')
          .eq('user_id', userId)
          .eq('archived', false)
          .or(`content.ilike.%${query}%,title.ilike.%${query}%`)
          .order('created_at', { ascending: false })
          .limit(limit * 2);

        if (keywordError) throw keywordError;
        entries = keywordResults || [];
      }
    } else {
      // Standard keyword search
      console.log('Using keyword search...');
      const { data: keywordResults, error: keywordError } = await supabaseClient
        .from('entries')
        .select('*')
        .eq('user_id', userId)
        .eq('archived', false)
        .or(`content.ilike.%${query}%,title.ilike.%${query}%`)
        .order('created_at', { ascending: false })
        .limit(limit * 2);

      if (keywordError) throw keywordError;
      entries = keywordResults || [];
    }

    // Apply filters
    let filteredEntries = entries;

    // Date filters
    if (startDate) {
      const start = new Date(startDate);
      filteredEntries = filteredEntries.filter((e: any) => new Date(e.created_at) >= start);
    }
    if (endDate) {
      const end = new Date(endDate);
      filteredEntries = filteredEntries.filter((e: any) => new Date(e.created_at) <= end);
    }

    // Content type filter
    if (contentType) {
      filteredEntries = filteredEntries.filter((e: any) => e.content_type === contentType);
    }

    // Importance filters
    if (minImportance !== undefined) {
      filteredEntries = filteredEntries.filter((e: any) => 
        e.importance_score !== null && e.importance_score >= minImportance
      );
    }
    if (maxImportance !== undefined) {
      filteredEntries = filteredEntries.filter((e: any) => 
        e.importance_score !== null && e.importance_score <= maxImportance
      );
    }

    // Tags filter
    if (tags && Array.isArray(tags) && tags.length > 0) {
      filteredEntries = filteredEntries.filter((e: any) => 
        e.tags && tags.some((tag: string) => e.tags.includes(tag))
      );
    }

    // Limit results
    const results = filteredEntries.slice(0, limit);

    console.log(`Returning ${results.length} filtered results`);

    return new Response(
      JSON.stringify({ 
        results, 
        total: results.length,
        query,
        semantic: useSemanticSearch 
      }),
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
