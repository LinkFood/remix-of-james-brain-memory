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
    // Extract userId from JWT instead of request body
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Authorization required' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const token = authHeader.replace('Bearer ', '');
    const { data: claimsData, error: claimsError } = await supabaseClient.auth.getClaims(token);

    if (claimsError || !claimsData?.claims) {
      console.error('Auth error:', claimsError);
      return new Response(
        JSON.stringify({ error: 'Invalid token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userId = claimsData.claims.sub;
    if (!userId) {
      return new Response(
        JSON.stringify({ error: 'User ID not found in token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Parse other params from request body (userId is ignored if provided)
    const { reportType = 'weekly', startDate, endDate } = await req.json().catch(() => ({}));

    console.log(`Generating ${reportType} report for user: ${userId}`);

    // Use service role for data access
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Calculate date range
    const now = new Date();
    let reportStartDate: Date;
    let reportEndDate = endDate ? new Date(endDate) : now;

    if (startDate) {
      reportStartDate = new Date(startDate);
    } else {
      switch (reportType) {
        case 'daily':
          reportStartDate = new Date(now.setHours(0, 0, 0, 0));
          break;
        case 'monthly':
          reportStartDate = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case 'weekly':
        default:
          reportStartDate = new Date(now.setDate(now.getDate() - 7));
          break;
      }
    }

    // Fetch entries within date range
    const { data: entries, error: entriesError } = await serviceClient
      .from('entries')
      .select('id, content, title, content_type, content_subtype, tags, importance_score, starred, created_at')
      .eq('user_id', userId)
      .eq('archived', false)
      .gte('created_at', reportStartDate.toISOString())
      .lte('created_at', reportEndDate.toISOString())
      .order('created_at', { ascending: false });

    if (entriesError) {
      console.error('Error fetching entries:', entriesError);
      throw entriesError;
    }

    if (!entries || entries.length === 0) {
      return new Response(
        JSON.stringify({ 
          error: 'No entries found in the specified date range',
          startDate: reportStartDate.toISOString(),
          endDate: reportEndDate.toISOString()
        }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Found ${entries.length} entries for report`);

    // Calculate stats
    const stats = {
      totalEntries: entries.length,
      starredCount: entries.filter(e => e.starred).length,
      contentTypes: entries.reduce((acc, e) => {
        acc[e.content_type] = (acc[e.content_type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      topTags: getTopTags(entries),
      avgImportance: entries.reduce((sum, e) => sum + (e.importance_score || 0), 0) / entries.length,
      highPriorityCount: entries.filter(e => (e.importance_score || 0) >= 8).length
    };

    // Generate AI summary using Lovable API
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
    if (!lovableApiKey) {
      throw new Error('LOVABLE_API_KEY not configured');
    }

    const entrySummaries = entries.slice(0, 20).map(e => 
      `[${e.content_type}${e.importance_score ? ` importance:${e.importance_score}` : ''}] ${e.title || 'Untitled'}: ${e.content.substring(0, 200)}...`
    ).join('\n');

    const prompt = `Analyze this user's brain dump entries from the past ${reportType === 'daily' ? 'day' : reportType === 'monthly' ? 'month' : 'week'} and generate a structured report.

Stats:
- Total entries: ${stats.totalEntries}
- High priority (8+): ${stats.highPriorityCount}
- Average importance: ${stats.avgImportance.toFixed(1)}
- Content types: ${Object.entries(stats.contentTypes).map(([k, v]) => `${k}: ${v}`).join(', ')}
- Top tags: ${stats.topTags.join(', ')}

Sample entries:
${entrySummaries}

Generate a report with:
1. A 2-3 sentence executive summary
2. 3-5 key themes or patterns
3. 2-3 notable decisions or commitments mentioned
4. 2-3 actionable insights or recommendations`;

    const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-5-mini',
        messages: [
          { role: 'system', content: 'You are an AI analyst helping users understand patterns in their brain dump entries. Be concise, insightful, and actionable.' },
          { role: 'user', content: prompt }
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'create_brain_report',
            description: 'Create a structured brain report',
            parameters: {
              type: 'object',
              properties: {
                summary: { type: 'string', description: '2-3 sentence executive summary' },
                key_themes: { 
                  type: 'array', 
                  items: { type: 'string' },
                  description: '3-5 key themes or patterns observed'
                },
                decisions: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '2-3 notable decisions or commitments'
                },
                insights: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '2-3 actionable insights or recommendations'
                }
              },
              required: ['summary', 'key_themes', 'decisions', 'insights']
            }
          }
        }],
        tool_choice: { type: 'function', function: { name: 'create_brain_report' } }
      })
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error('AI API error:', errorText);
      throw new Error(`AI API error: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    console.log('AI response received');

    // Extract structured data from tool call
    let reportData = {
      summary: 'Report generation in progress...',
      key_themes: [] as string[],
      decisions: [] as string[],
      insights: [] as string[]
    };

    if (aiData.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments) {
      try {
        reportData = JSON.parse(aiData.choices[0].message.tool_calls[0].function.arguments);
      } catch (parseError) {
        console.error('Error parsing AI response:', parseError);
      }
    } else if (aiData.choices?.[0]?.message?.content) {
      reportData.summary = aiData.choices[0].message.content;
    }

    // Save report to database
    const { data: savedReport, error: saveError } = await serviceClient
      .from('brain_reports')
      .insert({
        user_id: userId,
        report_type: reportType,
        start_date: reportStartDate.toISOString(),
        end_date: reportEndDate.toISOString(),
        summary: reportData.summary,
        key_themes: reportData.key_themes,
        decisions: reportData.decisions,
        insights: reportData.insights,
        conversation_stats: stats
      })
      .select()
      .single();

    if (saveError) {
      console.error('Error saving report:', saveError);
      throw saveError;
    }

    console.log(`Report saved with ID: ${savedReport.id}`);

    return new Response(
      JSON.stringify({ success: true, report: savedReport }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in generate-brain-report:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function getTopTags(entries: any[]): string[] {
  const tagCounts: Record<string, number> = {};
  for (const entry of entries) {
    for (const tag of (entry.tags || [])) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }
  return Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);
}