/**
 * Export All Data Edge Function
 * 
 * Exports all user data in various formats (JSON, CSV, Markdown, TXT).
 * Includes entries, reports, and profile data.
 */

import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId, createServiceClient } from '../_shared/auth.ts';
import { checkRateLimit, getRateLimitHeaders } from '../_shared/rateLimit.ts';
import { errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { parseJsonBody } from '../_shared/validation.ts';

interface ExportRequest {
  format?: 'json' | 'csv' | 'markdown' | 'md' | 'txt';
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

    // Rate limiting - limit exports (5 per hour)
    const rateLimitResult = checkRateLimit(`export:${userId}`, { maxRequests: 5, windowMs: 3600000 });
    if (!rateLimitResult.allowed) {
      return new Response(
        JSON.stringify({ error: 'Export rate limit exceeded. Max 5 exports per hour.', retryAfter: Math.ceil(rateLimitResult.resetIn / 1000) }),
        { 
          status: 429, 
          headers: { ...corsHeaders, ...getRateLimitHeaders(rateLimitResult), 'Content-Type': 'application/json' } 
        }
      );
    }

    // Parse format from request body
    const { data: body } = await parseJsonBody<ExportRequest>(req);
    const format = body?.format || 'json';

    console.log(`Exporting data for user: ${userId} in format: ${format}`);

    // Use service role for data access
    const serviceClient = createServiceClient();
    if (!serviceClient) {
      return serverErrorResponse(req, 'Service configuration error');
    }

    // Fetch all entries
    const { data: entries, error: entriesError } = await serviceClient
      .from('entries')
      .select('id, content, title, content_type, content_subtype, tags, extracted_data, importance_score, list_items, starred, archived, source, created_at, updated_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (entriesError) {
      console.error('Error fetching entries:', entriesError);
      return serverErrorResponse(req, 'Failed to fetch entries');
    }

    // Fetch brain reports
    const { data: brainReports, error: reportsError } = await serviceClient
      .from('brain_reports')
      .select('id, report_type, summary, key_themes, decisions, insights, conversation_stats, start_date, end_date, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (reportsError) {
      console.error('Error fetching brain_reports:', reportsError);
      // Don't fail, continue without reports
    }

    // Fetch profile
    const { data: profile } = await serviceClient
      .from('profiles')
      .select('username, created_at, updated_at')
      .eq('id', userId)
      .single();

    const exportData = {
      exportedAt: new Date().toISOString(),
      userId,
      profile: profile || null,
      entries: entries || [],
      brainReports: brainReports || [],
      stats: {
        totalEntries: entries?.length || 0,
        totalReports: brainReports?.length || 0,
        contentTypes: entries?.reduce((acc, e) => {
          acc[e.content_type] = (acc[e.content_type] || 0) + 1;
          return acc;
        }, {} as Record<string, number>) || {},
        starredCount: entries?.filter(e => e.starred).length || 0,
        archivedCount: entries?.filter(e => e.archived).length || 0
      }
    };

    let responseContent: string;
    let contentType: string;
    let filename: string;
    const timestamp = new Date().toISOString().split('T')[0];

    switch (format.toLowerCase()) {
      case 'csv':
        const csvHeaders = ['id', 'title', 'content_type', 'tags', 'importance_score', 'starred', 'created_at'];
        const csvRows = (entries || []).map(e => [
          e.id,
          `"${(e.title || '').replace(/"/g, '""')}"`,
          e.content_type,
          `"${(e.tags || []).join(', ')}"`,
          e.importance_score || 0,
          e.starred ? 'true' : 'false',
          e.created_at
        ].join(','));
        responseContent = [csvHeaders.join(','), ...csvRows].join('\n');
        contentType = 'text/csv';
        filename = `brain-dump-${timestamp}.csv`;
        break;

      case 'markdown':
      case 'md':
        responseContent = generateMarkdown(exportData);
        contentType = 'text/markdown';
        filename = `brain-dump-${timestamp}.md`;
        break;

      case 'txt':
        responseContent = generatePlainText(exportData);
        contentType = 'text/plain';
        filename = `brain-dump-${timestamp}.txt`;
        break;

      case 'json':
      default:
        responseContent = JSON.stringify(exportData, null, 2);
        contentType = 'application/json';
        filename = `brain-dump-${timestamp}.json`;
        break;
    }

    console.log(`Export complete: ${entries?.length || 0} entries, ${brainReports?.length || 0} reports`);

    return new Response(responseContent, {
      headers: {
        ...corsHeaders,
        ...getRateLimitHeaders(rateLimitResult),
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });

  } catch (error) {
    console.error('Error in export-all-data:', error);
    return serverErrorResponse(req, error instanceof Error ? error : 'Unknown error');
  }
});

