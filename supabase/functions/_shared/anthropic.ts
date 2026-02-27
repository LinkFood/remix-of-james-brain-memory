/**
 * Shared Anthropic Claude API utilities
 * 
 * Provides typed helpers for calling Claude, parsing tool use responses,
 * and tracking costs.
 */

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

export const CLAUDE_MODELS = {
  sonnet: 'claude-sonnet-4-20250514',
  haiku: 'claude-haiku-4-5-20251001',
} as const;

// Cost per 1M tokens (USD)
export const CLAUDE_RATES = {
  [CLAUDE_MODELS.sonnet]: { input: 3.0, output: 15.0 },
  [CLAUDE_MODELS.haiku]: { input: 0.80, output: 4.0 },
} as const;

export interface ClaudeOptions {
  model?: string;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  tools?: unknown[];
  tool_choice?: unknown;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
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

export function getAnthropicHeaders(): Record<string, string> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'Content-Type': 'application/json',
  };
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

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: getAnthropicHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Claude API error:', response.status, errorText);

    if (response.status === 429) {
      throw new ClaudeError('Rate limit exceeded', 429);
    }
    if (response.status === 402 || response.status === 400) {
      // Check if it's a billing error
      if (errorText.includes('credit') || errorText.includes('billing')) {
        throw new ClaudeError('API credits exhausted', 402);
      }
    }
    throw new ClaudeError(`Claude API request failed: ${response.status}`, response.status);
  }

  return await response.json();
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
