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
    const { message, conversationId, userId, provider, model } = await req.json();

    if (!message || !conversationId || !userId) {
      throw new Error('Missing required fields');
    }

    const requestedProvider = provider || 'openai';
    const requestedModel = model || 'gpt-4o-mini';

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Fetch user's API key for the requested provider
    const { data: apiKeyData, error: keyError } = await supabaseClient
      .from('user_api_keys')
      .select('provider, encrypted_key')
      .eq('user_id', userId)
      .eq('provider', requestedProvider)
      .maybeSingle();

    if (keyError) {
      console.error('API key fetch error:', keyError);
      throw new Error('Failed to fetch API key');
    }

    if (!apiKeyData) {
      throw new Error(`No ${requestedProvider} API key found. Please add one in Settings.`);
    }

    const { encrypted_key } = apiKeyData;

    // Store user message with estimated token count and embedding
    const userTokens = estimateTokenCount(message);
    let userEmbedding = null;
    
    try {
      const embeddingResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-embedding`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: message }),
      });
      
      if (embeddingResponse.ok) {
        const embeddingData = await embeddingResponse.json();
        userEmbedding = JSON.stringify(embeddingData.embedding);
      } else {
        console.warn('Failed to generate user message embedding');
      }
    } catch (embErr) {
      console.warn('Error generating user message embedding:', embErr);
    }

    const { data: userMessage, error: userMsgError } = await supabaseClient
      .from('messages')
      .insert({
        conversation_id: conversationId,
        user_id: userId,
        role: 'user',
        content: message,
        topic: await detectTopic(message),
        provider: requestedProvider,
        token_count: userTokens,
        embedding: userEmbedding,
      })
      .select()
      .single();

    if (userMsgError) {
      console.error('Error storing user message:', userMsgError);
      throw userMsgError;
    }

    // Score user message importance in background (fire and forget)
    if (userMessage?.id) {
      fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/calculate-importance`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messageId: userMessage.id }),
      }).catch(err => console.error('Error scoring user message:', err));
    }

    // Search for relevant memories to inject as context
    let relevantMemories: any[] = [];
    let systemContext = '';
    
    try {
      const searchResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/search-memory`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: message,
          userId: userId,
          useSemanticSearch: true,
          minImportance: 7, // Only high-importance memories
        })
      });

      if (searchResponse.ok) {
        const searchData = await searchResponse.json();
        relevantMemories = (searchData.results || []).slice(0, 3); // Top 3 memories
        
        if (relevantMemories.length > 0) {
          systemContext = `\n\nRelevant past conversations:\n${
            relevantMemories.map((result, i) => {
              const firstMsg = result.messages?.[0];
              if (firstMsg) {
                return `[Memory ${i+1}] ${firstMsg.content.substring(0, 200)}... (${(result.similarity * 100).toFixed(0)}% match, importance: ${firstMsg.importance_score || 'N/A'})`;
              }
              return '';
            }).filter(Boolean).join('\n')
          }\n\nUse these past conversations to provide more contextual and personalized responses.\n`;
          
          console.log(`Injecting ${relevantMemories.length} memories as context`);
        }
      } else {
        console.warn('Memory search failed, continuing without context');
      }
    } catch (memErr) {
      console.warn('Error searching memories:', memErr);
    }

    // Call appropriate LLM API based on provider
    let assistantResponse: string;
    let model_used: string;
    
    try {
      if (requestedProvider === 'openai') {
        const result = await callOpenAI(encrypted_key, message, requestedModel, systemContext);
        assistantResponse = result.response;
        model_used = result.model;
      } else if (requestedProvider === 'anthropic') {
        const result = await callAnthropic(encrypted_key, message, requestedModel, systemContext);
        assistantResponse = result.response;
        model_used = result.model;
      } else if (requestedProvider === 'google') {
        const result = await callGoogle(encrypted_key, message, requestedModel, systemContext);
        assistantResponse = result.response;
        model_used = result.model;
      } else {
        throw new Error(`Unsupported provider: ${requestedProvider}`);
      }
    } catch (apiError: any) {
      console.error(`${requestedProvider} API error:`, apiError);
      
      const errorMsg = apiError.message?.toLowerCase() || '';
      if (errorMsg.includes('rate_limit') || errorMsg.includes('rate limit')) {
        throw new Error('Rate limit exceeded. Please try again later.');
      } else if (errorMsg.includes('quota') || errorMsg.includes('insufficient')) {
        throw new Error('API quota exceeded. Please check your billing.');
      } else if (errorMsg.includes('invalid') || errorMsg.includes('authentication') || errorMsg.includes('unauthorized')) {
        throw new Error('Invalid API key. Please check your settings.');
      }
      
      throw new Error(`Failed to get response: ${apiError.message || 'Unknown error'}`);
    }

    // Store assistant message with estimated token count and embedding
    const assistantTokens = estimateTokenCount(assistantResponse);
    let assistantEmbedding = null;
    
    try {
      const embeddingResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-embedding`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: assistantResponse }),
      });
      
      if (embeddingResponse.ok) {
        const embeddingData = await embeddingResponse.json();
        assistantEmbedding = JSON.stringify(embeddingData.embedding);
      } else {
        console.warn('Failed to generate assistant message embedding');
      }
    } catch (embErr) {
      console.warn('Error generating assistant message embedding:', embErr);
    }

    const { data: assistantMessage, error: assistantMsgError } = await supabaseClient
      .from('messages')
      .insert({
        conversation_id: conversationId,
        user_id: userId,
        role: 'assistant',
        content: assistantResponse,
        topic: await detectTopic(assistantResponse),
        provider: requestedProvider,
        model_used,
        token_count: assistantTokens,
        embedding: assistantEmbedding,
      })
      .select()
      .single();

    if (assistantMsgError) {
      console.error('Error storing assistant message:', assistantMsgError);
      throw assistantMsgError;
    }

    // Score assistant message importance in background (fire and forget)
    if (assistantMessage?.id) {
      fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/calculate-importance`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messageId: assistantMessage.id }),
      }).catch(err => console.error('Error scoring assistant message:', err));
    }

    // Return response with memory metadata
    return new Response(
      JSON.stringify({ 
        response: assistantResponse,
        memoriesUsed: relevantMemories.length,
        memories: relevantMemories.map(result => ({
          snippet: result.messages?.[0]?.content.substring(0, 100) || '',
          similarity: result.similarity,
          importance: result.messages?.[0]?.importance_score || null,
          created_at: result.messages?.[0]?.created_at || null,
        }))
      }),
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

async function callOpenAI(apiKey: string, message: string, model: string = 'gpt-4o-mini', systemContext: string = '') {
  const systemPrompt = 'You are a helpful AI assistant.' + systemContext;
  
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('OpenAI error:', response.status, errorText);
    
    let errorData;
    try {
      errorData = JSON.parse(errorText);
    } catch {}
    
    if (response.status === 429) {
      throw new Error('Rate limit exceeded');
    } else if (response.status === 401) {
      throw new Error('Invalid API key');
    } else if (errorData?.error?.message) {
      throw new Error(errorData.error.message);
    }
    
    throw new Error('OpenAI API error');
  }

  const data = await response.json();
  return {
    response: data.choices?.[0]?.message?.content || 'No response',
    model: data.model || model
  };
}

async function callAnthropic(apiKey: string, message: string, model: string = 'claude-3-5-sonnet-20241022', systemContext: string = '') {
  const systemPrompt = 'You are a helpful AI assistant.' + systemContext;
  
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        { role: 'user', content: message }
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Anthropic error:', response.status, errorText);
    
    let errorData;
    try {
      errorData = JSON.parse(errorText);
    } catch {}
    
    if (response.status === 429) {
      throw new Error('Rate limit exceeded');
    } else if (response.status === 401) {
      throw new Error('Invalid API key');
    } else if (errorData?.error?.message) {
      throw new Error(errorData.error.message);
    }
    
    throw new Error('Anthropic API error');
  }

  const data = await response.json();
  return {
    response: data.content?.[0]?.text || 'No response',
    model: data.model || model
  };
}

async function callGoogle(apiKey: string, message: string, model: string = 'gemini-pro', systemContext: string = '') {
  const systemPrompt = 'You are a helpful AI assistant.' + systemContext;
  const augmentedMessage = systemPrompt + '\n\nUser: ' + message;
  
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: augmentedMessage }]
      }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Google error:', response.status, errorText);
    
    let errorData;
    try {
      errorData = JSON.parse(errorText);
    } catch {}
    
    if (response.status === 429) {
      throw new Error('Rate limit exceeded');
    } else if (response.status === 403 || response.status === 401) {
      throw new Error('Invalid API key');
    } else if (errorData?.error?.message) {
      throw new Error(errorData.error.message);
    }
    
    throw new Error('Google API error');
  }

  const data = await response.json();
  return {
    response: data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response',
    model: model
  };
}

function estimateTokenCount(text: string): number {
  // Rough estimate: ~4 characters per token on average
  // This is a simplified estimation; real tokenization varies by model
  return Math.ceil(text.length / 4);
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
