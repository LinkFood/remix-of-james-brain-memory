import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ClassificationResult {
  type: 'code' | 'list' | 'idea' | 'link' | 'contact' | 'event' | 'reminder' | 'note';
  subtype?: string;
  suggestedTitle: string;
  tags: string[];
  extractedData: Record<string, unknown>;
  appendTo?: string;
  listItems?: Array<{ text: string; checked: boolean }>;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { content, userId } = await req.json();

    if (!content) {
      return new Response(
        JSON.stringify({ error: 'Content is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY')!;

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch recent entries for context (to detect append opportunities)
    let recentEntries: Array<{ id: string; title: string; content_type: string; content: string }> = [];
    if (userId) {
      const { data } = await supabase
        .from('entries')
        .select('id, title, content_type, content')
        .eq('user_id', userId)
        .eq('archived', false)
        .in('content_type', ['list'])
        .order('updated_at', { ascending: false })
        .limit(10);

      recentEntries = data || [];
    }

    const recentListsContext = recentEntries.length > 0
      ? `\n\nExisting lists the user has (consider appending to these if content matches):\n${recentEntries.map(e => `- ID: ${e.id}, Title: "${e.title || 'Untitled'}", Type: ${e.content_type}`).join('\n')}`
      : '';

    const systemPrompt = `You are a content classifier for a "brain dump" app. Users paste anything - code, lists, ideas, links, notes - and you classify it.

Analyze the content and determine:
1. TYPE: code | list | idea | link | contact | event | reminder | note
2. SUBTYPE (optional): For lists: grocery, todo, shopping, reading, etc. For code: javascript, python, etc.
3. SUGGESTED TITLE: A short, descriptive title (max 60 chars)
4. TAGS: Relevant tags for categorization (max 5)
5. EXTRACTED DATA: Structured data based on type
6. APPEND TO: If content should be added to an existing entry, provide the ID
7. LIST ITEMS: If it's a list, extract individual items

Guidelines:
- CODE: Contains programming syntax, functions, variables, imports
- LIST: Multiple items, bullet points, numbered items, shopping items
- IDEA: Concepts, brainstorms, "what if", feature ideas
- LINK: URLs, website references
- CONTACT: Names with phone/email/address
- EVENT: Dates, meetings, appointments
- REMINDER: Tasks with "tomorrow", "remember to", deadlines
- NOTE: Everything else - random thoughts, information

For lists, extract each item as a separate list_item with checked: false.
${recentListsContext}`;

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
          { role: 'user', content: `Classify this content:\n\n${content}` }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'classify_content',
              description: 'Classify the content and extract structured data',
              parameters: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    enum: ['code', 'list', 'idea', 'link', 'contact', 'event', 'reminder', 'note'],
                    description: 'The primary content type'
                  },
                  subtype: {
                    type: 'string',
                    description: 'More specific categorization (e.g., grocery, todo, javascript)'
                  },
                  suggestedTitle: {
                    type: 'string',
                    description: 'A short, descriptive title for the content'
                  },
                  tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Relevant tags for categorization'
                  },
                  extractedData: {
                    type: 'object',
                    description: 'Structured data extracted from content',
                    properties: {
                      language: { type: 'string' },
                      description: { type: 'string' },
                      url: { type: 'string' },
                      date: { type: 'string' },
                      items: { type: 'array', items: { type: 'string' } },
                      dueDate: { type: 'string' },
                      task: { type: 'string' }
                    }
                  },
                  appendTo: {
                    type: 'string',
                    description: 'ID of existing entry to append to (if applicable)'
                  },
                  listItems: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        text: { type: 'string' },
                        checked: { type: 'boolean' }
                      },
                      required: ['text', 'checked']
                    },
                    description: 'For list types, the individual items'
                  }
                },
                required: ['type', 'suggestedTitle', 'tags'],
                additionalProperties: false
              }
            }
          }
        ],
        tool_choice: { type: 'function', function: { name: 'classify_content' } }
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI classification error:', response.status, errorText);

      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      throw new Error(`AI request failed: ${response.status}`);
    }

    const aiResponse = await response.json();
    console.log('Classification response:', JSON.stringify(aiResponse, null, 2));

    const toolCall = aiResponse.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      throw new Error('No tool call in AI response');
    }

    const classification: ClassificationResult = JSON.parse(toolCall.function.arguments);

    // Ensure required fields have defaults
    const result: ClassificationResult = {
      type: classification.type || 'note',
      subtype: classification.subtype,
      suggestedTitle: classification.suggestedTitle || 'Untitled',
      tags: classification.tags || [],
      extractedData: classification.extractedData || {},
      appendTo: classification.appendTo,
      listItems: classification.listItems || []
    };

    console.log('Classification result:', result);

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in classify-content function:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error occurred' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
