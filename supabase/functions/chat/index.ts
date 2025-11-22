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
    const { message, conversationId, userId } = await req.json();

    if (!message || !conversationId || !userId) {
      throw new Error('Missing required fields');
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Fetch user's API key
    const { data: apiKeyData, error: keyError } = await supabaseClient
      .from('user_api_keys')
      .select('provider, encrypted_key')
      .eq('user_id', userId)
      .eq('is_default', true)
      .single();

    if (keyError || !apiKeyData) {
      throw new Error('No API key configured. Please add one in Settings.');
    }

    const { provider, encrypted_key } = apiKeyData;

    // Store user message
    const { error: userMsgError } = await supabaseClient
      .from('messages')
      .insert({
        conversation_id: conversationId,
        user_id: userId,
        role: 'user',
        content: message,
        topic: await detectTopic(message),
        provider,
      });

    if (userMsgError) {
      console.error('Error storing user message:', userMsgError);
      throw userMsgError;
    }

    // Call appropriate LLM API based on provider
    let assistantResponse: string;
    let model_used: string;
    
    if (provider === 'openai') {
      const result = await callOpenAI(encrypted_key, message);
      assistantResponse = result.response;
      model_used = result.model;
    } else if (provider === 'anthropic') {
      const result = await callAnthropic(encrypted_key, message);
      assistantResponse = result.response;
      model_used = result.model;
    } else if (provider === 'google') {
      const result = await callGoogle(encrypted_key, message);
      assistantResponse = result.response;
      model_used = result.model;
    } else {
      throw new Error('Unsupported provider');
    }

    // Store assistant message
    const { error: assistantMsgError } = await supabaseClient
      .from('messages')
      .insert({
        conversation_id: conversationId,
        user_id: userId,
        role: 'assistant',
        content: assistantResponse,
        topic: await detectTopic(assistantResponse),
        provider,
        model_used,
      });

    if (assistantMsgError) {
      console.error('Error storing assistant message:', assistantMsgError);
      throw assistantMsgError;
    }

    return new Response(
      JSON.stringify({ response: assistantResponse }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in chat function:', error);
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

async function callOpenAI(apiKey: string, message: string) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a helpful AI assistant.' },
        { role: 'user', content: message }
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('OpenAI error:', response.status, errorText);
    throw new Error('OpenAI API error');
  }

  const data = await response.json();
  return {
    response: data.choices?.[0]?.message?.content || 'No response',
    model: data.model || 'gpt-4o-mini'
  };
}

async function callAnthropic(apiKey: string, message: string) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: message }
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Anthropic error:', response.status, errorText);
    throw new Error('Anthropic API error');
  }

  const data = await response.json();
  return {
    response: data.content?.[0]?.text || 'No response',
    model: data.model || 'claude-3-5-sonnet-20241022'
  };
}

async function callGoogle(apiKey: string, message: string) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: message }]
      }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Google error:', response.status, errorText);
    throw new Error('Google API error');
  }

  const data = await response.json();
  return {
    response: data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response',
    model: 'gemini-pro'
  };
}

async function detectTopic(text: string): Promise<string | null> {
  const topics = [
    'technology', 'business', 'health', 'education', 'entertainment',
    'science', 'sports', 'finance', 'travel', 'food'
  ];

  const lowerText = text.toLowerCase();
  for (const topic of topics) {
    if (lowerText.includes(topic)) {
      return topic;
    }
  }

  return 'general';
}
