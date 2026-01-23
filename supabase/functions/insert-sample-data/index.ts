/**
 * Insert Sample Data Edge Function
 * 
 * Populates user account with sample entries for demonstration.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId } from '../_shared/auth.ts';
import { checkRateLimit, getRateLimitHeaders } from '../_shared/rateLimit.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';

Deno.serve(async (req) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);

  try {
    // Authenticate user
    const { userId, error: authError, supabase } = await extractUserId(req);
    if (authError || !userId || !supabase) {
      return errorResponse(req, authError || 'Authorization required', 401);
    }

    // Rate limiting - limit to prevent abuse
    const rateLimitResult = checkRateLimit(`sample:${userId}`, { maxRequests: 3, windowMs: 3600000 });
    if (!rateLimitResult.allowed) {
      return new Response(
        JSON.stringify({ error: 'Sample data can only be inserted 3 times per hour.', retryAfter: Math.ceil(rateLimitResult.resetIn / 1000) }),
        { 
          status: 429, 
          headers: { ...corsHeaders, ...getRateLimitHeaders(rateLimitResult), 'Content-Type': 'application/json' } 
        }
      );
    }

    console.log(`Inserting sample entries for user: ${userId}`);

    // Sample entries covering different content types
    const sampleEntries = [
      {
        content: `function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

// Memoized version for better performance
const memo = new Map<number, number>();
function fibMemo(n: number): number {
  if (memo.has(n)) return memo.get(n)!;
  if (n <= 1) return n;
  const result = fibMemo(n - 1) + fibMemo(n - 2);
  memo.set(n, result);
  return result;
}`,
        title: 'Fibonacci with Memoization',
        content_type: 'code',
        content_subtype: 'typescript',
        tags: ['algorithms', 'typescript', 'optimization', 'recursion'],
        importance_score: 7,
        created_at: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        content: `- Eggs
- Milk (oat milk)
- Bread (sourdough)
- Avocados
- Cherry tomatoes
- Greek yogurt
- Bananas
- Coffee beans
- Olive oil`,
        title: 'Weekly Groceries',
        content_type: 'list',
        content_subtype: 'shopping',
        tags: ['groceries', 'food', 'weekly'],
        importance_score: 5,
        list_items: [
          { text: 'Eggs', checked: false },
          { text: 'Milk (oat milk)', checked: false },
          { text: 'Bread (sourdough)', checked: true },
          { text: 'Avocados', checked: false },
          { text: 'Cherry tomatoes', checked: false },
          { text: 'Greek yogurt', checked: false },
          { text: 'Bananas', checked: true },
          { text: 'Coffee beans', checked: false },
          { text: 'Olive oil', checked: false },
        ],
        created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        content: `What if we built an AI that learns your personal context over time? Not just chat history, but actual semantic understanding of your preferences, projects, and thinking patterns. A "second brain" that compounds in value the more you use it. Could integrate with all AI providers as a context layer.`,
        title: 'Second Brain AI Concept',
        content_type: 'idea',
        content_subtype: null,
        tags: ['ai', 'product-idea', 'startup', 'innovation'],
        importance_score: 9,
        created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        content: 'https://arxiv.org/abs/2312.00752 - "Retrieval-Augmented Generation for Large Language Models: A Survey" - Comprehensive overview of RAG techniques, chunking strategies, and embedding approaches. Really useful for the vector search implementation.',
        title: 'RAG Survey Paper',
        content_type: 'link',
        content_subtype: 'article',
        tags: ['research', 'ai', 'rag', 'embeddings', 'reading-list'],
        importance_score: 8,
        extracted_data: {
          url: 'https://arxiv.org/abs/2312.00752',
          domain: 'arxiv.org',
          type: 'research-paper'
        },
        created_at: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        content: `Sarah Chen - Product Lead at TechCorp
Email: sarah.chen@techcorp.io
Met at ProductCon 2024, interested in AI integration for their platform.
Follow up next week about partnership opportunity.`,
        title: 'Sarah Chen - TechCorp',
        content_type: 'contact',
        content_subtype: null,
        tags: ['networking', 'partnership', 'follow-up'],
        importance_score: 7,
        extracted_data: {
          name: 'Sarah Chen',
          email: 'sarah.chen@techcorp.io',
          company: 'TechCorp',
          role: 'Product Lead'
        },
        created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        content: 'Team standup - Discuss migration timeline and blockers',
        title: 'Team Standup',
        content_type: 'event',
        content_subtype: 'meeting',
        tags: ['work', 'meeting', 'team'],
        importance_score: 6,
        extracted_data: {
          date: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString(),
          recurring: true
        },
        created_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        content: 'Remember to cancel the old hosting subscription before the renewal date on the 15th. Also need to update DNS records after migration.',
        title: 'Cancel Old Hosting',
        content_type: 'reminder',
        content_subtype: null,
        tags: ['infrastructure', 'billing', 'urgent'],
        importance_score: 9,
        created_at: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
      },
      {
        content: `Been thinking about the difference between "building in public" and actually shipping. There's a fine line between transparency and procrastination. The best founders I know ship first, then share learnings. The narrative comes from the work, not the other way around.`,
        title: 'Building in Public Thoughts',
        content_type: 'note',
        content_subtype: 'reflection',
        tags: ['startup', 'philosophy', 'productivity', 'shipping'],
        importance_score: 6,
        created_at: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
      },
      {
        content: `Project Roadmap Q1:
- [ ] Complete database migration
- [ ] Launch semantic search
- [ ] Mobile responsive redesign
- [ ] Public API beta
- [ ] Integration with 3rd party apps`,
        title: 'Q1 Project Roadmap',
        content_type: 'list',
        content_subtype: 'todo',
        tags: ['planning', 'roadmap', 'q1', 'milestones'],
        importance_score: 10,
        list_items: [
          { text: 'Complete database migration', checked: true },
          { text: 'Launch semantic search', checked: false },
          { text: 'Mobile responsive redesign', checked: false },
          { text: 'Public API beta', checked: false },
          { text: 'Integration with 3rd party apps', checked: false },
        ],
        created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        content: `Debugging tip: When React components re-render unexpectedly, use React DevTools Profiler to identify which props changed. Often it's object references being recreated. Solutions: useMemo for computed values, useCallback for functions, or move static objects outside component.`,
        title: 'React Re-render Debugging',
        content_type: 'note',
        content_subtype: 'til',
        tags: ['react', 'debugging', 'performance', 'til'],
        importance_score: 7,
        created_at: new Date().toISOString(),
      },
    ];

    // Insert entries
    let successCount = 0;
    for (const entry of sampleEntries) {
      const { error } = await supabase
        .from('entries')
        .insert({
          user_id: userId,
          ...entry,
          source: 'sample-data',
        });

      if (error) {
        console.error(`Error inserting entry "${entry.title}":`, error);
      } else {
        successCount++;
      }
    }

    console.log(`Successfully inserted ${successCount}/${sampleEntries.length} sample entries`);

    return successResponse(req, { 
      success: true, 
      message: `Inserted ${successCount} sample entries`,
      entries: sampleEntries.map(e => ({ title: e.title, type: e.content_type }))
    }, 200, rateLimitResult);

  } catch (error) {
    console.error('Error inserting sample data:', error);
    return serverErrorResponse(req, error instanceof Error ? error : 'Unknown error');
  }
});
