/**
 * Shared Anthropic Claude API utilities
 * 
 * Provides typed helpers for calling Claude, parsing tool use responses,
 * and tracking costs.
 */

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

// Model IDs empirically probed against api.anthropic.com on 2026-04-18
// (probe: supabase/functions/ct-opus-probe). Results:
//   200 OK: claude-opus-4-7, claude-opus-4-6, claude-opus-4-5,
//           claude-opus-4-1, claude-opus-4-1-20250805, claude-opus-4-20250514
//   404:   claude-opus-4-7-<date-guesses>, claude-opus-4-6-20251001,
//           claude-opus-4-5-20250929, claude-opus-4
// Primary: claude-opus-4-7. Fallback cascade documented on opus_fallback.
export const CLAUDE_MODELS = {
  opus: 'claude-opus-4-7',
  // opus_fallback: use when the primary alias is retired. Next-best
  // currently-live Opus (verified 2026-04-18). Cascade from here:
  //   claude-opus-4-6 -> claude-opus-4-5 -> claude-opus-4-1.
  opus_fallback: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-20250514',
  // sonnet_46: PM-tier daily judgment (morning brief, hypothesis proposer,
  // CIO reviews). Latest Sonnet 4.6.
  sonnet_46: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
} as const;

// Model tiers for routing (dispatcher picks, workers consume)
export type ModelTier = 'opus' | 'sonnet' | 'haiku';

export function resolveModel(tier: ModelTier): string {
  return CLAUDE_MODELS[tier] || CLAUDE_MODELS.sonnet;
}

// Cost per 1M tokens (USD)
export const CLAUDE_RATES = {
  [CLAUDE_MODELS.opus]: { input: 15.0, output: 75.0 },
  [CLAUDE_MODELS.opus_fallback]: { input: 15.0, output: 75.0 },
  [CLAUDE_MODELS.sonnet]: { input: 3.0, output: 15.0 },
  [CLAUDE_MODELS.sonnet_46]: { input: 3.0, output: 15.0 },
  [CLAUDE_MODELS.haiku]: { input: 0.80, output: 4.0 },
} as const;

export interface ClaudeMcpServer {
  type: 'url';
  url: string;
  name: string;
  authorization_token?: string;
  /** Optional allowlist of tool names on the MCP server. Omit = all tools. */
  tool_configuration?: { enabled?: boolean; allowed_tools?: string[] };
}

export interface ClaudeOptions {
  model?: string;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  tools?: unknown[];
  tool_choice?: unknown;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  /** Remote MCP servers Claude can query during the turn. Requires beta header. */
  mcp_servers?: ClaudeMcpServer[];
  /** Extra anthropic-beta feature flags (e.g. 'mcp-client-2025-04-04'). */
  beta?: string[];
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ClaudeResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  model: string;
  stop_reason: string;
  usage: ClaudeUsage;
}

export function getAnthropicHeaders(beta?: string[]): Record<string, string> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'Content-Type': 'application/json',
  };
  if (beta && beta.length > 0) {
    headers['anthropic-beta'] = beta.join(',');
  }
  return headers;
}

/**
 * Call Claude API (non-streaming)
 */
