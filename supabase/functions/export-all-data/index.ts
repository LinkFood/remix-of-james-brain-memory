import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { userId, format = 'json' } = await req.json();

    if (!userId) {
      return new Response(
        JSON.stringify({ error: 'userId is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Exporting data for user: ${userId} in format: ${format}`);

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Fetch all entries
    const { data: entries, error: entriesError } = await supabaseClient
      .from('entries')
      .select('id, content, title, content_type, content_subtype, tags, extracted_data, importance_score, list_items, starred, archived, source, created_at, updated_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (entriesError) {
      console.error('Error fetching entries:', entriesError);
      throw entriesError;
    }

    // Fetch brain reports
    const { data: brainReports, error: reportsError } = await supabaseClient
      .from('brain_reports')
      .select('id, report_type, summary, key_themes, decisions, insights, conversation_stats, start_date, end_date, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (reportsError) {
      console.error('Error fetching brain_reports:', reportsError);
      throw reportsError;
    }

    // Fetch profile
    const { data: profile, error: profileError } = await supabaseClient
      .from('profiles')
      .select('username, created_at, updated_at')
      .eq('id', userId)
      .single();

    if (profileError && profileError.code !== 'PGRST116') {
      console.error('Error fetching profile:', profileError);
    }

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
        // Export entries as CSV
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
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });

  } catch (error) {
    console.error('Error in export-all-data:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function generateMarkdown(data: any): string {
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

function generatePlainText(data: any): string {
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
