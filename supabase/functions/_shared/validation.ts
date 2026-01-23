/**
 * Shared input validation utilities for Supabase Edge Functions
 * 
 * Provides sanitization and validation helpers to prevent injection attacks.
 */

/**
 * Sanitize a string input by removing null bytes and control characters
 */
export function sanitizeString(input: unknown): string {
  if (typeof input !== 'string') return '';

  return input
    .replace(/\0/g, '') // Remove null bytes
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters
    .trim();
}

/**
 * Validate content length
 */
export function validateContentLength(
  content: string,
  maxLength = 50000
): { valid: boolean; error?: string } {
  if (!content || content.length === 0) {
    return { valid: false, error: 'Content is required' };
  }

  if (content.length > maxLength) {
    return {
      valid: false,
      error: `Content too long (max ${maxLength} characters)`,
    };
  }

  return { valid: true };
}

/**
 * Validate a search query
 */
export function validateSearchQuery(
  query: string | unknown
): { valid: boolean; sanitized?: string; error?: string } {
  if (typeof query !== 'string') {
    return { valid: false, error: 'Query must be a string' };
  }

  const sanitized = sanitizeString(query);

  if (!sanitized || sanitized.length < 1) {
    return { valid: false, error: 'Query is required' };
  }

  if (sanitized.length > 500) {
    return { valid: false, error: 'Query too long (max 500 characters)' };
  }

  // Check for null bytes (shouldn't be there after sanitization, but double-check)
  if (sanitized.includes('\0')) {
    return { valid: false, error: 'Invalid characters in query' };
  }

  return { valid: true, sanitized };
}

/**
 * Escape special characters for SQL LIKE queries
 * Prevents SQL injection in LIKE patterns
 */
export function escapeForLike(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/**
 * Validate a UUID string
 */
export function isValidUUID(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}

/**
 * Validate and parse a numeric value
 */
export function parseNumber(
  value: unknown,
  options: { min?: number; max?: number; default?: number } = {}
): number | null {
  const { min, max, default: defaultValue } = options;

  if (value === undefined || value === null) {
    return defaultValue ?? null;
  }

  const num = typeof value === 'number' ? value : Number(value);

  if (isNaN(num)) {
    return defaultValue ?? null;
  }

  if (min !== undefined && num < min) {
    return min;
  }

  if (max !== undefined && num > max) {
    return max;
  }

  return num;
}

/**
 * Validate an array of strings (e.g., tags)
 */
export function validateStringArray(
  value: unknown,
  options: { maxItems?: number; maxLength?: number } = {}
): { valid: boolean; sanitized?: string[]; error?: string } {
  const { maxItems = 50, maxLength = 100 } = options;

  if (!Array.isArray(value)) {
    return { valid: false, error: 'Expected an array' };
  }

  if (value.length > maxItems) {
    return { valid: false, error: `Too many items (max ${maxItems})` };
  }

  const sanitized: string[] = [];

  for (const item of value) {
    if (typeof item !== 'string') {
      return { valid: false, error: 'All items must be strings' };
    }

    const clean = sanitizeString(item);
    if (clean.length > maxLength) {
      return { valid: false, error: `Item too long (max ${maxLength} characters)` };
    }

    if (clean.length > 0) {
      sanitized.push(clean);
    }
  }

  return { valid: true, sanitized };
}

/**
 * Parse and validate JSON body from request
 */
export async function parseJsonBody<T = Record<string, unknown>>(
  request: Request
): Promise<{ data: T | null; error: string | null }> {
  try {
    const contentType = request.headers.get('content-type');
    if (!contentType?.includes('application/json')) {
      return { data: null, error: 'Content-Type must be application/json' };
    }

    const body = await request.json();
    return { data: body as T, error: null };
  } catch (err) {
    console.error('JSON parse error:', err);
    return { data: null, error: 'Invalid JSON body' };
  }
}
