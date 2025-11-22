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
      throw new Error('Missing userId');
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Fetch all user data
    const { data: conversations, error: convError } = await supabaseClient
      .from('conversations')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (convError) throw convError;

    const { data: messages, error: msgError } = await supabaseClient
      .from('messages')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (msgError) throw msgError;

    const { data: reports, error: repError } = await supabaseClient
      .from('brain_reports')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (repError) throw repError;

    const exportData = {
      exported_at: new Date().toISOString(),
      user_id: userId,
      conversations: conversations || [],
      messages: messages || [],
      brain_reports: reports || [],
      stats: {
        total_conversations: conversations?.length || 0,
        total_messages: messages?.length || 0,
        total_reports: reports?.length || 0,
      }
    };

    let content: string;
    let contentType: string;
    let filename: string;
    const timestamp = new Date().toISOString().split('T')[0];

    switch (format.toLowerCase()) {
      case 'json':
        content = JSON.stringify(exportData, null, 2);
        contentType = 'application/json';
        filename = `memory-vault-${timestamp}.json`;
        break;

      case 'csv':
        // Convert messages to CSV format
        const csvRows = [
          ['Timestamp', 'Role', 'Content', 'Conversation ID', 'Topic', 'Importance', 'Provider', 'Model'].join(','),
          ...messages.map(msg => [
            msg.created_at,
            msg.role,
            `"${msg.content.replace(/"/g, '""')}"`, // Escape quotes
            msg.conversation_id,
            msg.topic || '',
            msg.importance_score || '',
            msg.provider || '',
            msg.model_used || '',
          ].join(','))
        ];
        content = csvRows.join('\n');
        contentType = 'text/csv';
        filename = `memory-vault-${timestamp}.csv`;
        break;

      case 'markdown':
      case 'md':
        // Convert to Markdown format
        const mdLines = [
          `# Memory Vault Export`,
          `Exported: ${new Date().toLocaleString()}`,
          ``,
          `## Summary`,
          `- Total Conversations: ${conversations?.length || 0}`,
          `- Total Messages: ${messages?.length || 0}`,
          `- Total Reports: ${reports?.length || 0}`,
          ``,
          `---`,
          ``,
        ];

        conversations?.forEach(conv => {
          mdLines.push(`## ${conv.title || 'Untitled Conversation'}`);
          mdLines.push(`*Created: ${new Date(conv.created_at).toLocaleString()}*`);
          mdLines.push('');

          const convMessages = messages?.filter(m => m.conversation_id === conv.id) || [];
          convMessages.forEach(msg => {
            const role = msg.role === 'user' ? '**You**' : '*Assistant*';
            mdLines.push(`### ${role} (${new Date(msg.created_at).toLocaleString()})`);
            if (msg.importance_score) {
              mdLines.push(`*Importance: ${msg.importance_score}/10*`);
            }
            mdLines.push('');
            mdLines.push(msg.content);
            mdLines.push('');
          });

          mdLines.push('---');
          mdLines.push('');
        });

        content = mdLines.join('\n');
        contentType = 'text/markdown';
        filename = `memory-vault-${timestamp}.md`;
        break;

      case 'txt':
        // Convert to plain text format
        const txtLines = [
          `MEMORY VAULT EXPORT`,
          `Exported: ${new Date().toLocaleString()}`,
          ``,
          `SUMMARY`,
          `Total Conversations: ${conversations?.length || 0}`,
          `Total Messages: ${messages?.length || 0}`,
          `Total Reports: ${reports?.length || 0}`,
          ``,
          `${'='.repeat(80)}`,
          ``,
        ];

        conversations?.forEach(conv => {
          txtLines.push(`CONVERSATION: ${conv.title || 'Untitled'}`);
          txtLines.push(`Created: ${new Date(conv.created_at).toLocaleString()}`);
          txtLines.push('');

          const convMessages = messages?.filter(m => m.conversation_id === conv.id) || [];
          convMessages.forEach(msg => {
            const role = msg.role === 'user' ? 'YOU' : 'ASSISTANT';
            txtLines.push(`[${role}] ${new Date(msg.created_at).toLocaleString()}`);
            if (msg.importance_score) {
              txtLines.push(`Importance: ${msg.importance_score}/10`);
            }
            txtLines.push('');
            txtLines.push(msg.content);
            txtLines.push('');
            txtLines.push('-'.repeat(80));
            txtLines.push('');
          });

          txtLines.push('='.repeat(80));
          txtLines.push('');
        });

        content = txtLines.join('\n');
        contentType = 'text/plain';
        filename = `memory-vault-${timestamp}.txt`;
        break;

      default:
        throw new Error(`Unsupported format: ${format}`);
    }

    return new Response(content, {
      headers: {
        ...corsHeaders,
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error('Error in export-all-data function:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