function generateMarkdown(data: { exportedAt: string; profile?: { username?: string } | null; stats: { totalEntries: number; starredCount: number; archivedCount: number; contentTypes: Record<string, number> }; entries: Array<{ title?: string; content_type: string; content_subtype?: string; importance_score?: number; tags?: string[]; created_at: string; content: string }>; brainReports: Array<{ report_type: string; start_date: string; end_date: string; summary: string }> }): string {
  let md = `# Brain Dump Export\n\n`;
  md += `**Exported:** ${data.exportedAt}\n\n`;
  
  if (data.profile) {
    md += `## Profile\n\n`;
    md += `- Username: ${data.profile.username || 'Not set'}\n\n`;
  }

  md += `## Stats\n\n`;
  md += `- Total Entries: ${data.stats.totalEntries}\n`;
  md += `- Starred: ${data.stats.starredCount}\n`;
  md += `- Archived: ${data.stats.archivedCount}\n\n`;

  if (Object.keys(data.stats.contentTypes).length > 0) {
    md += `### Content Types\n\n`;
    for (const [type, count] of Object.entries(data.stats.contentTypes)) {
      md += `- ${type}: ${count}\n`;
    }
    md += '\n';
  }

  md += `## Entries\n\n`;
  for (const entry of data.entries) {
    md += `### ${entry.title || 'Untitled'}\n\n`;
    md += `- **Type:** ${entry.content_type}${entry.content_subtype ? ` / ${entry.content_subtype}` : ''}\n`;
    md += `- **Importance:** ${entry.importance_score || 'N/A'}\n`;
    md += `- **Tags:** ${(entry.tags || []).join(', ') || 'None'}\n`;
    md += `- **Created:** ${entry.created_at}\n\n`;
    md += `${entry.content}\n\n`;
    md += `---\n\n`;
  }

  if (data.brainReports.length > 0) {
    md += `## Brain Reports\n\n`;
    for (const report of data.brainReports) {
      md += `### ${report.report_type} Report\n\n`;
      md += `**Period:** ${report.start_date} to ${report.end_date}\n\n`;
      md += `${report.summary}\n\n`;
      md += `---\n\n`;
    }
  }

  return md;
}

function generatePlainText(data: { exportedAt: string; stats: { totalEntries: number; starredCount: number; archivedCount: number }; entries: Array<{ content_type: string; title?: string; importance_score?: number; tags?: string[]; created_at: string; content: string }> }): string {
  let txt = `BRAIN DUMP EXPORT\n`;
  txt += `==================\n\n`;
  txt += `Exported: ${data.exportedAt}\n\n`;

  txt += `STATS\n`;
  txt += `-----\n`;
  txt += `Total Entries: ${data.stats.totalEntries}\n`;
  txt += `Starred: ${data.stats.starredCount}\n`;
  txt += `Archived: ${data.stats.archivedCount}\n\n`;

  txt += `ENTRIES\n`;
  txt += `-------\n\n`;
  for (const entry of data.entries) {
    txt += `[${entry.content_type.toUpperCase()}] ${entry.title || 'Untitled'}\n`;
    txt += `Importance: ${entry.importance_score || 'N/A'} | Tags: ${(entry.tags || []).join(', ') || 'None'}\n`;
    txt += `Created: ${entry.created_at}\n\n`;
    txt += `${entry.content}\n\n`;
    txt += `---\n\n`;
  }

  return txt;
}
