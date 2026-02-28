/**
 * smart-save — The Pipeline
 * 
 * GOAL: Take anything, figure it out, save it, done.
 * 
 * Flow: Content → Classify → Score → Save
 * 
 * User should never know this exists. They dump. We work.
 * Speed matters. Parallelize where possible.
 * Fail gracefully. Never lose user data.
 * 
 * SPEED OPTIMIZATIONS:
 * - Local regex classification for simple patterns (URLs, lists, code)
 * - Skip importance scoring for short content
 * - Fast flash model for classification
 */

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId, extractUserIdWithServiceRole, isServiceRoleRequest } from '../_shared/auth.ts';
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
  reminderMinutes?: number;
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

// Fast local classification for simple patterns (skips AI entirely)
function tryLocalClassification(content: string): ClassificationResult | null {
  if (!content || content.length >= 150) return null;
  
  const trimmed = content.trim();
  
  // URL detection
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    try {
      return {
        type: 'link',
        suggestedTitle: new URL(trimmed).hostname,
        tags: ['link'],
        extractedData: { url: trimmed },
        listItems: [],
      };
    } catch {
      // Invalid URL, continue
    }
  }
  
  // List detection (bullet points, numbered items)
  if (/^[-•*]\s|\n[-•*]\s|^\d+\.\s|\n\d+\.\s/.test(content)) {
    const items = content
      .split(/\n/)
      .map(line => line.replace(/^[-•*\d.]+\s*/, '').trim())
      .filter(Boolean)
      .map(text => ({ text, checked: false }));
    
    if (items.length > 0) {
      return {
        type: 'list',
        subtype: 'todo',
        suggestedTitle: items[0]?.text.slice(0, 40) || 'List',
        tags: ['list'],
        extractedData: {},
        listItems: items,
      };
    }
  }
  
  // Code detection
  if (/^(import |const |let |var |function |class |def |async |=>)/m.test(content)) {
    return {
      type: 'code',
      suggestedTitle: 'Code snippet',
      tags: ['code'],
      extractedData: {},
      listItems: [],
    };
  }
  
  return null;
}

