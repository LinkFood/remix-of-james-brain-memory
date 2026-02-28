/**
 * classify-content — The Brain Behind the Brain
 * 
 * Uses Anthropic Claude for classification.
 */

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserIdWithServiceRole } from '../_shared/auth.ts';
import { checkRateLimit, getRateLimitHeaders, RATE_LIMIT_CONFIGS } from '../_shared/rateLimit.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { sanitizeString, validateContentLength } from '../_shared/validation.ts';
import { callClaude, parseToolUse, CLAUDE_MODELS, ClaudeError } from '../_shared/anthropic.ts';

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
  reminderMinutes?: number;
}

interface ClassifyRequest {
  content?: string;
  imageUrl?: string;
}

Deno.serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Parse body BEFORE auth so extractUserIdWithServiceRole can read userId from it
    const rawBody = await req.text();
    let parsedBody: Record<string, unknown>;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return errorResponse(req, 'Invalid request body', 400);
    }

    const { userId, error: authError } = await extractUserIdWithServiceRole(req, parsedBody);

    if (userId) {
      const rateLimitResult = checkRateLimit(`classify:${userId}`, RATE_LIMIT_CONFIGS.ai);
      if (!rateLimitResult.allowed) {
        return new Response(
          JSON.stringify({ error: 'Rate limit exceeded', retryAfter: Math.ceil(rateLimitResult.resetIn / 1000) }),
          { status: 429, headers: { ...getCorsHeaders(req), ...getRateLimitHeaders(rateLimitResult), 'Content-Type': 'application/json' } }
        );
      }
    }

    const body = parsedBody as ClassifyRequest;
    const content = body.content ? sanitizeString(body.content) : '';
    const imageUrl = body.imageUrl ? sanitizeString(body.imageUrl) : undefined;

    // Fetch recent lists for append context
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
3. SUGGESTED TITLE: Generate a specific, descriptive title (max 60 chars) that explains WHAT this is, not just its type
4. TAGS: Relevant tags for categorization (max 5)
5. EXTRACTED DATA: Structured data based on type
6. APPEND TO: If content should be added to an existing entry, provide the ID
7. LIST ITEMS: If it's a list, extract individual items
8. IMAGE DESCRIPTION: For images, perform FORENSIC-LEVEL extraction
9. DOCUMENT TEXT: For PDFs, extract ALL text content preserving structure
10. EVENT DATE/TIME: If content mentions dates or times, extract them

=== CRITICAL: TITLE GENERATION RULES ===
The title is the IDENTITY of each entry. Users will search and ask about entries by title. Generic titles are USELESS.

NEVER generate these generic titles:
- "Code snippet" → Instead: "React useEffect cleanup hook" or "Python CSV parser function"
- "List" → Instead: "Weekly grocery shopping list" or "Q3 project tasks"
- "Note" → Instead: "Ideas for redesigning the dashboard" or "Meeting notes from standup"
- "Link" → Instead: "Tailwind CSS documentation" or "Stripe API pricing page"
- "Reminder" → Instead: "Call mom tomorrow afternoon" or "Submit expense report Friday"
- "Image" → Instead: "Receipt from Home Depot" or "Screenshot of Stripe dashboard"
- "Document" → Instead: "2024 Tax Return Form" or "Apartment lease agreement"
- "Untitled" → NEVER use this

FOR CODE: Describe what the code DOES, not that it's code. Include language/framework.
FOR LISTS: Include the list's PURPOSE or context.
FOR IMAGES: Describe the KEY subject matter visible.
FOR LINKS: Describe what the linked resource IS.

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
Extract dates and times from content to enable calendar features.
The user's current local date/time is approximately: ${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())} ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())} (Central Time)

ALWAYS set eventDate as YYYY-MM-DD and eventTime as HH:MM (24-hour format).

=== RECURRING PATTERNS ===
- "every day", "daily" → isRecurring: true, recurrencePattern: "daily"
- "every week", "weekly" → isRecurring: true, recurrencePattern: "weekly"
- "every month", "monthly" → isRecurring: true, recurrencePattern: "monthly"
- "every year", "yearly" → isRecurring: true, recurrencePattern: "yearly"

=== REMINDER EXTRACTION (CRITICAL — always extract for "remind me") ===
Any message containing "remind me" MUST be classified as type "reminder" with eventDate, eventTime, and reminderMinutes set.

"remind me AT a specific time" (no "before" offset):
- "remind me at 3pm" → eventDate: today, eventTime: "15:00", reminderMinutes: 1
- "remind me at 12:16 AM today" → eventDate: today, eventTime: "00:16", reminderMinutes: 1
- "remind me at 9am tomorrow" → eventDate: tomorrow, eventTime: "09:00", reminderMinutes: 1
- When user specifies an exact time, set reminderMinutes: 1 (fires ~1 min before the time)

"remind me BEFORE an event":
- "remind me 15 minutes before" → reminderMinutes: 15
- "remind me an hour before" → reminderMinutes: 60
- "remind me the day before" / "remind me day of" → reminderMinutes: 1440
- "remind me a week before" → reminderMinutes: 10080

