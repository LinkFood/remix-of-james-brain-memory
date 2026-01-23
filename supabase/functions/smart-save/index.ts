import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ClassificationResult {
  type: string;
  subtype?: string;
  suggestedTitle: string;
  tags: string[];
  extractedData: Record<string, unknown>;
  appendTo?: string;
  listItems?: Array<{ text: string; checked: boolean }>;
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
  created_at: string;
  updated_at: string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { content, userId, source = 'manual' } = await req.json();

    if (!content || !userId) {
      return new Response(
        JSON.stringify({ error: 'Content and userId are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY')!;

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Step 1: Classify content
    console.log('Step 1: Classifying content...');
    const classifyResponse = await fetch(`${supabaseUrl}/functions/v1/classify-content`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content, userId }),
    });

    if (!classifyResponse.ok) {
      const errorText = await classifyResponse.text();
      console.error('Classification failed:', errorText);
      throw new Error('Failed to classify content');
    }

    const classification: ClassificationResult = await classifyResponse.json();
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

        const updatedContent = existingEntry.content + '\n' + content;
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

      // Generate embedding
      console.log('Generating embedding...');
      const embeddingResponse = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: content }),
      });

      let embedding = null;
      if (embeddingResponse.ok) {
        const embeddingData = await embeddingResponse.json();
        embedding = embeddingData.embedding;
        console.log('Embedding generated successfully');
      } else {
        console.warn('Failed to generate embedding, continuing without it');
      }

      // Calculate importance
      console.log('Calculating importance...');
      const importanceResponse = await fetch(`${supabaseUrl}/functions/v1/calculate-importance`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content, role: 'user' }),
      });

      let importanceScore = null;
      if (importanceResponse.ok) {
        const importanceData = await importanceResponse.json();
        importanceScore = importanceData.importance_score;
        console.log('Importance calculated:', importanceScore);
      } else {
        console.warn('Failed to calculate importance, continuing without it');
      }

      // Insert new entry
      const { data: newEntry, error: insertError } = await supabase
        .from('entries')
        .insert({
          user_id: userId,
          content,
          title: classification.suggestedTitle,
          content_type: classification.type,
          content_subtype: classification.subtype || null,
          tags: classification.tags,
          extracted_data: classification.extractedData || {},
          embedding: embedding ? JSON.stringify(embedding) : null,
          importance_score: importanceScore,
          list_items: classification.listItems || [],
          source,
        })
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
      : `Saved: ${entry!.title || 'Untitled'} · ${classification.type}${entry!.importance_score ? ` · ${entry!.importance_score}/10` : ''}`;

    return new Response(
      JSON.stringify({
        success: true,
        entry: entry!,
        action,
        summary,
        classification,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in smart-save function:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error occurred' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