serve(async (req) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);

  try {
    // Parse body early for service role auth
    const rawBody = await req.text();
    const parsedBody = JSON.parse(rawBody) as SmartSaveRequest & { userId?: string };

    // Authenticate — supports both JWT and service role + userId in body
    const { userId, error: authError } = await extractUserIdWithServiceRole(
      req,
      parsedBody as unknown as Record<string, unknown>
    );
    if (authError || !userId) {
      return errorResponse(req, authError ?? 'Unauthorized', 401);
    }

    // Skip rate limit for internal agent calls
    const isInternal = isServiceRoleRequest(req);
    let rateLimit: ReturnType<typeof checkRateLimit> | undefined;
    if (!isInternal) {
      rateLimit = checkRateLimit(userId, RATE_LIMIT_CONFIGS.standard);
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
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Body already parsed above for auth — reuse it
    const body = parsedBody as SmartSaveRequest;

    const { source = 'manual', imageUrl } = body;
    const content = body.content ? sanitizeString(body.content) : '';

    if (!content && !imageUrl) {
      return errorResponse(req, 'Either content or imageUrl is required', 400);
    }

    if (content) {
      const contentValidation = validateContentLength(content, 100000);
      if (!contentValidation.valid) {
        return errorResponse(req, contentValidation.error ?? 'Content validation failed', 400);
      }
    }

    console.log(`[smart-save] Processing ${imageUrl ? 'image' : 'text'} dump for user ${userId}`);

    const authHeader = req.headers.get('Authorization') ?? '';

    // SPEED OPTIMIZATION: Try local classification first (for simple text without images)
    let classification: ClassificationResult;
    let importanceScore: number | null = null;
    
    const localResult = !imageUrl ? tryLocalClassification(content) : null;
    
    // Track whether we need a deferred importance update (fast path)
    let deferImportanceScoring = false;

    if (localResult) {
      // Fast path: use local classification
      classification = localResult;
      importanceScore = 5; // Default — AI will update async after entry is created
      deferImportanceScoring = true;
      console.log(`[smart-save] Fast path: ${classification.type}`);
    } else {
      // AI path: call classify-content and calculate-importance in parallel
      console.log('[smart-save] AI classification path...');

      const fetchPromises: Promise<Response>[] = [
        fetch(`${supabaseUrl}/functions/v1/classify-content`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content, imageUrl, userId }),
        }),
        fetch(`${supabaseUrl}/functions/v1/calculate-importance`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content, role: 'user' }),
        }),
      ];

      const responses = await Promise.all(fetchPromises);
      const classifyResponse = responses[0];
      const importanceResponse = responses[1];

      if (!classifyResponse.ok) {
        const errorText = await classifyResponse.text();
        console.error('Classification failed:', errorText);
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

      if (importanceResponse?.ok) {
        const importanceData = await importanceResponse.json();
        importanceScore = importanceData.importance_score;
        console.log('Importance calculated:', importanceScore);
      }
    }

    // Step 3: Check if we should append to an existing entry
    let action: 'created' | 'appended' = 'created';
    let entry: Entry;

    if (classification.appendTo) {
      console.log('Attempting to append to existing entry:', classification.appendTo);

      const { data: existingEntry, error: fetchError } = await supabase
        .from('entries')
        .select('*')
        .eq('id', classification.appendTo)
        .eq('user_id', userId)
        .single();

      if (existingEntry && !fetchError) {
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
        console.log('Entry to append not found, creating new entry');
        classification.appendTo = undefined;
      }
    }

    // Step 4: Create new entry if not appending
    if (action === 'created') {
      console.log('Creating new entry...');

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
        embedding: null,
        importance_score: importanceScore,
        list_items: classification.listItems || [],
        source,
        image_url: imageUrl || null,
      };
      
      if (classification.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(classification.eventDate)) {
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
      if (classification.reminderMinutes !== undefined && classification.reminderMinutes !== null) {
        const mins = Number(classification.reminderMinutes);
        if (!isNaN(mins) && mins >= 0 && mins <= 20160) {
          entryData.reminder_minutes = Math.round(mins);
        }
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

      // Generate embedding asynchronously (fire-and-forget for speed)
      // Rich text: include metadata for better semantic matching
      const richEmbeddingText = `${classification.suggestedTitle} | ${classification.type} | ${classification.tags.join(', ')} | ${entryContent}`.slice(0, 8000);
      if (richEmbeddingText.length > 10) {
        fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: richEmbeddingText }),
        })
          .then(async (embRes) => {
            if (embRes.ok) {
              const embData = await embRes.json();
              if (embData.embedding) {
                // Store embedding on the entry
                const { error: embUpdateError } = await supabase
                  .from('entries')
                  .update({ embedding: JSON.stringify(embData.embedding) })
                  .eq('id', entry!.id);
                if (embUpdateError) {
                  console.warn('Failed to store embedding:', embUpdateError);
                } else {
                  console.log('Embedding stored for entry:', entry!.id);
                  // Find and store related entries
                  try {
                    const { data: related } = await supabase.rpc('search_entries_by_embedding', {
                      query_embedding: JSON.stringify(embData.embedding),
                      match_threshold: 0.65,
                      match_count: 6,
                      filter_user_id: userId,
                    });
                    if (related && related.length > 0) {
                      const relationships = related
                        .filter((r: any) => r.id !== entry!.id)
                        .slice(0, 5)
                        .map((r: any) => ({
                          entry_id: entry!.id,
                          related_entry_id: r.id,
                          user_id: userId,
                          similarity_score: r.similarity,
                          relationship_type: 'semantic',
                        }));
                      if (relationships.length > 0) {
                        await supabase.from('entry_relationships').insert(relationships);
                        console.log(`Stored ${relationships.length} relationships for entry:`, entry!.id);
                      }
                    }
                  } catch (relErr) {
                    console.warn('Failed to compute relationships:', relErr);
                  }
                }
              }
            }
          })
          .catch((err) => console.warn('Embedding generation failed (non-blocking):', err));
      }

      // Deferred importance scoring for fast-path entries (fire-and-forget DB update)
      if (deferImportanceScoring) {
        fetch(`${supabaseUrl}/functions/v1/calculate-importance`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content, role: 'user' }),
        }).then(async (res) => {
          if (res.ok) {
            const data = await res.json();
            if (data.importance_score != null) {
              await supabase
                .from('entries')
                .update({ importance_score: data.importance_score })
                .eq('id', entry!.id);
              console.log(`Deferred importance score ${data.importance_score} for entry:`, entry!.id);
            }
          }
        }).catch((err) => console.warn('Deferred importance scoring failed (non-blocking):', err));
      }
    }

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
