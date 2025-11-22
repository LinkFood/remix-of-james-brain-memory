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
    const { userId } = await req.json();

    if (!userId) {
      throw new Error('Missing userId');
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    console.log(`Deleting all data for user: ${userId}`);

    // Delete in order (respecting foreign key constraints)
    // 1. Delete messages (references conversations)
    const { error: msgError } = await supabaseClient
      .from('messages')
      .delete()
      .eq('user_id', userId);

    if (msgError) {
      console.error('Error deleting messages:', msgError);
      throw msgError;
    }

    // 2. Delete brain reports
    const { error: repError } = await supabaseClient
      .from('brain_reports')
      .delete()
      .eq('user_id', userId);

    if (repError) {
      console.error('Error deleting brain reports:', repError);
      throw repError;
    }

    // 3. Delete conversations
    const { error: convError } = await supabaseClient
      .from('conversations')
      .delete()
      .eq('user_id', userId);

    if (convError) {
      console.error('Error deleting conversations:', convError);
      throw convError;
    }

    // 4. Delete API keys
    const { error: keyError } = await supabaseClient
      .from('user_api_keys')
      .delete()
      .eq('user_id', userId);

    if (keyError) {
      console.error('Error deleting API keys:', keyError);
      throw keyError;
    }

    console.log(`Successfully deleted all data for user: ${userId}`);

    return new Response(
      JSON.stringify({ 
        success: true,
        message: 'All data deleted successfully'
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in delete-all-user-data function:', error);
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
