/**
 * Supabase Management API utility for JAC Agent OS
 *
 * Pure fetch-based wrapper. No npm deps. Uses SUPABASE_MANAGEMENT_PAT from env.
 * Safety: Write operations reject production refs unless explicitly overridden.
 *
 * Follows the same pattern as _shared/github.ts.
 */

const SUPABASE_MGMT_API = 'https://api.supabase.com';

// --- Auth ---

function getHeaders(): Record<string, string> {
  const token = Deno.env.get('SUPABASE_MANAGEMENT_PAT');
  if (!token) throw new Error('SUPABASE_MANAGEMENT_PAT not configured');
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

// --- Production Safety ---

const productionRefs = new Set<string>();

/** Register a project ref as production. All write ops will block it by default. */
export function registerProductionRef(ref: string): void {
  productionRefs.add(ref);
}

/** Check if a ref is registered as production. */
export function isProductionRef(ref: string): boolean {
  return productionRefs.has(ref);
}

/**
 * Guard write operations against production refs.
 * Throws unless allowProduction is explicitly true.
 */
function guardProduction(ref: string, allowProduction?: boolean): void {
  if (isProductionRef(ref) && !allowProduction) {
    throw new Error(
      `SAFETY: Refused write operation on production ref "${ref}". ` +
      `Pass allowProduction: true to override.`
    );
  }
}

// --- SQL Validation ---

const BLOCKED_SQL_PATTERNS = [
  /DROP\s+DATABASE/i,
  /DROP\s+SCHEMA\s+public/i,
  /DISABLE\s+ROW\s+LEVEL\s+SECURITY/i,
  /TRUNCATE\s+(public\.)?(agent_tasks|brain_entries|users|auth\.users)/i,
];

export interface SQLValidationResult {
  allowed: boolean;
  blockedReason?: string;
  warnings: string[];
}

/**
 * Validate migration SQL for dangerous patterns.
 * Returns blocked reason if SQL is unsafe, plus non-blocking warnings.
 */
export function validateMigrationSQL(sql: string): SQLValidationResult {
  const warnings: string[] = [];

  // Check blocked patterns
  for (const pattern of BLOCKED_SQL_PATTERNS) {
    if (pattern.test(sql)) {
      return {
        allowed: false,
        blockedReason: `SQL matches blocked pattern: ${pattern.source}`,
        warnings,
      };
    }
  }

  // Non-blocking warnings
  if (/DROP\s+COLUMN/i.test(sql)) {
    warnings.push('DROP COLUMN detected — data loss if column has data');
  }
  if (/DROP\s+TABLE/i.test(sql)) {
    warnings.push('DROP TABLE detected — verify this is intentional');
  }
  if (/CREATE\s+(TABLE|INDEX)\b/i.test(sql) && !/IF\s+NOT\s+EXISTS/i.test(sql)) {
    warnings.push('CREATE TABLE/INDEX without IF NOT EXISTS — may fail if object exists');
  }

  return { allowed: true, warnings };
}

// --- Read Operations ---

export interface SupabaseFunction {
  id: string;
  slug: string;
  name: string;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
  verify_jwt: boolean;
  import_map: boolean;
}

/** List all edge functions for a project. */
export async function listFunctions(ref: string): Promise<SupabaseFunction[]> {
  const url = `${SUPABASE_MGMT_API}/v1/projects/${ref}/functions`;
  const res = await fetch(url, { headers: getHeaders() });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`List functions failed (${res.status}): ${text.slice(0, 300)}`);
  }

  return await res.json();
}

/** Get a specific edge function by slug. */
export async function getFunction(
  ref: string,
  slug: string
): Promise<SupabaseFunction> {
  const url = `${SUPABASE_MGMT_API}/v1/projects/${ref}/functions/${slug}`;
  const res = await fetch(url, { headers: getHeaders() });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Get function "${slug}" failed (${res.status}): ${text.slice(0, 300)}`);
  }

  return await res.json();
}

export interface ProjectHealth {
  id: string;
  name: string;
  status: string;
  region: string;
  created_at: string;
  database: { host: string; version: string };
}

/** Get project health/status. */
export async function getProjectHealth(ref: string): Promise<ProjectHealth> {
  const url = `${SUPABASE_MGMT_API}/v1/projects/${ref}`;
  const res = await fetch(url, { headers: getHeaders() });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Get project health failed (${res.status}): ${text.slice(0, 300)}`);
  }

  return await res.json();
}

export interface Migration {
  version: string;
  name: string;
  statements: string[];
}

/** List all migrations for a project. */
export async function listMigrations(ref: string): Promise<Migration[]> {
  const url = `${SUPABASE_MGMT_API}/v1/projects/${ref}/database/migrations`;
  const res = await fetch(url, { headers: getHeaders() });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`List migrations failed (${res.status}): ${text.slice(0, 300)}`);
  }

  return await res.json();
}

