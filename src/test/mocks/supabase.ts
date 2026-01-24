/**
 * Supabase mock utilities for testing
 * 
 * Provides mock implementations for:
 * - Database queries (from().select/insert/update/delete)
 * - Edge function invocations (functions.invoke)
 * - Realtime subscriptions (channel)
 */

import { vi, Mock } from 'vitest';

// ============= Types =============

interface MockQueryResult<T = unknown> {
  data: T | null;
  error: Error | null;
}

interface MockChain {
  select: Mock;
  insert: Mock;
  update: Mock;
  delete: Mock;
  eq: Mock;
  lt: Mock;
  order: Mock;
  limit: Mock;
  single: Mock;
}

interface MockChannel {
  on: Mock;
  subscribe: Mock;
}

// ============= Query Chain Builder =============

/**
 * Creates a chainable mock for Supabase query operations
 */
export function createMockQueryChain(result: MockQueryResult = { data: null, error: null }): MockChain {
  const chain: MockChain = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
    single: vi.fn().mockResolvedValue(result),
  };

  // Make the chain itself thenable for direct await
  Object.assign(chain, {
    then: (resolve: (value: MockQueryResult) => void) => resolve(result),
  });

  return chain;
}

/**
 * Creates a mock for supabase.from() that returns chainable methods
 */
export function createMockFrom(result: MockQueryResult = { data: null, error: null }) {
  const chain = createMockQueryChain(result);
  return vi.fn().mockReturnValue(chain);
}

// ============= Functions Mock =============

interface MockFunctionsResult {
  data: unknown;
  error: Error | null;
}

/**
 * Creates a mock for supabase.functions.invoke()
 */
export function createMockFunctionsInvoke(result: MockFunctionsResult = { data: null, error: null }) {
  return {
    invoke: vi.fn().mockResolvedValue(result),
  };
}

// ============= Channel Mock =============

/**
 * Creates a mock for supabase.channel() with realtime subscriptions
 */
export function createMockChannel(): MockChannel {
  const channel: MockChannel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
  };
  return channel;
}

/**
 * Creates a mock for supabase.removeChannel()
 */
export function createMockRemoveChannel() {
  return vi.fn();
}

// ============= Full Client Mock =============

interface MockSupabaseClient {
  from: Mock;
  functions: {
    invoke: Mock;
  };
  channel: Mock;
  removeChannel: Mock;
}

/**
 * Creates a complete mock Supabase client
 */
export function createMockSupabaseClient(options?: {
  queryResult?: MockQueryResult;
  functionsResult?: MockFunctionsResult;
}): MockSupabaseClient {
  const channel = createMockChannel();
  
  return {
    from: createMockFrom(options?.queryResult),
    functions: createMockFunctionsInvoke(options?.functionsResult),
    channel: vi.fn().mockReturnValue(channel),
    removeChannel: createMockRemoveChannel(),
  };
}

// ============= Mock Data Factories =============

/**
 * Creates a mock entry for testing
 */
export function createMockEntry(overrides: Partial<{
  id: string;
  user_id: string;
  content: string;
  title: string | null;
  content_type: string;
  tags: string[];
  importance_score: number | null;
  starred: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
  list_items: unknown[];
  extracted_data: Record<string, unknown>;
}> = {}) {
  return {
    id: 'test-entry-id',
    user_id: 'test-user-id',
    content: 'Test content',
    title: 'Test Title',
    content_type: 'note',
    content_subtype: null,
    tags: ['test'],
    importance_score: 5,
    starred: false,
    archived: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    list_items: null,
    extracted_data: null,
    image_url: null,
    source: 'web',
    event_date: null,
    event_time: null,
    is_recurring: null,
    recurrence_pattern: null,
    embedding: null,
    ...overrides,
  };
}

/**
 * Creates multiple mock entries
 */
export function createMockEntries(count: number, userId = 'test-user-id') {
  return Array.from({ length: count }, (_, i) => 
    createMockEntry({
      id: `entry-${i}`,
      user_id: userId,
      title: `Entry ${i}`,
      content: `Content for entry ${i}`,
      created_at: new Date(Date.now() - i * 1000 * 60 * 60).toISOString(), // 1 hour apart
    })
  );
}
