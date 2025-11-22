import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { messageId, content, role } = await req.json();

    if (!messageId && !content) {
      return new Response(
        JSON.stringify({ error: 'Either messageId or content is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY')!;
    
    const supabase = createClient(supabaseUrl, supabaseKey);

    let messageContent = content;
    let messageRole = role;

    // If messageId provided, fetch the message
    if (messageId) {
      const { data: message, error: fetchError } = await supabase
        .from('messages')
        .select('content, role')
        .eq('id', messageId)
        .single();

      if (fetchError) {
        console.error('Error fetching message:', fetchError);
        return new Response(
          JSON.stringify({ error: 'Message not found' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      messageContent = message.content;
      messageRole = message.role;
    }

    // Call Lovable AI to calculate importance score
    const systemPrompt = `You are an AI that analyzes message importance. Rate the importance of messages on a scale of 0-10 where:
0-2: Trivial (greetings, acknowledgments, casual chat)
3-4: Low importance (general questions, simple requests)
5-6: Medium importance (specific information, standard tasks)
7-8: High importance (decisions, commitments, critical information)
9-10: Critical (urgent matters, major decisions, key insights)

Consider:
- Actionability: Does it require action?
- Information value: Does it contain important facts or decisions?
- Context: Is it a standalone message or part of a conversation?
- Urgency: Is it time-sensitive?
- Impact: What are the consequences?`;

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyze this ${messageRole} message and rate its importance:\n\n"${messageContent}"` }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'rate_importance',
              description: 'Rate the importance of a message',
              parameters: {
                type: 'object',
                properties: {
                  score: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 10,
                    description: 'Importance score from 0 (trivial) to 10 (critical)'
                  },
                  reasoning: {
                    type: 'string',
                    description: 'Brief explanation of why this score was assigned'
                  }
                },
                required: ['score', 'reasoning'],
                additionalProperties: false
              }
            }
          }
        ],
        tool_choice: { type: 'function', function: { name: 'rate_importance' } }
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Lovable AI error:', response.status, errorText);
      
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: 'AI credits exhausted. Please add credits to your workspace.' }),
          { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`AI request failed: ${response.status}`);
    }

    const aiResponse = await response.json();
    console.log('AI Response:', JSON.stringify(aiResponse, null, 2));

    // Extract the importance score from tool call
    const toolCall = aiResponse.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      throw new Error('No tool call in AI response');
    }

    const result = JSON.parse(toolCall.function.arguments);
    const importanceScore = result.score;
    const reasoning = result.reasoning;

    console.log(`Calculated importance: ${importanceScore}/10 - ${reasoning}`);

    // Update the message with the importance score if messageId provided
    if (messageId) {
      const { error: updateError } = await supabase
        .from('messages')
        .update({ importance_score: importanceScore })
        .eq('id', messageId);

      if (updateError) {
        console.error('Error updating message:', updateError);
        throw updateError;
      }
    }

    return new Response(
      JSON.stringify({ 
        importance_score: importanceScore,
        reasoning,
        success: true 
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in calculate-importance function:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error occurred' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
