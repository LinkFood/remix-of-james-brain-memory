/**
 * read-file — Read a single file from a registered GitHub project
 *
 * Used by the Code Workspace frontend to display file contents.
 * Requires user JWT auth — validates the user owns the project.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId } from '../_shared/auth.ts';
import { getFileContent, isSecretFile } from '../_shared/github.ts';

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);
  const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const { userId, error: authError } = await extractUserId(req);
    if (authError || !userId) {
      return new Response(JSON.stringify({ error: authError ?? 'Unauthorized' }), {
        status: 401, headers: jsonHeaders,
      });
    }

    const body = await req.json();
    const projectId = body.projectId as string;
    const filePath = body.path as string;

    if (!projectId || !filePath) {
      return new Response(JSON.stringify({ error: 'projectId and path required' }), {
        status: 400, headers: jsonHeaders,
      });
    }

    if (isSecretFile(filePath)) {
      return new Response(JSON.stringify({ error: 'Cannot read secret files' }), {
        status: 403, headers: jsonHeaders,
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Verify user owns this project
    const { data: project, error: projError } = await supabase
      .from('code_projects')
      .select('repo_full_name, default_branch')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single();

    if (projError || !project) {
      return new Response(JSON.stringify({ error: 'Project not found' }), {
        status: 404, headers: jsonHeaders,
      });
    }

    const repoFull = project.repo_full_name as string;
    const defaultBranch = (project.default_branch as string) || 'main';
    const [owner, repo] = repoFull.split('/');

    if (!owner || !repo) {
      return new Response(JSON.stringify({ error: 'Invalid repo configuration' }), {
        status: 400, headers: jsonHeaders,
      });
    }

    const file = await getFileContent(owner, repo, filePath, defaultBranch);

    return new Response(JSON.stringify({
      path: file.path,
      content: file.content,
      sha: file.sha,
    }), { status: 200, headers: jsonHeaders });

  } catch (error) {
    console.error('[read-file] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Failed to read file',
    }), {
      status: 500,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });
  }
});