export async function callClaude(options: ClaudeOptions): Promise<ClaudeResponse> {
  const {
    model = CLAUDE_MODELS.haiku,
    system,
    messages,
    tools,
    tool_choice,
    max_tokens = 4096,
    temperature = 0.3,
    mcp_servers,
    beta,
  } = options;

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens,
    temperature,
  };

  if (system) body.system = system;
  if (tools) body.tools = tools;
  if (tool_choice) body.tool_choice = tool_choice;
  if (mcp_servers && mcp_servers.length > 0) body.mcp_servers = mcp_servers;

  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: getAnthropicHeaders(beta),
      body: JSON.stringify(body),
    });

    if (response.ok) {
      return await response.json();
    }

    const errorText = await response.text();
    console.error(`Claude API error (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`, response.status, errorText);

    // Propagate a compact slice of the response body into the thrown message so
    // the downstream error sink (heartbeat status_line, decision journal,
    // dashboard) can show the actual reason rather than a bare status code.
    // Anthropic's error bodies are {"type":"error","error":{"type":"...",
    // "message":"..."}} — try to extract `message` and fall back to the raw
    // body. Truncated to 400 chars to stay readable in Slack + heartbeat.
    let detail = '';
    try {
      const parsed = JSON.parse(errorText);
      const msg = parsed?.error?.message ?? parsed?.message ?? '';
      detail = typeof msg === 'string' && msg.length > 0 ? msg : errorText;
    } catch {
      detail = errorText;
    }
    detail = String(detail).slice(0, 400);

    // 4xx errors are permanent — don't retry (auth, billing, bad request)
    if (response.status < 500) {
      if (response.status === 429) {
        throw new ClaudeError(`Rate limit exceeded — ${detail}`, 429);
      }
      if ((response.status === 402 || response.status === 400) &&
          (errorText.includes('credit') || errorText.includes('billing'))) {
        throw new ClaudeError(`API credits exhausted — ${detail}`, 402);
      }
      throw new ClaudeError(`Claude API ${response.status}: ${detail}`, response.status);
    }

    // 5xx errors (500, 502, 503, 529 overloaded) — retry with exponential backoff
    if (attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt); // 1s, 2s, 4s
      console.warn(`Claude API ${response.status}, retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    throw new ClaudeError(`Claude API ${response.status} after ${MAX_RETRIES + 1} attempts: ${detail}`, response.status);
  }

  throw new ClaudeError('Claude API request failed: unknown error', 500);
}

/**
 * Call Claude API with streaming — returns the raw Response for SSE piping
 */
export async function callClaudeStream(options: ClaudeOptions): Promise<Response> {
  const {
    model = CLAUDE_MODELS.haiku,
    system,
    messages,
    max_tokens = 4096,
    temperature = 0.3,
  } = options;

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens,
    temperature,
    stream: true,
  };

  if (system) body.system = system;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: getAnthropicHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Claude streaming error:', response.status, errorText);
    throw new ClaudeError(`Claude streaming failed: ${response.status}`, response.status);
  }

  return response;
}

/**
 * Extract tool_use block from Claude response
 */
export function parseToolUse(response: ClaudeResponse): { name: string; input: Record<string, unknown> } | null {
  const toolBlock = response.content.find(c => c.type === 'tool_use');
  if (!toolBlock || !toolBlock.name || !toolBlock.input) return null;
  return { name: toolBlock.name, input: toolBlock.input as Record<string, unknown> };
}

/**
 * Extract text content from Claude response
 */
export function parseTextContent(response: ClaudeResponse): string {
  const textBlock = response.content.find(c => c.type === 'text');
  return textBlock?.text || '';
}

/**
 * Calculate cost from usage
 */
export function calculateCost(model: string, usage: ClaudeUsage): number {
  const rates = CLAUDE_RATES[model as keyof typeof CLAUDE_RATES];
  if (!rates) return 0;
  return (usage.input_tokens / 1_000_000) * rates.input + (usage.output_tokens / 1_000_000) * rates.output;
}

/**
 * Record token usage and cost on an agent_task row.
 * No-op if taskId is null (e.g., general intent handled inline).
 */
export async function recordTokenUsage(
  supabase: { from: (table: string) => any },
  taskId: string | null | undefined,
  model: string,
  usage: ClaudeUsage
): Promise<void> {
  if (!taskId) return;
  const cost = calculateCost(model, usage);
  try {
    await supabase.from('agent_tasks').update({
      tokens_in: usage.input_tokens,
      tokens_out: usage.output_tokens,
      cost_usd: cost,
    }).eq('id', taskId);
  } catch (err) {
    console.warn('recordTokenUsage failed (non-blocking):', err);
  }
}

export class ClaudeError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ClaudeError';
    this.status = status;
  }
}
