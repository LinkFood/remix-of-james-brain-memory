/**
 * sync-codebase — Reads key files from a GitHub repo and saves them as brain entries
 *
 * Creates searchable code entries (content_type: 'code', source: 'code-sync')
 * so the brain can answer questions about the codebase.
 *
 * Called:
 * - By jac-code-agent after a PR (fire-and-forget, specific paths)
 * - By pg_cron for full periodic sync of all active projects
 * - Manually via service role
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { getRepoTree, getFileContent, isSecretFile } from '../_shared/github.ts';

// File extensions worth embedding
const INCLUDE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'py', 'sql', 'md',
  'json', 'toml', 'yaml', 'yml',
]);

// Config files to always include even if extension isn't in the set
const INCLUDE_NAMES = new Set([
  'package.json', 'tsconfig.json', 'vite.config.ts', 'tailwind.config.js',
  'tailwind.config.ts', 'supabase/config.toml', 'CLAUDE.md', 'README.md',
]);

// Directories/patterns to always skip
const EXCLUDE_PATTERNS = [
  /^node_modules\//,
  /^dist\//,
  /^\.next\//,
  /^build\//,
  /^\.git\//,
  /^coverage\//,
  /^__pycache__\//,
  /\.min\.js$/,
  /\.min\.css$/,
  /\.map$/,
  /\.lock$/,
  /lock\.json$/,
  /\.d\.ts$/,
  /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|mp3|mp4)$/i,
];

function shouldIncludeFile(path: string): boolean {
  // Always exclude secret files
  if (isSecretFile(path)) return false;

  // Check exclude patterns
  if (EXCLUDE_PATTERNS.some(p => p.test(path))) return false;

  // Check named includes
  if (INCLUDE_NAMES.has(path)) return true;

  // Check extension
  const ext = path.split('.').pop()?.toLowerCase();
  if (!ext) return false;
  return INCLUDE_EXTENSIONS.has(ext);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized — service role required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const body = await req.json();
    const projectId = body.projectId as string;
    const pathsFilter = (body.paths as string[] | undefined) || null;
    const userId = body.userId as string | undefined;

    if (!projectId) {
      return new Response(JSON.stringify({ error: 'projectId required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Load project
    const { data: project, error: projError } = await supabase
      .from('code_projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (projError || !project) {
      return new Response(JSON.stringify({ error: `Project not found: ${projectId}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const repoFull = project.repo_full_name as string;
    const defaultBranch = (project.default_branch as string) || 'main';
    const [owner, repo] = repoFull.split('/');
    const ownerId = userId || (project.user_id as string);

    if (!owner || !repo) {
      return new Response(JSON.stringify({ error: `Invalid repo: ${repoFull}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get file tree
    const fullTree = await getRepoTree(owner, repo, defaultBranch);

    // Filter to syncable files
    let filesToSync: string[];
    if (pathsFilter && pathsFilter.length > 0) {
      // Only sync specific paths (e.g., after a commit)
      filesToSync = pathsFilter.filter(shouldIncludeFile);
    } else {
      // Full sync — filter tree
      filesToSync = fullTree.filter(shouldIncludeFile);
    }

    // Cap at 100 files per sync to avoid timeouts
    filesToSync = filesToSync.slice(0, 100);

    let synced = 0;
    let errors = 0;

    // Process files in batches of 5
    for (let i = 0; i < filesToSync.length; i += 5) {
      const batch = filesToSync.slice(i, i + 5);
      const results = await Promise.all(
        batch.map(async (filePath) => {
          try {
            const file = await getFileContent(owner, repo, filePath, defaultBranch);
            const ext = filePath.split('.').pop()?.toLowerCase() || '';
            const dirName = filePath.includes('/') ? filePath.split('/').slice(-2, -1)[0] : '';
            const tags = [repo, ext, dirName].filter(Boolean);

            // Upsert: use repo + path as unique key via extracted_data match
            // First try to find existing entry
            const { data: existing } = await supabase
              .from('entries')
              .select('id')
              .eq('user_id', ownerId)
              .eq('source', 'code-sync')
              .eq('title', filePath)
              .contains('extracted_data', { repo: repoFull })
              .limit(1)
              .single();

            const entryData = {
              user_id: ownerId,
              content: file.content,
              title: filePath,
              content_type: 'code',
              tags,
              extracted_data: { repo: repoFull, path: filePath, branch: defaultBranch, sha: file.sha },
              source: 'code-sync',
              embedding: null, // backfill-embeddings will handle this
            };

            if (existing) {
              await supabase
                .from('entries')
                .update({ ...entryData, updated_at: new Date().toISOString() })
                .eq('id', existing.id);
            } else {
              await supabase
                .from('entries')
                .insert(entryData);
            }

            return true;
          } catch (err) {
            console.warn(`[sync-codebase] Failed to sync ${filePath}:`, err);
            return false;
          }
        })
      );

      for (const ok of results) {
        if (ok) synced++;
        else errors++;
      }
    }

    // Clean up stale entries — files that no longer exist in the repo
    if (!pathsFilter) {
      const syncedPaths = new Set(filesToSync);
      const { data: existingEntries } = await supabase
        .from('entries')
        .select('id, title')
        .eq('user_id', ownerId)
        .eq('source', 'code-sync')
        .contains('extracted_data', { repo: repoFull });

      if (existingEntries) {
        const staleIds = existingEntries
          .filter((e: { id: string; title: string }) => !fullTree.includes(e.title) || !syncedPaths.has(e.title))
          .map((e: { id: string }) => e.id);

        if (staleIds.length > 0) {
          await supabase
            .from('entries')
            .delete()
            .in('id', staleIds);
          console.log(`[sync-codebase] Cleaned up ${staleIds.length} stale entries for ${repoFull}`);
        }
      }
    }

    // Update last_synced_at on project
    await supabase
      .from('code_projects')
      .update({ last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', projectId);

    return new Response(JSON.stringify({
      success: true,
      synced,
      errors,
      totalFiles: filesToSync.length,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[sync-codebase] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Sync failed',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
