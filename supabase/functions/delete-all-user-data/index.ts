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
      return new Response(
        JSON.stringify({ error: 'userId is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Starting deletion of all data for user: ${userId}`);

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Delete entries (main brain dump content)
    const { error: entriesError, count: entriesCount } = await supabaseClient
      .from('entries')
      .delete({ count: 'exact' })
      .eq('user_id', userId);

    if (entriesError) {
      console.error('Error deleting entries:', entriesError);
      throw entriesError;
    }
    console.log(`Deleted ${entriesCount ?? 0} entries`);

    // Delete brain reports
    const { error: reportsError, count: reportsCount } = await supabaseClient
      .from('brain_reports')
      .delete({ count: 'exact' })
      .eq('user_id', userId);

    if (reportsError) {
      console.error('Error deleting brain_reports:', reportsError);
      throw reportsError;
    }
    console.log(`Deleted ${reportsCount ?? 0} brain reports`);

    console.log(`Successfully deleted all data for user: ${userId}`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        deleted: {
          entries: entriesCount ?? 0,
          brain_reports: reportsCount ?? 0
        }
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in delete-all-user-data:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
