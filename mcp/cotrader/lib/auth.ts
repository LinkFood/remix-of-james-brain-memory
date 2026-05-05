// Service-role + URL resolver for the Co-Trader MCP. Boot-time only.
//
// Strategy:
//   1. Prefer env vars (set via `claude mcp add --env ...`). Standard names
//      so the brain organs (configCache.ts, ctEmbed.ts) read the same values
//      via Deno.env.get() at runtime.
//   2. Fallback: shell out to `npx supabase projects api-keys` exactly as
//      scripts/heatmap_backfill.sh does, so operator muscle memory transfers.
//
// The key never leaves process memory. Logged values are length-only.

const PROJECT_REF = 'rvhyotvklfowklzjahdd';
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;

export interface ResolvedAuth {
  supabaseUrl: string;
  serviceRoleKey: string;
  voyageApiKey: string | null;
}

async function fetchServiceRoleKeyFromCli(): Promise<string> {
  const cmd = new Deno.Command('npx', {
    args: ['supabase', 'projects', 'api-keys', '--project-ref', PROJECT_REF],
    stdout: 'piped',
    stderr: 'piped',
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    const err = new TextDecoder().decode(stderr);
    throw new Error(`supabase CLI key fetch failed (exit ${code}): ${err.slice(0, 200)}`);
  }
  const out = new TextDecoder().decode(stdout);
  for (const line of out.split('\n')) {
    if (line.includes('service_role')) {
      const parts = line.trim().split(/\s+/);
      const key = parts[parts.length - 1];
      if (key && key.length > 20) return key;
    }
  }
  throw new Error('supabase CLI returned no service_role line');
}

export async function resolveAuth(): Promise<ResolvedAuth> {
  // Project URL is locked (Tenet 4 — universe + project don't drift).
  // Allow override only for local testing.
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? SUPABASE_URL;

  let serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!serviceRoleKey) {
    console.error('[cotrader-mcp] SUPABASE_SERVICE_ROLE_KEY not set; falling back to npx CLI');
    serviceRoleKey = await fetchServiceRoleKeyFromCli();
  }

  // Brain organs (configCache.ts) read SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
  // via Deno.env.get() at runtime. If they came in via process spawn or
  // CLI fallback, set them so the lazy-init paths see the same values.
  if (!Deno.env.get('SUPABASE_URL')) Deno.env.set('SUPABASE_URL', supabaseUrl);
  if (!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
    Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', serviceRoleKey);
  }

  // VOYAGE_API_KEY is required only when the regime organ runs (default on).
  // We don't fetch it from CLI — Voyage isn't a Supabase secret. Either it's
  // set in the env or include_regime must be false at the tool level.
  const voyageApiKey = Deno.env.get('VOYAGE_API_KEY') ?? null;

  return { supabaseUrl, serviceRoleKey, voyageApiKey };
}