/** Generate TypeScript types for a project's database schema. */
export async function generateTypes(ref: string): Promise<string> {
  const url = `${SUPABASE_MGMT_API}/v1/projects/${ref}/types/typescript`;
  const res = await fetch(url, { headers: getHeaders() });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Generate types failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.types || '';
}

export interface LogEntry {
  id: string;
  timestamp: number;
  event_message: string;
  metadata: Record<string, unknown>;
}

/** Read logs for a project. */
export async function getLogs(
  ref: string,
  collection: 'edge-logs' | 'postgres-logs' | 'auth-logs' = 'edge-logs',
  hoursAgo = 1
): Promise<LogEntry[]> {
  const isoStart = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
  const isoEnd = new Date().toISOString();
  const params = new URLSearchParams({
    iso_timestamp_start: isoStart,
    iso_timestamp_end: isoEnd,
  });
  const url = `${SUPABASE_MGMT_API}/v1/projects/${ref}/analytics/endpoints/logs.all?${params}`;
  const res = await fetch(url, { headers: getHeaders() });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Get logs failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.result || data || [];
}

// --- Write Operations (production-guarded) ---

export interface DeployOptions {
  allowProduction?: boolean;
  verifyJwt?: boolean;
  importMapPath?: string;
}

export interface DeployFunctionSource {
  name: string;
  content: string;
}

/**
 * Deploy a single edge function.
 * Source files are bundled into a FormData-compatible payload.
 */
export async function deployFunction(
  ref: string,
  slug: string,
  sourceFiles: DeployFunctionSource[],
  opts: DeployOptions = {}
): Promise<{ id: string; slug: string; version: number }> {
  guardProduction(ref, opts.allowProduction);

  if (!slug || !/^[a-z][a-z0-9-]*$/.test(slug)) {
    throw new Error(`Invalid function slug: "${slug}". Must be lowercase alphanumeric with dashes.`);
  }

  if (sourceFiles.length === 0) {
    throw new Error('No source files provided for deployment');
  }

  // Build the source as a single file (index.ts) for the deploy endpoint
  // The Management API v1 deploy expects the function body as multipart form
  const mainSource = sourceFiles.find(f => f.name === 'index.ts') || sourceFiles[0];

  const formData = new FormData();
  const blob = new Blob([mainSource.content], { type: 'application/typescript' });
  formData.append('slug', slug);
  formData.append('name', slug);
  formData.append('verify_jwt', String(opts.verifyJwt ?? false));
  formData.append('body', blob, 'index.ts');

  const token = Deno.env.get('SUPABASE_MANAGEMENT_PAT');
  if (!token) throw new Error('SUPABASE_MANAGEMENT_PAT not configured');

  const url = `${SUPABASE_MGMT_API}/v1/projects/${ref}/functions/${slug}`;

  // Try update first (PUT), fall back to create (POST) if 404
  let res = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData,
  });

  if (res.status === 404) {
    const createUrl = `${SUPABASE_MGMT_API}/v1/projects/${ref}/functions`;
    res = await fetch(createUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    });
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Deploy function "${slug}" failed (${res.status}): ${text.slice(0, 300)}`);
  }

  return await res.json();
}

export interface BulkDeployFunction {
  slug: string;
  sourceFiles: DeployFunctionSource[];
  verifyJwt?: boolean;
}

/**
 * Bulk deploy multiple edge functions.
 * Deploys sequentially to avoid rate limits and allow rollback on failure.
 */
export async function bulkDeployFunctions(
  ref: string,
  functions: BulkDeployFunction[],
  opts: DeployOptions = {}
): Promise<{ deployed: string[]; failed: Array<{ slug: string; error: string }> }> {
  guardProduction(ref, opts.allowProduction);

  const deployed: string[] = [];
  const failed: Array<{ slug: string; error: string }> = [];

  for (const fn of functions) {
    try {
      await deployFunction(ref, fn.slug, fn.sourceFiles, {
        ...opts,
        verifyJwt: fn.verifyJwt,
      });
      deployed.push(fn.slug);
    } catch (err) {
      failed.push({
        slug: fn.slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { deployed, failed };
}

export interface MigrationOptions {
  allowProduction?: boolean;
}

/**
 * Apply a migration to a project's database.
 * Validates SQL before applying. Blocks dangerous patterns.
 */
export async function applyMigration(
  ref: string,
  name: string,
  sql: string,
  opts: MigrationOptions = {}
): Promise<{ version: string; warnings: string[] }> {
  guardProduction(ref, opts.allowProduction);

  // Validate SQL safety
  const validation = validateMigrationSQL(sql);
  if (!validation.allowed) {
    throw new Error(`SAFETY: Migration blocked — ${validation.blockedReason}`);
  }

  if (!name || name.length > 200) {
    throw new Error('Migration name must be 1-200 characters');
  }

  const url = `${SUPABASE_MGMT_API}/v1/projects/${ref}/database/migrations`;
  const res = await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      name,
      statements: [sql],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apply migration "${name}" failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return {
    version: data.version || data.id || 'unknown',
    warnings: validation.warnings,
  };
}
