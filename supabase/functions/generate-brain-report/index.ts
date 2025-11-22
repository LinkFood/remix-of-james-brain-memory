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
    const { userId, reportType, startDate, endDate } = await req.json();

    if (!userId || !reportType || !startDate || !endDate) {
      throw new Error('Missing required fields');
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Fetch messages in the date range
    const { data: messages, error: messagesError } = await supabaseClient
      .from('messages')
      .select('id, content, role, created_at, topic, conversation_id')
      .eq('user_id', userId)
      .gte('created_at', startDate)
      .lte('created_at', endDate)
      .order('created_at', { ascending: true });

    if (messagesError) throw messagesError;

    if (!messages || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No messages found in this date range' }),
        {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Fetch conversation titles
    const conversationIds = [...new Set(messages.map(m => m.conversation_id))];
    const { data: conversations } = await supabaseClient
      .from('conversations')
      .select('id, title')
      .in('id', conversationIds);

    const convMap = new Map(conversations?.map(c => [c.id, c.title]) || []);

    // Prepare context for AI
    const userMessages = messages.filter(m => m.role === 'user');
    const assistantMessages = messages.filter(m => m.role === 'assistant');
    const conversationCount = conversationIds.length;

    // Build a summary of conversations
    const conversationSummaries = conversationIds.slice(0, 20).map(convId => {
      const convMessages = messages.filter(m => m.conversation_id === convId);
      const title = convMap.get(convId) || 'Untitled';
      const preview = convMessages.slice(0, 3).map(m => 
        `${m.role}: ${m.content.substring(0, 150)}...`
      ).join('\n');
      return `Conversation: "${title}"\n${preview}`;
    }).join('\n\n');

    const reportPeriod = reportType === 'daily' ? 'day' : 
                        reportType === 'weekly' ? 'week' : 'month';

    // Call Lovable AI to generate the report
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY is not configured');
    }

    const systemPrompt = `You are an AI analyst that generates insightful brain reports from conversation data. 
Analyze the conversations and extract:
1. A concise summary (2-3 sentences) of the overall activity
2. 3-5 key themes or topics discussed
3. Important decisions or action items identified
4. 2-4 meaningful insights or patterns observed

Be specific and actionable. Focus on what's most valuable to remember from this time period.`;

    const userPrompt = `Analyze these conversations from ${new Date(startDate).toLocaleDateString()} to ${new Date(endDate).toLocaleDateString()}:

Statistics:
- Total messages: ${messages.length}
- User messages: ${userMessages.length}
- Assistant responses: ${assistantMessages.length}
- Conversations: ${conversationCount}

Sample conversations:
${conversationSummaries}

Generate a ${reportType} brain report with key themes, decisions, and insights.`;

    const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'generate_brain_report',
              description: 'Generate a structured brain report from conversation analysis',
              parameters: {
                type: 'object',
                properties: {
                  summary: {
                    type: 'string',
                    description: 'A 2-3 sentence summary of the overall activity'
                  },
                  key_themes: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        theme: { type: 'string' },
                        description: { type: 'string' },
                        frequency: { type: 'string' }
                      },
                      required: ['theme', 'description']
                    },
                    description: '3-5 key themes or topics discussed'
                  },
                  decisions: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        decision: { type: 'string' },
                        context: { type: 'string' },
                        date: { type: 'string' }
                      },
                      required: ['decision', 'context']
                    },
                    description: 'Important decisions or action items'
                  },
                  insights: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        insight: { type: 'string' },
                        significance: { type: 'string' }
                      },
                      required: ['insight', 'significance']
                    },
                    description: '2-4 meaningful insights or patterns'
                  }
                },
                required: ['summary', 'key_themes', 'decisions', 'insights']
              }
            }
          }
        ],
        tool_choice: { type: 'function', function: { name: 'generate_brain_report' } }
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error('Lovable AI error:', aiResponse.status, errorText);
      
      if (aiResponse.status === 429) {
        throw new Error('Rate limit exceeded. Please try again later.');
      }
      if (aiResponse.status === 402) {
        throw new Error('AI credits exhausted. Please add credits to continue.');
      }
      
      throw new Error('Failed to generate report with AI');
    }

    const aiData = await aiResponse.json();
    const toolCall = aiData.choices[0]?.message?.tool_calls?.[0];
    
    if (!toolCall) {
      throw new Error('No structured report generated');
    }

    const reportData = JSON.parse(toolCall.function.arguments);

    // Calculate conversation stats
    const stats = {
      total_messages: messages.length,
      user_messages: userMessages.length,
      assistant_messages: assistantMessages.length,
      conversations: conversationCount,
      avg_messages_per_conversation: (messages.length / conversationCount).toFixed(1)
    };

    // Save the report to the database
    const { data: savedReport, error: saveError } = await supabaseClient
      .from('brain_reports')
      .insert({
        user_id: userId,
        report_type: reportType,
        start_date: startDate,
        end_date: endDate,
        summary: reportData.summary,
        key_themes: reportData.key_themes,
        decisions: reportData.decisions,
        insights: reportData.insights,
        conversation_stats: stats
      })
      .select()
      .single();

    if (saveError) throw saveError;

    console.log(`Generated ${reportType} report for user ${userId}`);

    return new Response(
      JSON.stringify({ 
        report: savedReport,
        message: 'Brain report generated successfully' 
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in generate-brain-report function:', error);
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
