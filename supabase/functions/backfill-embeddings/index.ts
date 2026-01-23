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

    console.log(`Starting backfill for user ${userId}, batch size: ${batchSize}`);

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Fetch entries without embeddings
    const { data: entries, error: fetchError } = await supabaseClient
      .from('entries')
      .select('id, content')
      .eq('user_id', userId)
      .is('embedding', null)
      .eq('archived', false)
      .limit(batchSize);

    if (fetchError) {
      console.error('Error fetching entries:', fetchError);
      throw fetchError;
    }

    if (!entries || entries.length === 0) {
      console.log('No entries to process');
      return new Response(
        JSON.stringify({ 
          message: 'No entries to process',
          processed: 0,
          failed: 0,
          remaining: 0,
          hasMore: false
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    console.log(`Found ${entries.length} entries to process`);

    let processed = 0;
    let failed = 0;

    // Process entries in smaller batches to avoid rate limits
    const smallBatchSize = 10;
    for (let i = 0; i < entries.length; i += smallBatchSize) {
      const batch = entries.slice(i, i + smallBatchSize);
      
      await Promise.all(
        batch.map(async (entry) => {
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
                body: JSON.stringify({ text: entry.content }),
              }
            );

            if (!embeddingResponse.ok) {
              console.error(`Failed to generate embedding for entry ${entry.id}`);
              failed++;
              return;
            }

            const embeddingData = await embeddingResponse.json();
            // Format as Postgres vector literal
            const embedding = `[${embeddingData.embedding.join(',')}]`;

            // Update entry with embedding
            const { error: updateError } = await supabaseClient
              .from('entries')
              .update({ embedding })
              .eq('id', entry.id);

            if (updateError) {
              console.error(`Failed to update entry ${entry.id}:`, updateError);
              failed++;
            } else {
              processed++;
              console.log(`Processed entry ${entry.id}`);
            }
          } catch (err) {
            console.error(`Error processing entry ${entry.id}:`, err);
            failed++;
          }
        })
      );

      // Small delay between batches to avoid rate limits
      if (i + smallBatchSize < entries.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Check if there are more entries to process
    const { count: remainingCount } = await supabaseClient
      .from('entries')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('embedding', null)
      .eq('archived', false);

    console.log(`Completed: ${processed} processed, ${failed} failed, ${remainingCount || 0} remaining`);

    return new Response(
      JSON.stringify({
        message: `Processed ${processed} entries successfully, ${failed} failed`,
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
