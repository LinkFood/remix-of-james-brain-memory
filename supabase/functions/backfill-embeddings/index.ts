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
    const { userId, batchSize = 50 } = await req.json();

    if (!userId) {
      throw new Error('User ID is required');
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Fetch messages without embeddings
    const { data: messages, error: fetchError } = await supabaseClient
      .from('messages')
      .select('id, content')
      .eq('user_id', userId)
      .is('embedding', null)
      .limit(batchSize);

    if (fetchError) {
      console.error('Error fetching messages:', fetchError);
      throw fetchError;
    }

    if (!messages || messages.length === 0) {
      return new Response(
        JSON.stringify({ 
          message: 'No messages to process',
          processed: 0,
          total: 0
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    let processed = 0;
    let failed = 0;

    // Process messages in smaller batches to avoid rate limits
    const smallBatchSize = 10;
    for (let i = 0; i < messages.length; i += smallBatchSize) {
      const batch = messages.slice(i, i + smallBatchSize);
      
      await Promise.all(
        batch.map(async (msg) => {
          try {
            // Generate embedding
            const embeddingResponse = await fetch(
              `${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-embedding`,
              {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ text: msg.content }),
              }
            );

            if (!embeddingResponse.ok) {
              console.error(`Failed to generate embedding for message ${msg.id}`);
              failed++;
              return;
            }

            const embeddingData = await embeddingResponse.json();
            const embedding = JSON.stringify(embeddingData.embedding);

            // Update message with embedding
            const { error: updateError } = await supabaseClient
              .from('messages')
              .update({ embedding })
              .eq('id', msg.id);

            if (updateError) {
              console.error(`Failed to update message ${msg.id}:`, updateError);
              failed++;
            } else {
              processed++;
            }
          } catch (err) {
            console.error(`Error processing message ${msg.id}:`, err);
            failed++;
          }
        })
      );

      // Small delay between batches to avoid rate limits
      if (i + smallBatchSize < messages.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Check if there are more messages to process
    const { count: remainingCount } = await supabaseClient
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('embedding', null);

    return new Response(
      JSON.stringify({
        message: `Processed ${processed} messages successfully, ${failed} failed`,
        processed,
        failed,
        remaining: remainingCount || 0,
        hasMore: (remainingCount || 0) > 0,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in backfill-embeddings function:', error);
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
