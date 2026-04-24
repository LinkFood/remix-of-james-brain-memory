/**
 * Unusual Whales MCP client — streamable HTTP transport + JSON-RPC 2.0
 *
 * =============================================================================
 * LIVE PROBE RESULTS — 2026-04-18
 * =============================================================================
 *
 * Candidate endpoints probed (unauth'd POST with initialize):
 *
 *   https://api.unusualwhales.com/mcp      → 404 "Route not found"
 *   https://unusualwhales.com/mcp          → 405 (wrong host, Vercel static)
 *   https://mcp.unusualwhales.com          → 401 — OAuth-required (human login via
 *                                            phx.unusualwhales.com/auth, scopes
 *                                            mcp:tools mcp:resources). Wrong for
 *                                            server-to-server: needs three-legged
 *                                            OAuth, not an API token.
 *   https://api.unusualwhales.com/api/mcp  → 401 "Missing authentication token.
 *                                            Include your api token in the header:
 *                                            Authorization: Bearer YOUR_TOKEN"
 *
 * DISCOVERED ENDPOINT:  https://api.unusualwhales.com/api/mcp
 *
 * Authentication:       Authorization: Bearer <UW_API_KEY>
 *                       (same token used for the REST API — no separate MCP key)
 *
 * Companion header:     UW-CLIENT-API-ID: 100001   (per UW skill.md; carried over
 *                       from uwClient.ts for consistency — UW enforces it on REST
 *                       and it is harmless on MCP)
 *
 * Transport:            MCP "streamable HTTP" (single POST per JSON-RPC message).
 *                       The server may respond with Content-Type application/json
 *                       (single JSON-RPC response) OR text/event-stream (SSE frames).
 *                       We request both via Accept and parse either.
 *
 * Corroborating evidence: ct-mcp-verify uses this exact URL + Bearer auth as an
 * mcp_servers entry on Claude's Messages API (anthropic-beta: mcp-client-2025-04-04)
 * and it works. So the endpoint is already validated in this codebase for MCP.
 *
 * Protocol version: clientInfo requests 2025-06-18 (current stable MCP spec).
 * The server's advertised version is captured on the `initialize` response and
 * forwarded in the Mcp-Session-Id header afterwards (if the server mints one).
 *
 * Rate limit: shares the UW 120 req/min token bucket. Scout runs once per day
 * so it cannot starve the trading path.
 *
 * =============================================================================
 *
 * Exposes 4 primitives over this transport:
 *   - mcpListTools()      → tools/list
 *   - mcpListPrompts()    → prompts/list
 *   - mcpCallTool(n,a)    → tools/call
 *   - mcpGetPrompt(n,a)   → prompts/get (returns first compiled message text)
 *
 * initialize handshake is lazy and cached for the lifetime of one client instance.
 * Each top-level call opens a fresh client so Deno edge-function invocations never
 * leak sessions across requests.
 */

const MCP_URL = 'https://api.unusualwhales.com/api/mcp';
const UW_CLIENT_API_ID = '100001';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// UW rate-limit header capture — MCP responses go through the same API layer
// as REST so they carry the same 5 headers. We flush them into ct_uw_usage
// so the /specialists budget bar reflects MCP traffic as well as REST.
// ---------------------------------------------------------------------------
type UwMcpUsageRow = {
  endpoint: string;
  daily_count: number | null;
  daily_limit: number | null;
  minute_counter: number | null;
  minute_remaining: number | null;
  minute_reset_at: string | null;
  status: number;
  ms: number;
  caller: string | null;
};
let _mcpUsageBuffer: UwMcpUsageRow[] = [];
let _mcpUsageFlushPending = false;
let _mcpCallerTag: string | null = null;
export function setMcpCaller(tag: string): void { _mcpCallerTag = tag.slice(0, 64); }

