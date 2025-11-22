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
      useSemanticSearch, 
      startDate, 
      endDate, 
      onThisDay,
      provider,
      model,
      minLength,
      maxLength,
      minDuration,
      maxDuration,
      minImportance,
      maxImportance
    } = await req.json();

    if (!query || !userId) {
      throw new Error('Missing required fields');
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    let messages;
    
    // Build date filter conditions
    let dateFilter = '';
    if (onThisDay) {
      // Get messages from this day in any year
      const now = new Date();
      const month = (now.getMonth() + 1).toString().padStart(2, '0');
      const day = now.getDate().toString().padStart(2, '0');
      dateFilter = `AND EXTRACT(MONTH FROM created_at) = ${month} AND EXTRACT(DAY FROM created_at) = ${day}`;
    } else if (startDate || endDate) {
      if (startDate && endDate) {
        dateFilter = `AND created_at >= '${startDate}'::timestamptz AND created_at <= '${endDate}'::timestamptz`;
      } else if (startDate) {
        dateFilter = `AND created_at >= '${startDate}'::timestamptz`;
      } else if (endDate) {
        dateFilter = `AND created_at <= '${endDate}'::timestamptz`;
      }
    }
    
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
        let semanticResults;
        if (dateFilter) {
          // Apply date filter after semantic search
          const { data: allResults, error: semanticError } = await supabaseClient
            .rpc('search_messages_by_embedding', {
              query_embedding: queryEmbedding,
              match_threshold: 0.3,
              match_count: 200, // Get more to filter by date
              filter_user_id: userId,
            });
          
          if (semanticError) throw semanticError;
          
          // Apply date filter in JavaScript
          const now = new Date();
          semanticResults = allResults?.filter((msg: any) => {
            const msgDate = new Date(msg.created_at);
            
            if (onThisDay) {
              return msgDate.getMonth() === now.getMonth() && msgDate.getDate() === now.getDate();
            }
            
            if (startDate && endDate) {
              return msgDate >= new Date(startDate) && msgDate <= new Date(endDate);
            } else if (startDate) {
              return msgDate >= new Date(startDate);
            } else if (endDate) {
              return msgDate <= new Date(endDate);
            }
            
            return true;
          }).slice(0, 50);
        } else {
          const { data: results, error: semanticError } = await supabaseClient
            .rpc('search_messages_by_embedding', {
              query_embedding: queryEmbedding,
              match_threshold: 0.3,
              match_count: 200,
              filter_user_id: userId,
            });
          
          if (semanticError) throw semanticError;
          semanticResults = results;
        }

        // Apply advanced filters to semantic results
        if (provider || model || minLength || maxLength || minImportance !== undefined || maxImportance !== undefined) {
          semanticResults = semanticResults?.filter((msg: any) => {
            if (provider && msg.provider !== provider) return false;
            if (model && msg.model_used !== model) return false;
            if (minLength && msg.content.length < minLength) return false;
            if (maxLength && msg.content.length > maxLength) return false;
            if (minImportance !== undefined && (msg.importance_score === null || msg.importance_score < minImportance)) return false;
            if (maxImportance !== undefined && (msg.importance_score === null || msg.importance_score > maxImportance)) return false;
            return true;
          }).slice(0, 50);
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
        // Fall back to keyword search with date filter
        let keywordQuery = supabaseClient
          .from('messages')
          .select('*, conversations!inner(title)')
          .eq('user_id', userId)
          .or(`content.ilike.%${query}%,topic.ilike.%${query}%`);

        // Apply advanced filters
        if (provider) keywordQuery = keywordQuery.eq('provider', provider);
        if (model) keywordQuery = keywordQuery.eq('model_used', model);
        if (minImportance !== undefined) keywordQuery = keywordQuery.gte('importance_score', minImportance);
        if (maxImportance !== undefined) keywordQuery = keywordQuery.lte('importance_score', maxImportance);

        if (onThisDay) {
          const now = new Date();
          const month = now.getMonth() + 1;
          const day = now.getDate();
          keywordQuery = keywordQuery
            .filter('created_at', 'gte', `1900-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`)
            .filter('created_at', 'lte', `2100-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`);
        } else if (startDate || endDate) {
          if (startDate) keywordQuery = keywordQuery.gte('created_at', startDate);
          if (endDate) keywordQuery = keywordQuery.lte('created_at', endDate);
        }

        const { data: keywordResults, error: keywordError } = await keywordQuery
          .order('created_at', { ascending: false })
          .limit(200);

        if (keywordError) throw keywordError;
        
        // Apply length filters in JavaScript
        let filteredResults = keywordResults;
        if (minLength || maxLength) {
          filteredResults = keywordResults?.filter((msg: any) => {
            if (minLength && msg.content.length < minLength) return false;
            if (maxLength && msg.content.length > maxLength) return false;
            return true;
          });
        }
        
        messages = filteredResults?.slice(0, 50);
      }
    } else {
      // Standard keyword search with advanced filters
      let keywordQuery = supabaseClient
        .from('messages')
        .select('*, conversations!inner(title)')
        .eq('user_id', userId)
        .or(`content.ilike.%${query}%,topic.ilike.%${query}%`);

      // Apply advanced filters
      if (provider) keywordQuery = keywordQuery.eq('provider', provider);
      if (model) keywordQuery = keywordQuery.eq('model_used', model);
      if (minImportance !== undefined) keywordQuery = keywordQuery.gte('importance_score', minImportance);
      if (maxImportance !== undefined) keywordQuery = keywordQuery.lte('importance_score', maxImportance);

      if (onThisDay) {
        const now = new Date();
        const month = now.getMonth() + 1;
        const day = now.getDate();
        keywordQuery = keywordQuery
          .filter('created_at', 'gte', `1900-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`)
          .filter('created_at', 'lte', `2100-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`);
      } else if (startDate || endDate) {
        if (startDate) keywordQuery = keywordQuery.gte('created_at', startDate);
        if (endDate) keywordQuery = keywordQuery.lte('created_at', endDate);
      }

      const { data: keywordResults, error: keywordError } = await keywordQuery
        .order('created_at', { ascending: false })
        .limit(200);

      if (keywordError) throw keywordError;
      
      // Apply length filters in JavaScript
      let filteredResults = keywordResults;
      if (minLength || maxLength) {
        filteredResults = keywordResults?.filter((msg: any) => {
          if (minLength && msg.content.length < minLength) return false;
          if (maxLength && msg.content.length > maxLength) return false;
          return true;
        });
      }
      
      messages = filteredResults?.slice(0, 50);
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
          earliest_message: msg.created_at,
          latest_message: msg.created_at,
        };
      }
      groupedResults[convId].messages.push({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        topic: msg.topic,
        created_at: msg.created_at,
        similarity: msg.similarity || undefined,
        provider: msg.provider,
        model_used: msg.model_used,
      });
      
      // Track conversation duration
      const msgTime = new Date(msg.created_at).getTime();
      const earliest = new Date(groupedResults[convId].earliest_message).getTime();
      const latest = new Date(groupedResults[convId].latest_message).getTime();
      if (msgTime < earliest) groupedResults[convId].earliest_message = msg.created_at;
      if (msgTime > latest) groupedResults[convId].latest_message = msg.created_at;
    });

    let results = Object.values(groupedResults);

    // Apply conversation duration filter
    if (minDuration || maxDuration) {
      results = results.filter((conv: any) => {
        const durationMs = new Date(conv.latest_message).getTime() - new Date(conv.earliest_message).getTime();
        const durationMinutes = durationMs / (1000 * 60);
        
        if (minDuration && durationMinutes < minDuration) return false;
        if (maxDuration && durationMinutes > maxDuration) return false;
        return true;
      });
    }

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
