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
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId } from '../_shared/auth.ts';
import { checkRateLimit, getRateLimitHeaders, RATE_LIMIT_CONFIGS } from '../_shared/rateLimit.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { sanitizeString, validateContentLength, parseJsonBody } from '../_shared/validation.ts';

interface ClassificationResult {
  type: 'code' | 'list' | 'idea' | 'link' | 'contact' | 'event' | 'reminder' | 'note' | 'image' | 'document';
  subtype?: string;
  suggestedTitle: string;
  tags: string[];
  extractedData: Record<string, unknown>;
  appendTo?: string;
  listItems?: Array<{ text: string; checked: boolean }>;
  imageDescription?: string;
  documentText?: string;
  eventDate?: string;
  eventTime?: string;
  isRecurring?: boolean;
  recurrencePattern?: 'daily' | 'weekly' | 'monthly' | 'yearly';
}

interface ClassifyRequest {
  content?: string;
  imageUrl?: string;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY')!;

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Extract user ID from JWT
    const { userId, error: authError } = await extractUserId(req);

    // Rate limiting (AI operations)
    if (userId) {
      const rateLimitResult = checkRateLimit(`classify:${userId}`, RATE_LIMIT_CONFIGS.ai);
      if (!rateLimitResult.allowed) {
        return new Response(
          JSON.stringify({ error: 'Rate limit exceeded', retryAfter: Math.ceil(rateLimitResult.resetIn / 1000) }),
          { 
            status: 429,
            headers: { ...corsHeaders, ...getRateLimitHeaders(rateLimitResult), 'Content-Type': 'application/json' } 
          }
        );
      }
    }

    // Parse and validate request
    const { data: body, error: parseError } = await parseJsonBody<ClassifyRequest>(req);
    if (parseError || !body) {
      return errorResponse(req, parseError || 'Invalid request body', 400);
    }

    const content = body.content ? sanitizeString(body.content) : '';
    const imageUrl = body.imageUrl ? sanitizeString(body.imageUrl) : undefined;

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

    const systemPrompt = `You are a content classifier for the "LinkJac" app. Users paste anything - code, lists, ideas, links, notes, images, or PDFs - and you classify it.

Analyze the content and determine:
1. TYPE: code | list | idea | link | contact | event | reminder | note | image | document
2. SUBTYPE (optional): For lists: grocery, todo, shopping, reading, etc. For code: javascript, python, etc. For images: screenshot, diagram, photo, receipt, whiteboard. For documents: invoice, contract, report, article, manual, form, letter
3. SUGGESTED TITLE: A short, descriptive title (max 60 chars)
4. TAGS: Relevant tags for categorization (max 5)
5. EXTRACTED DATA: Structured data based on type
6. APPEND TO: If content should be added to an existing entry, provide the ID
7. LIST ITEMS: If it's a list, extract individual items
8. IMAGE DESCRIPTION: For images, perform FORENSIC-LEVEL extraction
9. DOCUMENT TEXT: For PDFs, extract ALL text content preserving structure
10. EVENT DATE/TIME: If content mentions dates or times, extract them

Guidelines:
- CODE: Contains programming syntax, functions, variables, imports
- LIST: Multiple items, bullet points, numbered items, shopping items
- IDEA: Concepts, brainstorms, "what if", feature ideas
- LINK: URLs, website references
- CONTACT: Names with phone/email/address
- EVENT: Dates, meetings, appointments with specific dates/times
- REMINDER: Tasks with "tomorrow", "remember to", deadlines
- NOTE: Everything else - random thoughts, information
- IMAGE: Photos, screenshots, diagrams, visual content
- DOCUMENT: PDFs, scanned documents, multi-page content

=== DATE/TIME EXTRACTION (CRITICAL) ===
Extract dates and times from content to enable calendar features:

RELATIVE DATES (resolve to actual dates based on today):
- "tomorrow" → next day's date
- "next week" → 7 days from now
- "next Monday" → next Monday's date
- "in 3 days" → 3 days from now
- "tonight" → today's date, evening time (20:00)
- "this afternoon" → today's date, afternoon time (14:00)

ABSOLUTE DATES:
- "June 5th" → 2026-06-05
- "3/15/2026" → 2026-03-15
- "March 15" → 2026-03-15

TIMES:
- "at 3pm" → 15:00
- "at 10:30 AM" → 10:30
- "at noon" → 12:00
- "in the morning" → 09:00
- "evening" → 19:00

RECURRING PATTERNS:
- "every day", "daily" → isRecurring: true, recurrencePattern: "daily"
- "every week", "weekly" → isRecurring: true, recurrencePattern: "weekly"
- "every month", "monthly" → isRecurring: true, recurrencePattern: "monthly"
- "every year", "yearly" → isRecurring: true, recurrencePattern: "yearly"

Today's date is: ${new Date().toISOString().split('T')[0]}

=== CRITICAL: FORENSIC IMAGE EXTRACTION ===
For ALL images, you MUST perform exhaustive data extraction including ALL visible text, numbers, financial data, receipts, screenshots, and diagrams.

For lists, extract each item as a separate list_item with checked: false.
${recentListsContext}`;

