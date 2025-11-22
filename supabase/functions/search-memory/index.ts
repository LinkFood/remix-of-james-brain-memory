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
    const { query, userId } = await req.json();

    if (!query || !userId) {
      throw new Error('Missing required fields');
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Search across all messages for the user
    const { data: messages, error } = await supabaseClient
      .from('messages')
      .select('*, conversations!inner(title)')
      .eq('user_id', userId)
      .or(`content.ilike.%${query}%,topic.ilike.%${query}%`)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('Error searching messages:', error);
      throw error;
    }

    // Group results by conversation
    const groupedResults: { [key: string]: any } = {};
    messages?.forEach((msg) => {
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