function parseMinuteReset(v: string | null): string | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) {
    const ms = n > 1e12 ? n : n * 1000;
    return new Date(ms).toISOString();
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function headerNum(res: Response, key: string): number | null {
  const raw = res.headers.get(key);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function recordMcpUsage(endpoint: string, res: Response, ms: number): void {
  const daily_count = headerNum(res, 'x-uw-daily-req-count');
  const daily_limit = headerNum(res, 'x-uw-token-req-limit');
  const minute_counter = headerNum(res, 'x-uw-minute-req-counter');
  const minute_remaining = headerNum(res, 'x-uw-req-per-minute-remaining');
  // Skip handshake / heartbeat frames that carry no rate headers — they'd
  // poison ct_uw_usage_latest with zero rows.
  if (daily_count === null && daily_limit === null && minute_counter === null && minute_remaining === null) return;
  _mcpUsageBuffer.push({
    endpoint,
    daily_count,
    daily_limit,
    minute_counter,
    minute_remaining,
    minute_reset_at: parseMinuteReset(res.headers.get('x-uw-req-per-minute-reset')),
    status: res.status,
    ms,
    caller: _mcpCallerTag,
  });
  if (!_mcpUsageFlushPending) {
    _mcpUsageFlushPending = true;
    setTimeout(flushMcpUsage, 500);
  }
}

async function flushMcpUsage(): Promise<void> {
  const rows = _mcpUsageBuffer;
  _mcpUsageBuffer = [];
  _mcpUsageFlushPending = false;
  if (rows.length === 0) return;
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return;
    await fetch(`${url}/rest/v1/ct_uw_usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(rows),
    });
  } catch { /* swallow */ }
}

function getApiKey(): string {
  // Match uwClient.ts precedence so this client and that one never disagree
  // on which key to use.
  const key = Deno.env.get('UW_API_KEY') ?? Deno.env.get('UNUSUAL_WHALES_API_KEY');
  if (!key) throw new Error('UW_API_KEY (or UNUSUAL_WHALES_API_KEY) not configured in Supabase secrets');
  return key;
}

export class UwMcpError extends Error {
  status: number;
  code?: number | string;
  data?: unknown;
  constructor(message: string, status: number, code?: number | string, data?: unknown) {
    super(message);
    this.name = 'UwMcpError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpPromptArg {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: McpPromptArg[];
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpClientState {
  sessionId: string | null;
  initialized: boolean;
  serverProtocolVersion: string | null;
  serverInfo: { name?: string; version?: string } | null;
  nextId: number;
}

function newState(): McpClientState {
  return { sessionId: null, initialized: false, serverProtocolVersion: null, serverInfo: null, nextId: 1 };
}

/**
 * Parse a response that may be JSON or SSE. MCP streamable-HTTP allows either.
 * For our call pattern (one JSON-RPC request → one response), the SSE stream
 * always contains exactly one `data:` line carrying the JSON-RPC response.
 */
async function parseMcpResponse(res: Response): Promise<JsonRpcResponse> {
  const ct = res.headers.get('content-type') ?? '';
  const text = await res.text();

  if (ct.includes('application/json')) {
    try {
      return JSON.parse(text) as JsonRpcResponse;
    } catch (e) {
      throw new UwMcpError(`MCP JSON parse failed: ${e instanceof Error ? e.message : String(e)}`, res.status, 'parse_error', text.slice(0, 300));
    }
  }

  if (ct.includes('text/event-stream')) {
    // Walk SSE lines, return first `data:` JSON payload that parses as JSON-RPC.
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        const obj = JSON.parse(payload);
        if (obj && obj.jsonrpc === '2.0') return obj as JsonRpcResponse;
      } catch { /* keep looking */ }
    }
    throw new UwMcpError(`MCP SSE contained no JSON-RPC frame (len=${text.length})`, res.status, 'sse_empty', text.slice(0, 300));
  }

  // Unknown content type — try JSON as a last resort.
  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    throw new UwMcpError(`MCP unknown content-type "${ct}" status=${res.status}`, res.status, 'unknown_ct', text.slice(0, 300));
  }
}

/**
 * One JSON-RPC round trip. Handles retries on 5xx + 429, never retries other 4xx
 * (matches uwClient.ts gotcha: "NEVER retry 4xx errors — only 5xx and network").
 */
async function rpc(state: McpClientState, method: string, params?: unknown, isNotification = false): Promise<unknown> {
  const id = state.nextId++;
  const body = isNotification
    ? { jsonrpc: '2.0', method, params: params ?? {} }
    : { jsonrpc: '2.0', id, method, params: params ?? {} };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${getApiKey()}`,
      'UW-CLIENT-API-ID': UW_CLIENT_API_ID,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'User-Agent': 'co-trader/1.0 (linkjac.cloud) mcp-client',
    };
    if (state.sessionId) headers['Mcp-Session-Id'] = state.sessionId;

    let res: Response;
    const startMs = Date.now();
    try {
      res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (netErr) {
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[uwMcpClient] network error on ${method}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms: ${netErr instanceof Error ? netErr.message : netErr}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new UwMcpError(`Network failure on ${method}: ${netErr instanceof Error ? netErr.message : String(netErr)}`, 0, 'network');
    }

    // Capture session id if server minted one on initialize.
    const sid = res.headers.get('mcp-session-id');
    if (sid && !state.sessionId) state.sessionId = sid;

    // UW rate-limit headers — fire-and-forget usage snapshot. Tag method + any
    // tool name so /specialists budget bar can attribute spend per caller.
    try {
      const toolName = (!isNotification && method === 'tools/call' && typeof (params as { name?: unknown })?.name === 'string')
        ? `mcp:${(params as { name: string }).name}`
        : `mcp:${method}`;
      recordMcpUsage(toolName, res, Date.now() - startMs);
    } catch { /* ignore */ }

    // Notifications: server may send 202 Accepted with no body.
    if (isNotification) {
      if (res.ok) return null;
      // fall through to error handling for !ok
    }

    if (res.ok) {
      if (isNotification) return null;
      const parsed = await parseMcpResponse(res);
      if (parsed.error) {
        throw new UwMcpError(
          `MCP ${method} error ${parsed.error.code}: ${parsed.error.message}`,
          res.status,
          parsed.error.code,
          parsed.error.data,
        );
      }
      return parsed.result;
    }

    // 429 — honor Retry-After if present, otherwise back off.
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '');
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : BASE_DELAY_MS * Math.pow(2, attempt);
      console.warn(`[uwMcpClient] 429 on ${method}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    const errText = await res.text().catch(() => '');

    // 4xx (non-429) — never retry.
    if (res.status < 500) {
      console.error(`[uwMcpClient] ${method} → ${res.status}: ${errText.slice(0, 300)}`);
      throw new UwMcpError(`MCP ${res.status} on ${method}: ${errText.slice(0, 200)}`, res.status, 'http_4xx', errText.slice(0, 300));
    }

    // 5xx — exponential backoff.
    if (attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      console.warn(`[uwMcpClient] ${method} → ${res.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    throw new UwMcpError(`MCP ${res.status} on ${method} after ${MAX_RETRIES + 1} attempts: ${errText.slice(0, 200)}`, res.status, 'http_5xx', errText.slice(0, 300));
  }

  throw new UwMcpError(`MCP ${method}: unknown error`, 500, 'unknown');
}

async function initialize(state: McpClientState): Promise<void> {
  if (state.initialized) return;

  const result = await rpc(state, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'co-trader-uw-mcp-client', version: '1.0.0' },
  }) as {
    protocolVersion?: string;
    serverInfo?: { name?: string; version?: string };
    capabilities?: unknown;
  };

  state.serverProtocolVersion = result?.protocolVersion ?? null;
  state.serverInfo = result?.serverInfo ?? null;

  // Per MCP spec, client sends notifications/initialized after initialize.
  // We try best-effort; a server that rejects it still lets us proceed.
  try {
    await rpc(state, 'notifications/initialized', {}, true);
  } catch (e) {
    console.warn('[uwMcpClient] notifications/initialized failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  state.initialized = true;
}

function coerceTools(result: unknown): McpTool[] {
  const r = result as { tools?: unknown };
  if (!Array.isArray(r?.tools)) return [];
  return (r.tools as Array<Record<string, unknown>>)
    .filter(t => typeof t?.name === 'string')
    .map(t => ({
      name: t.name as string,
      description: typeof t.description === 'string' ? t.description : undefined,
      inputSchema: (t.inputSchema && typeof t.inputSchema === 'object') ? t.inputSchema as Record<string, unknown> : undefined,
    }));
}

function coercePrompts(result: unknown): McpPrompt[] {
  const r = result as { prompts?: unknown };
  if (!Array.isArray(r?.prompts)) return [];
  return (r.prompts as Array<Record<string, unknown>>)
    .filter(p => typeof p?.name === 'string')
    .map(p => ({
      name: p.name as string,
      description: typeof p.description === 'string' ? p.description : undefined,
      arguments: Array.isArray(p.arguments) ? (p.arguments as Array<Record<string, unknown>>)
        .filter(a => typeof a?.name === 'string')
        .map(a => ({
          name: a.name as string,
          description: typeof a.description === 'string' ? a.description : undefined,
          required: !!a.required,
        })) : undefined,
    }));
}

/**
 * List every tool the UW MCP server advertises. Handles `nextCursor` pagination
 * transparently — returns the flattened list.
 */
export async function mcpListTools(): Promise<McpTool[]> {
  const state = await getSharedState();

  const out: McpTool[] = [];
  let cursor: string | undefined = undefined;
  let guard = 0;
  do {
    const result = await rpc(state, 'tools/list', cursor ? { cursor } : undefined) as { tools?: unknown; nextCursor?: string };
    out.push(...coerceTools(result));
    cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : undefined;
    if (++guard > 50) throw new UwMcpError('mcpListTools: pagination guard tripped (>50 pages)', 500, 'pagination_runaway');
  } while (cursor);
  return out;
}

/**
 * List every prompt template the UW MCP server advertises. Same pagination
 * handling as mcpListTools.
 */
export async function mcpListPrompts(): Promise<McpPrompt[]> {
  const state = await getSharedState();

  const out: McpPrompt[] = [];
  let cursor: string | undefined = undefined;
  let guard = 0;
  do {
    const result = await rpc(state, 'prompts/list', cursor ? { cursor } : undefined) as { prompts?: unknown; nextCursor?: string };
    out.push(...coercePrompts(result));
    cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : undefined;
    if (++guard > 50) throw new UwMcpError('mcpListPrompts: pagination guard tripped (>50 pages)', 500, 'pagination_runaway');
  } while (cursor);
  return out;
}

/**
 * Module-scoped cached client state for the lifetime of one edge-function
 * isolate. Initializing on every `mcpCallTool` call doubles our UW rate-limit
 * budget (initialize + tools/call = 2 requests per logical op), which at 120
 * req/min is the difference between a tech-indicators ingester that finishes
 * and one that 429-storms. Per edge-function isolate boot we initialize once
 * and reuse. Isolates are already scoped per-invocation by Supabase — session
 * leakage across requests is not possible.
 */
let _sharedState: McpClientState | null = null;
async function getSharedState(): Promise<McpClientState> {
  if (_sharedState && _sharedState.initialized) return _sharedState;
  _sharedState = newState();
  await initialize(_sharedState);
  return _sharedState;
}

/**
 * Call a tool by name. Returns the raw MCP tool result object — caller decides
 * how to interpret the content blocks.
 */
export async function mcpCallTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const state = await getSharedState();
  return await rpc(state, 'tools/call', { name, arguments: args });
}

/**
 * Convenience wrapper for ingester migration (Wave N).
 *
 * MCP `tools/call` returns shape:
 *   { content: [{ type: 'text', text: '<JSON string>' }, ...], isError?: bool, structuredContent?: ... }
 *
 * Legacy uwClient wrappers returned JSON objects like `{ data: [...] }` —
 * ingesters build rows off that shape. This helper:
 *   1. Calls the MCP tool.
 *   2. Throws UwMcpError if isError=true.
 *   3. Prefers `structuredContent` when the server ships it.
 *   4. Else concatenates `content[*].text` blocks and parses the first
 *      well-formed JSON object/array out of them.
 *   5. Returns the parsed payload. Ingester dedupe logic can then run
 *      unchanged (extractData(raw) keeps working whether the shape is
 *      `{data: [...]}`, `{data: {...}}`, or a bare array).
 *
 * If parsing fails, wraps the failure in UwMcpError('mcp_shape') so the
 * ingester's catch can fall back to its legacy HTTP path with a clear
 * diagnostic.
 */
export async function mcpCallToolAsData(
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const result = await mcpCallTool(name, args) as {
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  };

  if (result?.isError) {
    // Pull the first text block as the error message if present.
    const firstText = Array.isArray(result.content)
      ? result.content.find(b => b?.type === 'text' && typeof b.text === 'string')?.text
      : null;
    throw new UwMcpError(`MCP tool ${name} returned isError=true: ${firstText ?? '(no text)'}`, 200, 'tool_error', result);
  }

  // Prefer structuredContent — spec-compliant, unambiguous.
  // UW's MCP server wraps successful tool output as
  //   structuredContent: { result: [...] | {...} }
  // We unwrap the `result` key and re-shape to legacy `{data: ...}` so
  // ingester `extractData()` helpers keep working. If `result` isn't there
  // for some tool, fall back to returning structuredContent as-is.
  if (result?.structuredContent !== undefined && result.structuredContent !== null) {
    const sc = result.structuredContent as { result?: unknown };
    if (sc && typeof sc === 'object' && 'result' in sc) {
      const r = sc.result;
      if (Array.isArray(r)) return { data: r };
      if (r !== null && typeof r === 'object') return { data: r };
      // Primitive or null result — return wrapped.
      return { data: r };
    }
    return result.structuredContent;
  }

  // Fall back to joined text blocks → parse as JSON.
  const texts: string[] = [];
  if (Array.isArray(result?.content)) {
    for (const b of result.content) {
      if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    }
  }
  const joined = texts.join('').trim();
  if (!joined) {
    throw new UwMcpError(`MCP tool ${name} returned no content blocks`, 200, 'mcp_shape', result);
  }

  // First attempt: straight JSON.parse.
  let parsed: unknown;
  try { parsed = JSON.parse(joined); }
  catch {
    // Second attempt: extract first {...} or [...] substring.
    const objMatch = joined.match(/[\{\[][\s\S]*[\}\]]/);
    if (objMatch) {
      try { parsed = JSON.parse(objMatch[0]); } catch { /* fall through */ }
    }
  }
  if (parsed === undefined) {
    throw new UwMcpError(`MCP tool ${name} payload not JSON-parseable: ${joined.slice(0, 200)}`, 200, 'mcp_shape', result);
  }

  // UW's MCP server often returns a bare JSON array at the top level
  // (observed in `ct_mcp_calls` live traffic, 2026-04-17). The legacy REST
  // client always returned `{data: [...]}`, and ingester `extractData()`
  // helpers look for `.data`. Normalize so migration is drop-in: if the
  // parsed payload is a bare array, wrap it; if it's an object that already
  // has a `data` key (or looks like a single-object response), return as-is.
  if (Array.isArray(parsed)) return { data: parsed };
  return parsed;
}

/**
 * Fetch a compiled prompt. Returns the joined user-message text from the prompt
 * result (the common use-case for a prompt template). Falls back to JSON string
 * if the result is not shaped as expected.
 */
export async function mcpGetPrompt(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const state = await getSharedState();
  const result = await rpc(state, 'prompts/get', { name, arguments: args }) as {
    messages?: Array<{ role?: string; content?: { type?: string; text?: string } | Array<{ type?: string; text?: string }> }>;
  };

  const messages = Array.isArray(result?.messages) ? result!.messages : [];
  const chunks: string[] = [];
  for (const m of messages) {
    const c = m?.content;
    if (!c) continue;
    if (Array.isArray(c)) {
      for (const part of c) if (part?.type === 'text' && typeof part.text === 'string') chunks.push(part.text);
    } else if (typeof c === 'object' && c?.type === 'text' && typeof c.text === 'string') {
      chunks.push(c.text);
    }
  }
  return chunks.length ? chunks.join('\n\n') : JSON.stringify(result);
}

/**
 * Predicate for callers that want to treat UW rate-limit hits differently
 * from other MCP failures. The UW 120 req/min bucket is SHARED with the
 * legacy REST path — falling back to REST on a 429 just burns another
 * request on the same saturated bucket.
 */
export function isUwRateLimit(err: unknown): boolean {
  if (!(err instanceof UwMcpError)) return false;
  return err.status === 429 || /429/.test(err.message) || /rate limit/i.test(err.message);
}

// Re-export the discovered endpoint so scout fn can put it in telemetry.
export const UW_MCP_ENDPOINT = MCP_URL;
export const UW_MCP_PROTOCOL_VERSION = MCP_PROTOCOL_VERSION;
