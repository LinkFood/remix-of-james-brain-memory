/**
 * smart-save — The Pipeline
 * 
 * GOAL: Take anything, figure it out, save it, done.
 * 
 * Flow: Content → Classify → Embed → Score → Save
 * 
 * User should never know this exists. They dump. We work.
 * Speed matters. Parallelize where possible.
 * Fail gracefully. Never lose user data.
 */

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId } from '../_shared/auth.ts';
import { checkRateLimit, RATE_LIMIT_CONFIGS, getRateLimitHeaders } from '../_shared/rateLimit.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { sanitizeString, validateContentLength, parseJsonBody } from '../_shared/validation.ts';

interface ClassificationResult {
  type: string;
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

interface Entry {
  id: string;
  user_id: string;
  content: string;
  title: string | null;
  content_type: string;
  content_subtype: string | null;
  tags: string[];
  extracted_data: Record<string, unknown>;
  importance_score: number | null;
  list_items: Array<{ text: string; checked: boolean }>;
  image_url: string | null;
  created_at: string;
  updated_at: string;
}

interface SmartSaveRequest {
  content?: string;
  source?: string;
  imageUrl?: string;
}

serve(async (req) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);

  try {
    // Authenticate user
    const { userId, error: authError } = await extractUserId(req);
    if (authError || !userId) {
      return errorResponse(req, authError ?? 'Unauthorized', 401);
    }

    // Check rate limit
    const rateLimit = checkRateLimit(userId, RATE_LIMIT_CONFIGS.standard);
    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({ 
          error: 'Rate limit exceeded. Please try again later.',
          retryAfter: Math.ceil(rateLimit.resetIn / 1000),
        }),
        { 
          status: 429, 
          headers: { 
            ...corsHeaders, 
            ...getRateLimitHeaders(rateLimit),
            'Content-Type': 'application/json',
          },
        }
      );
    }

    // Parse and validate request body
    const { data: body, error: parseError } = await parseJsonBody<SmartSaveRequest>(req);
    if (parseError || !body) {
      return errorResponse(req, parseError ?? 'Invalid request body', 400);
    }

    const { source = 'manual', imageUrl } = body;
    const content = body.content ? sanitizeString(body.content) : '';

    // Content is optional if imageUrl is provided
    if (!content && !imageUrl) {
      return errorResponse(req, 'Either content or imageUrl is required', 400);
    }

    // Validate content length if provided
    if (content) {
      const contentValidation = validateContentLength(content, 100000);
      if (!contentValidation.valid) {
        return errorResponse(req, contentValidation.error ?? 'Content validation failed', 400);
      }
    }

    console.log(`[smart-save] Processing ${imageUrl ? 'image' : 'text'} dump for user ${userId}`);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    const authHeader = req.headers.get('Authorization') ?? '';

    // Step 1: Classify content (with vision if imageUrl provided)
    console.log('Step 1: Classifying content...');
    const classifyResponse = await fetch(`${supabaseUrl}/functions/v1/classify-content`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: content || '', imageUrl }),
    });

    let classification: ClassificationResult;
    if (!classifyResponse.ok) {
      const errorText = await classifyResponse.text();
      console.error('Classification failed:', errorText);
      // Fallback classification for images
      classification = {
        type: imageUrl ? 'image' : 'note',
        subtype: imageUrl ? 'photo' : undefined,
        suggestedTitle: content?.slice(0, 50) || (imageUrl ? 'Uploaded Image' : 'Untitled'),
        tags: [],
        extractedData: {},
        listItems: [],
      };
    } else {
      classification = await classifyResponse.json();
    }
    
    console.log('Classification result:', classification);

    // Step 2: Check if we should append to an existing entry
    let action: 'created' | 'appended' = 'created';
    let entry: Entry;

    if (classification.appendTo) {
      console.log('Step 2: Attempting to append to existing entry:', classification.appendTo);

      const { data: existingEntry, error: fetchError } = await supabase
        .from('entries')
        .select('*')
        .eq('id', classification.appendTo)
        .eq('user_id', userId)
        .single();

      if (existingEntry && !fetchError) {
        // Append to existing entry
        const existingListItems = (existingEntry.list_items as Array<{ text: string; checked: boolean }>) || [];
        const newListItems = classification.listItems || [];
        const combinedListItems = [...existingListItems, ...newListItems];

        const updatedContent = existingEntry.content + '\n' + (content || '');
        const updatedTags = [...new Set([...(existingEntry.tags || []), ...classification.tags])];

        const { data: updatedEntry, error: updateError } = await supabase
          .from('entries')
          .update({
            content: updatedContent,
            list_items: combinedListItems,
            tags: updatedTags,
            updated_at: new Date().toISOString(),
          })
          .eq('id', classification.appendTo)
          .select()
          .single();

        if (updateError) {
          console.error('Failed to append to existing entry:', updateError);
          throw new Error('Failed to append to existing entry');
        }

        entry = updatedEntry;
        action = 'appended';
        console.log('Successfully appended to existing entry');
      } else {
        // Entry not found, create new
        console.log('Entry to append not found, creating new entry');
        classification.appendTo = undefined;
      }
    }

    // Step 3: Create new entry if not appending
    if (action === 'created') {
      console.log('Step 3: Creating new entry...');

      // Build the content to embed - include image description or document text if available
      const contentForEmbedding = classification.documentText
        ? `${content || ''}\n\nDocument content: ${classification.documentText}`.trim()
        : classification.imageDescription 
          ? `${content || ''}\n\nImage description: ${classification.imageDescription}`.trim()
          : content || classification.suggestedTitle || '';

      // PARALLEL: Generate embedding and calculate importance at the same time
      console.log('Generating embedding + calculating importance in parallel...');
      const [embeddingResponse, importanceResponse] = await Promise.all([
        fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: contentForEmbedding }),
        }),
        fetch(`${supabaseUrl}/functions/v1/calculate-importance`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: contentForEmbedding, role: 'user' }),
        }),
      ]);

      let embedding = null;
      if (embeddingResponse.ok) {
        const embeddingData = await embeddingResponse.json();
        embedding = embeddingData.embedding;
        console.log('Embedding generated successfully');
      } else {
        console.warn('Failed to generate embedding, continuing without it');
      }

      let importanceScore = null;
      if (importanceResponse.ok) {
        const importanceData = await importanceResponse.json();
        importanceScore = importanceData.importance_score;
        console.log('Importance calculated:', importanceScore);
      } else {
        console.warn('Failed to calculate importance, continuing without it');
      }

      // Insert new entry
      // For PDFs, store the extracted document text as the content for searchability
      const entryContent = classification.documentText 
        ? (content ? `${content}\n\n---\n\n${classification.documentText}` : classification.documentText)
        : (content || classification.imageDescription || '');
        
      const entryData: Record<string, unknown> = {
        user_id: userId,
        content: entryContent,
        title: classification.suggestedTitle,
        content_type: classification.type,
        content_subtype: classification.subtype || null,
        tags: classification.tags,
        extracted_data: {
          ...classification.extractedData,
          ...(classification.imageDescription && { imageDescription: classification.imageDescription }),
          ...(classification.documentText && { documentText: classification.documentText }),
        },
        embedding: embedding ? `[${embedding.join(',')}]` : null,
        importance_score: importanceScore,
        list_items: classification.listItems || [],
        source,
        image_url: imageUrl || null,
      };
      
      // Add calendar fields if present
      if (classification.eventDate) {
        entryData.event_date = classification.eventDate;
      }
      if (classification.eventTime) {
        entryData.event_time = classification.eventTime;
      }
      if (classification.isRecurring !== undefined) {
        entryData.is_recurring = classification.isRecurring;
      }
      if (classification.recurrencePattern) {
        entryData.recurrence_pattern = classification.recurrencePattern;
      }

      const { data: newEntry, error: insertError } = await supabase
        .from('entries')
        .insert(entryData)
        .select()
        .single();

      if (insertError) {
        console.error('Failed to insert entry:', insertError);
        throw new Error('Failed to save entry');
      }

      entry = newEntry;
      console.log('New entry created:', entry.id);
    }

    // Generate summary for the response
    const summary = action === 'appended'
      ? `Added to ${entry!.title || 'list'}`
      : imageUrl 
        ? `Image saved: "${entry!.title}"`
        : `Saved: ${entry!.title || 'Untitled'} · ${classification.type}${entry!.importance_score ? ` · ${entry!.importance_score}/10` : ''}`;

    return successResponse(req, {
      success: true,
      entry: entry!,
      action,
      summary,
      classification,
    }, 200, rateLimit);

  } catch (error) {
    console.error('Error in smart-save function:', error);
    return serverErrorResponse(req, error instanceof Error ? error : new Error('Unknown error'));
  }
});