"remind me" with relative time but no specific clock time:
- "remind me tomorrow to X" → eventDate: tomorrow, eventTime: "09:00", reminderMinutes: 1
- "remind me next Tuesday" → eventDate: next Tuesday, eventTime: "09:00", reminderMinutes: 1
- "remind me in 30 minutes" → eventDate: today, eventTime: now + 30 min, reminderMinutes: 1
- "remind me" with no time at all → eventDate: today, eventTime: "09:00", reminderMinutes: 1440

For lists, extract each item as a separate list_item with checked: false.
${recentListsContext}`;

    // Build messages array for Claude
    const isPdf = imageUrl && (imageUrl.endsWith('.pdf') || imageUrl.includes('.pdf'));
    const claudeMessages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];

    if (imageUrl) {
      console.log(`[classify-content] Processing ${isPdf ? 'PDF' : 'image'} with vision:`, imageUrl);
      
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

      const userContent: Array<unknown> = [
        { type: 'image', source: { type: 'url', url: fileUrl } },
      ];

      let textPrompt = isPdf
        ? 'Analyze this PDF document and extract ALL content. '
        : 'Analyze this image and classify it. ';
      if (content) textPrompt += `The user also provided this context: "${content}"\n\n`;
      if (isPdf) textPrompt += `IMPORTANT: This is a PDF document. Extract ALL text content, preserve structure.`;
      else textPrompt += `IMPORTANT: Provide a detailed description in the imageDescription field.`;
      
      userContent.push({ type: 'text', text: textPrompt });
      claudeMessages.push({ role: 'user', content: userContent });
    } else {
      if (!content) {
        return errorResponse(req, 'Content is required for text classification', 400);
      }
      const validation = validateContentLength(content, 50000);
      if (!validation.valid) {
        return errorResponse(req, validation.error!, 400);
      }
      claudeMessages.push({ role: 'user', content: `Classify this content:\n\n${content}` });
    }

    const claudeTools = [{
      name: 'classify_content',
      description: 'Classify the content and extract structured data',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['code', 'list', 'idea', 'link', 'contact', 'event', 'reminder', 'note', 'image', 'document'] },
          subtype: { type: 'string', description: 'More specific categorization' },
          suggestedTitle: { type: 'string', description: 'A short, descriptive title' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Relevant tags' },
          extractedData: { type: 'object', description: 'Structured data extracted from content' },
          appendTo: { type: 'string', description: 'ID of existing entry to append to' },
          listItems: {
            type: 'array',
            items: { type: 'object', properties: { text: { type: 'string' }, checked: { type: 'boolean' } }, required: ['text', 'checked'] },
          },
          imageDescription: { type: 'string' },
          documentText: { type: 'string' },
          eventDate: { type: 'string', description: 'ISO date string (YYYY-MM-DD)' },
          eventTime: { type: 'string', description: 'Time string (HH:MM)' },
          isRecurring: { type: 'boolean' },
          recurrencePattern: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
          reminderMinutes: { type: 'number', description: 'Minutes before event to send reminder. 15, 30, 60, 1440 (1 day), 10080 (1 week). Extract from "remind me" phrases.' },
        },
        required: ['type', 'suggestedTitle', 'tags'],
      },
    }];

    console.log(`[classify-content] Calling Claude ${CLAUDE_MODELS.haiku}, hasFile: ${!!imageUrl}, isPdf: ${isPdf}`);

    const claudeResponse = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: systemPrompt,
      messages: claudeMessages,
      tools: claudeTools,
      tool_choice: { type: 'tool', name: 'classify_content' },
      temperature: 0.3,
      max_tokens: 4000,
    });

    const toolResult = parseToolUse(claudeResponse);

    if (!toolResult) {
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

    const classification = toolResult.input as unknown as ClassificationResult;

    // Normalize tags — Claude sometimes returns a comma-separated string instead of an array
    let normalizedTags: string[] = [];
    if (Array.isArray(classification.tags)) {
      normalizedTags = classification.tags.map((t: unknown) => String(t).trim()).filter(Boolean);
    } else if (typeof classification.tags === 'string' && classification.tags) {
      normalizedTags = (classification.tags as string).split(',').map(t => t.trim()).filter(Boolean);
    }

    const result: ClassificationResult = {
      type: classification.type || (isPdf ? 'document' : (imageUrl ? 'image' : 'note')),
      subtype: classification.subtype,
      suggestedTitle: classification.suggestedTitle || (isPdf ? 'PDF Document' : (imageUrl ? 'Uploaded Image' : 'Untitled')),
      tags: normalizedTags,
      extractedData: classification.extractedData || {},
      appendTo: classification.appendTo,
      listItems: Array.isArray(classification.listItems) ? classification.listItems : [],
      imageDescription: classification.imageDescription,
      documentText: classification.documentText,
      eventDate: classification.eventDate,
      eventTime: classification.eventTime,
      isRecurring: classification.isRecurring,
      recurrencePattern: classification.recurrencePattern,
      reminderMinutes: classification.reminderMinutes,
    };

    console.log(`[classify-content] Result: type=${result.type}, title="${result.suggestedTitle}"`);
    return successResponse(req, result);

  } catch (error) {
    console.error('Error in classify-content:', error);
    if (error instanceof ClaudeError) {
      return errorResponse(req, error.message, error.status);
    }
    return serverErrorResponse(req, error instanceof Error ? error : 'Classification failed');
  }
});
