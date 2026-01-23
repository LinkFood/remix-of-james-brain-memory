/**
 * classify-content — The Brain Behind the Brain
 * 
 * GOAL: Figure out what the user dumped without asking them.
 * 
 * Code? We know. Grocery list? We know. Random thought? We know.
 * 
 * This is the magic. Get this right and the product works.
 * Get this wrong and users have to organize. We failed.
 */

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ClassificationResult {
  type: 'code' | 'list' | 'idea' | 'link' | 'contact' | 'event' | 'reminder' | 'note' | 'image';
  subtype?: string;
  suggestedTitle: string;
  tags: string[];
  extractedData: Record<string, unknown>;
  appendTo?: string;
  listItems?: Array<{ text: string; checked: boolean }>;
  imageDescription?: string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY')!;

    const supabase = createClient(supabaseUrl, supabaseKey);

    // SECURITY FIX: Extract user ID from JWT instead of request body
    const authHeader = req.headers.get('Authorization');
    let userId: string | null = null;
    
    if (authHeader) {
      const jwt = authHeader.replace('Bearer ', '');
      const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
      
      if (!authError && user) {
        userId = user.id;
      }
    }

    const { content, imageUrl } = await req.json();

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

    const systemPrompt = `You are a content classifier for a "brain dump" app. Users paste anything - code, lists, ideas, links, notes, or images - and you classify it.

Analyze the content and determine:
1. TYPE: code | list | idea | link | contact | event | reminder | note | image
2. SUBTYPE (optional): For lists: grocery, todo, shopping, reading, etc. For code: javascript, python, etc. For images: screenshot, diagram, photo, receipt, whiteboard, document
3. SUGGESTED TITLE: A short, descriptive title (max 60 chars)
4. TAGS: Relevant tags for categorization (max 5)
5. EXTRACTED DATA: Structured data based on type
6. APPEND TO: If content should be added to an existing entry, provide the ID
7. LIST ITEMS: If it's a list, extract individual items
8. IMAGE DESCRIPTION: For images, perform FORENSIC-LEVEL extraction

Guidelines:
- CODE: Contains programming syntax, functions, variables, imports
- LIST: Multiple items, bullet points, numbered items, shopping items
- IDEA: Concepts, brainstorms, "what if", feature ideas
- LINK: URLs, website references
- CONTACT: Names with phone/email/address
- EVENT: Dates, meetings, appointments
- REMINDER: Tasks with "tomorrow", "remember to", deadlines
- NOTE: Everything else - random thoughts, information
- IMAGE: Photos, screenshots, diagrams, visual content

=== CRITICAL: FORENSIC IMAGE EXTRACTION ===
For ALL images, you MUST perform exhaustive data extraction:

1. TEXT EXTRACTION (OCR-style):
   - Extract EVERY piece of visible text, word-for-word
   - Include ALL numbers, percentages, dates, symbols, ticker symbols
   - Preserve structure (headers, labels, values, columns)
   - Capture small text, watermarks, timestamps

2. FINANCIAL/CHART IMAGES:
   - Ticker symbols (TSLA, AAPL, BTC, etc.)
   - Current prices, price changes, percentages
   - Dates, timeframes, intervals
   - Indicators (RSI, MACD, moving averages, volume)
   - Support/resistance levels, trend lines
   - Any visible order book data, bid/ask

3. RECEIPTS/INVOICES/DOCUMENTS:
   - Vendor/store name, logo text
   - Date, time, transaction ID
   - All line items with prices
   - Subtotal, tax, tips, total
   - Payment method, last 4 digits
   - Address, phone numbers

4. SCREENSHOTS OF APPS/WEBSITES:
   - App name, page title, URL if visible
   - ALL visible data: emails, names, numbers, addresses
   - Button labels, menu items
   - Notification text, error messages
   - Form field contents

5. PHOTOS WITH TEXT:
   - Signs, labels, business names
   - Handwritten notes (transcribe fully)
   - Product names, model numbers
   - Prices, barcodes if readable

6. DIAGRAMS/WIREFRAMES:
   - All labels, annotations, arrows
   - Component names, flow directions
   - Notes, comments, measurements

The imageDescription field MUST contain ALL extracted data in structured format.
This is the ONLY way users can search for this content later.
OVER-EXTRACT. More data is ALWAYS better than less.
If you see it, extract it.

For lists, extract each item as a separate list_item with checked: false.
${recentListsContext}`;

    // Build messages array
    const messages: Array<{ role: string; content: any }> = [
      { role: 'system', content: systemPrompt },
    ];

    // If we have an image, use vision capabilities
    if (imageUrl) {
      console.log('[classify-content] Processing image with vision:', imageUrl);
      
      const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
      
      // Add the image
      userContent.push({
        type: 'image_url',
        image_url: { url: imageUrl },
      });
      
      // Add text instruction
      let textPrompt = 'Analyze this image and classify it. ';
      if (content) {
        textPrompt += `The user also provided this context: "${content}"\n\n`;
      }
      textPrompt += `IMPORTANT: Provide a detailed description of what's in the image in the imageDescription field. If it's a screenshot of text or code, extract the actual text/code. If it's a diagram, describe the structure. If it's a receipt, extract the amounts and vendor. This description is critical for making the image searchable later.`;
      
      userContent.push({ type: 'text', text: textPrompt });
      
      messages.push({ role: 'user', content: userContent });
    } else {
      // Text-only classification
      if (!content) {
        return new Response(
          JSON.stringify({ error: 'Content is required for text classification' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      messages.push({
        role: 'user',
        content: `Classify this content:\n\n${content}`,
      });
    }

    // Use best vision model for images, fast model for text
    const model = imageUrl ? 'google/gemini-2.5-pro' : 'google/gemini-2.5-flash';
    console.log(`[classify-content] Using model: ${model}, hasImage: ${!!imageUrl}`);

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
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
                    enum: ['code', 'list', 'idea', 'link', 'contact', 'event', 'reminder', 'note', 'image'],
                    description: 'The primary content type'
                  },
                  subtype: {
                    type: 'string',
                    description: 'More specific categorization (e.g., grocery, todo, javascript, screenshot, diagram)'
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
                      task: { type: 'string' },
                      amount: { type: 'number' },
                      vendor: { type: 'string' }
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
                  },
                  imageDescription: {
                    type: 'string',
                    description: 'For images: detailed description of what is visible, including any text, code, or structured content'
                  }
                },
                required: ['type', 'suggestedTitle', 'tags'],
                additionalProperties: false
              }
            }
          }
        ],
        tool_choice: { type: 'function', function: { name: 'classify_content' } },
        temperature: 0.3,
        max_tokens: 1500
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
      // Fallback if no tool call
      console.warn('[classify-content] No tool call in response, using fallback');
      const fallbackResult: ClassificationResult = {
        type: imageUrl ? 'image' : 'note',
        subtype: imageUrl ? 'photo' : undefined,
        suggestedTitle: content?.slice(0, 50) || (imageUrl ? 'Uploaded Image' : 'Untitled'),
        tags: [],
        extractedData: {},
        listItems: [],
      };
      return new Response(JSON.stringify(fallbackResult), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const classification: ClassificationResult = JSON.parse(toolCall.function.arguments);

    // Ensure required fields have defaults
    const result: ClassificationResult = {
      type: classification.type || (imageUrl ? 'image' : 'note'),
      subtype: classification.subtype,
      suggestedTitle: classification.suggestedTitle || (imageUrl ? 'Uploaded Image' : 'Untitled'),
      tags: classification.tags || [],
      extractedData: classification.extractedData || {},
      appendTo: classification.appendTo,
      listItems: classification.listItems || [],
      imageDescription: classification.imageDescription
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
