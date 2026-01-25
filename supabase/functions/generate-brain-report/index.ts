/**
 * Generate Brain Report Edge Function
 * 
 * Generates periodic summaries and insights from user's entries.
 * Creates weekly/monthly/daily reports with themes, decisions, and analytics.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId, createServiceClient } from '../_shared/auth.ts';
import { checkRateLimit, getRateLimitHeaders } from '../_shared/rateLimit.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { parseJsonBody } from '../_shared/validation.ts';

interface ReportRequest {
  reportType?: 'daily' | 'weekly' | 'monthly';
  startDate?: string;
  endDate?: string;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);

  try {
    // Authenticate user
    const { userId, error: authError } = await extractUserId(req);
    if (authError || !userId) {
      return errorResponse(req, authError || 'Authorization required', 401);
    }

    // Rate limiting - heavy operation (10 per hour)
    const rateLimitResult = checkRateLimit(`report:${userId}`, { maxRequests: 10, windowMs: 3600000 });
    if (!rateLimitResult.allowed) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded. Reports are limited to 10 per hour.', retryAfter: Math.ceil(rateLimitResult.resetIn / 1000) }),
        { 
          status: 429, 
          headers: { ...corsHeaders, ...getRateLimitHeaders(rateLimitResult), 'Content-Type': 'application/json' } 
        }
      );
    }

    // Parse request body
    const { data: body } = await parseJsonBody<ReportRequest>(req);
    const reportType = body?.reportType || 'weekly';
    
    console.log(`Generating ${reportType} report for user: ${userId}`);

    // Use service role for data access
    const serviceClient = createServiceClient();
    if (!serviceClient) {
      return serverErrorResponse(req, 'Service configuration error');
    }

    // Calculate date range
    const now = new Date();
    let reportStartDate: Date;
    let reportEndDate = body?.endDate ? new Date(body.endDate) : now;

    if (body?.startDate) {
      reportStartDate = new Date(body.startDate);
    } else {
      switch (reportType) {
        case 'daily':
          reportStartDate = new Date(now);
          reportStartDate.setHours(0, 0, 0, 0);
          break;
        case 'monthly':
          reportStartDate = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case 'weekly':
        default:
          reportStartDate = new Date(now);
          reportStartDate.setDate(now.getDate() - 7);
          break;
      }
    }

    // Fetch entries within date range
    const { data: entries, error: entriesError } = await serviceClient
      .from('entries')
      .select('id, content, title, content_type, content_subtype, tags, importance_score, starred, created_at')
      .eq('user_id', userId)
      .eq('archived', false)
      .gte('created_at', reportStartDate.toISOString())
      .lte('created_at', reportEndDate.toISOString())
      .order('created_at', { ascending: false });

    if (entriesError) {
      console.error('Error fetching entries:', entriesError);
      return serverErrorResponse(req, 'Failed to fetch entries');
    }

    if (!entries || entries.length === 0) {
      return errorResponse(req, 'No entries found in the specified date range', 404);
    }

    console.log(`Found ${entries.length} entries for report`);

    // Calculate stats
    const stats = {
      totalEntries: entries.length,
      starredCount: entries.filter(e => e.starred).length,
      contentTypes: entries.reduce((acc, e) => {
        acc[e.content_type] = (acc[e.content_type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      topTags: getTopTags(entries),
      avgImportance: entries.reduce((sum, e) => sum + (e.importance_score || 0), 0) / entries.length,
      highPriorityCount: entries.filter(e => (e.importance_score || 0) >= 8).length
    };

    // Generate AI summary
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
    if (!lovableApiKey) {
      return serverErrorResponse(req, 'LOVABLE_API_KEY not configured');
    }

    const entrySummaries = entries.slice(0, 20).map(e => 
      `[${e.content_type}${e.importance_score ? ` importance:${e.importance_score}` : ''}] ${e.title || 'Untitled'}: ${e.content.substring(0, 200)}...`
    ).join('\n');

    const prompt = `Analyze this user's LinkJac entries from the past ${reportType === 'daily' ? 'day' : reportType === 'monthly' ? 'month' : 'week'} and generate a structured report.

Stats:
- Total entries: ${stats.totalEntries}
- High priority (8+): ${stats.highPriorityCount}
- Average importance: ${stats.avgImportance.toFixed(1)}
- Content types: ${Object.entries(stats.contentTypes).map(([k, v]) => `${k}: ${v}`).join(', ')}
- Top tags: ${stats.topTags.join(', ')}

Sample entries:
${entrySummaries}

Generate a report with:
1. A 2-3 sentence executive summary
2. 3-5 key themes or patterns
3. 2-3 notable decisions or commitments mentioned
4. 2-3 actionable insights or recommendations`;

    const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-5-mini',
        messages: [
          { role: 'system', content: 'You are an AI analyst helping users understand patterns in their LinkJac entries. Be concise, insightful, and actionable.' },
          { role: 'user', content: prompt }
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'create_brain_report',
            description: 'Create a structured brain report',
            parameters: {
              type: 'object',
              properties: {
                summary: { type: 'string', description: '2-3 sentence executive summary' },
                key_themes: { 
                  type: 'array', 
                  items: { type: 'string' },
                  description: '3-5 key themes or patterns observed'
                },
                decisions: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '2-3 notable decisions or commitments'
                },
                insights: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '2-3 actionable insights or recommendations'
                }
              },
              required: ['summary', 'key_themes', 'decisions', 'insights']
            }
          }
        }],
        tool_choice: { type: 'function', function: { name: 'create_brain_report' } }
      })
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error('AI API error:', errorText);
      return serverErrorResponse(req, `AI API error: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    console.log('AI response received');

    // Extract structured data from tool call
    let reportData = {
      summary: 'Report generation in progress...',
      key_themes: [] as string[],
      decisions: [] as string[],
      insights: [] as string[]
    };

    if (aiData.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments) {
      try {
        reportData = JSON.parse(aiData.choices[0].message.tool_calls[0].function.arguments);
      } catch (parseError) {
        console.error('Error parsing AI response:', parseError);
      }
    } else if (aiData.choices?.[0]?.message?.content) {
      reportData.summary = aiData.choices[0].message.content;
    }

    // Save report to database
    const { data: savedReport, error: saveError } = await serviceClient
      .from('brain_reports')
      .insert({
        user_id: userId,
        report_type: reportType,
        start_date: reportStartDate.toISOString(),
        end_date: reportEndDate.toISOString(),
        summary: reportData.summary,
        key_themes: reportData.key_themes,
        decisions: reportData.decisions,
        insights: reportData.insights,
        conversation_stats: stats
      })
      .select()
      .single();

    if (saveError) {
      console.error('Error saving report:', saveError);
      return serverErrorResponse(req, 'Failed to save report');
    }

    console.log(`Report saved with ID: ${savedReport.id}`);

    return successResponse(req, { success: true, report: savedReport }, 200, rateLimitResult);

  } catch (error) {
    console.error('Error in generate-brain-report:', error);
    return serverErrorResponse(req, error instanceof Error ? error : 'Unknown error');
  }
});

function getTopTags(entries: { tags?: string[] | null }[]): string[] {
  const tagCounts: Record<string, number> = {};
  for (const entry of entries) {
    for (const tag of (entry.tags || [])) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }
  return Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);
}
