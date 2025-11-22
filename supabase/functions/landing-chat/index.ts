import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { message, conversationHistory = [] } = await req.json();

    if (!message) {
      throw new Error('Message is required');
    }

    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY is not configured');
    }

    const systemPrompt = `You are the AI assistant for James Brain OS - a universal AI memory system.

WHAT IT IS:
- A memory layer that sits between users and their LLMs (OpenAI, Claude, Google)
- Captures, stores, and injects relevant context into future conversations
- Users bring their own API keys, we provide the memory infrastructure

KEY DIFFERENTIATORS:
- User data sovereignty: Users own, export, delete their data anytime
- Cross-provider portability: Switch between LLMs, memory travels with you
- Compounding intelligence: Every conversation makes future ones smarter
- Radical transparency: Users see exactly what memories are injected

HOW IT WORKS:
1. User connects their API key (OpenAI/Claude/Google)
2. We capture every conversation and score it for importance
3. We inject relevant memories from past conversations automatically
4. Context compounds over time - AI remembers everything

PRICING:
Free tier: 100 messages/month
Pro: $20/month unlimited messages
Enterprise: Custom pricing for teams

SUPPORTED PROVIDERS:
| Provider   | Models Available        | Best For              |
|-----------|-------------------------|----------------------|
| OpenAI    | GPT-4, GPT-3.5         | General intelligence |
| Anthropic | Claude 3.5, Claude 3   | Long context, safety |
| Google    | Gemini Pro, Flash      | Speed, multimodal    |

FEATURES:
- Semantic search across all conversations
- Importance scoring (0-100 scale)
- Memory injection with context windows
- Export data anytime (JSON, CSV)
- Delete all data with one click
- Cross-device sync
- API access for integrations

NOT A CHATBOT: We're infrastructure. Users bring the AI, we bring the memory.

YOUR ROLE:
- Answer questions about the product concisely and professionally
- Use structured tables when comparing features or pricing
- Explain technical details when asked
- Guide users to sign up when appropriate
- Be smart, institutional, no fluff (hedge fund aesthetic)
- When users want to actually USE the product, tell them: "Create an account to start building your AI memory"

TONE: Professional, confident, data-driven. Think Bloomberg Terminal, not consumer chatbot.
NO EMOJIS EVER.

When asked about pricing or features, format responses with clear structure using markdown tables.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
      { role: 'user', content: message }
    ];

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages,
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limits exceeded. Please try again in a moment." }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Service temporarily unavailable." }), {
          status: 402,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const errorText = await response.text();
      console.error('Lovable AI error:', response.status, errorText);
      throw new Error(`AI gateway error: ${response.status}`);
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, 'Content-Type': 'text/event-stream' },
    });
  } catch (error) {
    console.error('Error in landing-chat function:', error);
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