    // Build messages array
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'system', content: systemPrompt },
    ];

    // Detect if this is a PDF by checking the file path
    const isPdf = imageUrl && (imageUrl.endsWith('.pdf') || imageUrl.includes('.pdf'));
    
    // If we have an image or PDF, use vision capabilities
    if (imageUrl) {
      console.log(`[classify-content] Processing ${isPdf ? 'PDF' : 'image'} with vision:`, imageUrl);
      
      // For PDFs stored in Supabase, we need to get a signed URL
      let fileUrl = imageUrl;
      if (imageUrl.startsWith('dumps/')) {
        const { data: signedData, error: signedError } = await supabase.storage
          .from('dumps')
          .createSignedUrl(imageUrl.replace('dumps/', ''), 300);
        
        if (signedError) {
          console.error('[classify-content] Failed to create signed URL:', signedError);
          return serverErrorResponse(req, 'Failed to access file');
        }
        fileUrl = signedData.signedUrl;
      }
      
      const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
      
      userContent.push({
        type: 'image_url',
        image_url: { url: fileUrl },
      });
      
      let textPrompt = isPdf 
        ? 'Analyze this PDF document and extract ALL content. '
        : 'Analyze this image and classify it. ';
        
      if (content) {
        textPrompt += `The user also provided this context: "${content}"\n\n`;
      }
      
      if (isPdf) {
        textPrompt += `IMPORTANT: This is a PDF document. Extract ALL text content, preserve structure (headings, paragraphs, tables, lists), identify the document type, and extract all key data.`;
      } else {
        textPrompt += `IMPORTANT: Provide a detailed description of what's in the image in the imageDescription field.`;
      }
      
      userContent.push({ type: 'text', text: textPrompt });
      
      messages.push({ role: 'user', content: userContent });
    } else {
      // Text-only classification
      if (!content) {
        return errorResponse(req, 'Content is required for text classification', 400);
      }
      
      const validation = validateContentLength(content, 50000);
      if (!validation.valid) {
        return errorResponse(req, validation.error!, 400);
      }
      
      messages.push({
        role: 'user',
        content: `Classify this content:\n\n${content}`,
      });
    }

    // Use best vision model for images/PDFs, fast model for text
    const model = imageUrl ? 'google/gemini-2.5-pro' : 'google/gemini-2.5-flash';
    console.log(`[classify-content] Using model: ${model}, hasFile: ${!!imageUrl}, isPdf: ${isPdf}`);

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
                    enum: ['code', 'list', 'idea', 'link', 'contact', 'event', 'reminder', 'note', 'image', 'document'],
                    description: 'The primary content type'
                  },
                  subtype: { type: 'string', description: 'More specific categorization' },
                  suggestedTitle: { type: 'string', description: 'A short, descriptive title' },
                  tags: { type: 'array', items: { type: 'string' }, description: 'Relevant tags' },
                  extractedData: { type: 'object', description: 'Structured data extracted from content' },
                  appendTo: { type: 'string', description: 'ID of existing entry to append to' },
                  listItems: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: { text: { type: 'string' }, checked: { type: 'boolean' } },
                      required: ['text', 'checked']
                    },
                    description: 'For list types, the individual items'
                  },
                  imageDescription: { type: 'string', description: 'For images: detailed description' },
                  documentText: { type: 'string', description: 'For PDFs: full extracted text' },
                  eventDate: { type: 'string', description: 'ISO date string (YYYY-MM-DD)' },
                  eventTime: { type: 'string', description: 'Time string (HH:MM)' },
                  isRecurring: { type: 'boolean', description: 'Whether this is recurring' },
                  recurrencePattern: {
                    type: 'string',
                    enum: ['daily', 'weekly', 'monthly', 'yearly'],
                    description: 'Recurrence pattern'
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
        max_tokens: 4000
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI classification error:', response.status, errorText);

      if (response.status === 429) {
        return errorResponse(req, 'Rate limit exceeded. Please try again later.', 429);
      }
      if (response.status === 402) {
        return errorResponse(req, 'AI credits exhausted', 402);
      }

      return serverErrorResponse(req, `AI request failed: ${response.status}`);
    }

    const aiResponse = await response.json();
    console.log('Classification response received');

    const toolCall = aiResponse.choices[0]?.message?.tool_calls?.[0];
    
    if (!toolCall) {
      console.warn('[classify-content] No tool call in response, using fallback');
      const fallbackResult: ClassificationResult = {
        type: isPdf ? 'document' : (imageUrl ? 'image' : 'note'),
        subtype: isPdf ? 'unknown' : (imageUrl ? 'photo' : undefined),
        suggestedTitle: content?.slice(0, 50) || (isPdf ? 'PDF Document' : (imageUrl ? 'Uploaded Image' : 'Untitled')),
        tags: [],
        extractedData: {},
        listItems: [],
      };
      return successResponse(req, fallbackResult);
    }

    const classification: ClassificationResult = JSON.parse(toolCall.function.arguments);

    // Ensure required fields have defaults
    const result: ClassificationResult = {
      type: classification.type || (isPdf ? 'document' : (imageUrl ? 'image' : 'note')),
      subtype: classification.subtype,
      suggestedTitle: classification.suggestedTitle || (isPdf ? 'PDF Document' : (imageUrl ? 'Uploaded Image' : 'Untitled')),
      tags: classification.tags || [],
      extractedData: classification.extractedData || {},
      appendTo: classification.appendTo,
      listItems: classification.listItems || [],
      imageDescription: classification.imageDescription,
      documentText: classification.documentText,
      eventDate: classification.eventDate,
      eventTime: classification.eventTime,
      isRecurring: classification.isRecurring,
      recurrencePattern: classification.recurrencePattern,
    };

    console.log(`[classify-content] Result: type=${result.type}, title="${result.suggestedTitle}"`);

    return successResponse(req, result);

  } catch (error) {
    console.error('Error in classify-content:', error);
    return serverErrorResponse(req, error instanceof Error ? error : 'Classification failed');
  }
});
