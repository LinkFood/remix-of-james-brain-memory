/**
 * Tests for useSearch hook
 * 
 * @module hooks/useSearch.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSearch } from './useSearch';

// Mock supabase client
const mockInvoke = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    functions: {
      invoke: mockInvoke,
    },
  },
}));

// Mock sonner toast
const mockToast = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
};

vi.mock('sonner', () => ({
  toast: mockToast,
}));

// Mock use-debounce
vi.mock('use-debounce', () => ({
  useDebouncedCallback: (fn: (...args: unknown[]) => void) => fn,
}));

describe('useSearch', () => {
  const userId = 'test-user-id';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes with default state', () => {
    const { result } = renderHook(() => useSearch({ userId }));

    expect(result.current.query).toBe('');
    expect(result.current.results).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.useSemanticSearch).toBe(true);
  });

  it('performs search via manual search()', async () => {
    const mockResults = [
      { id: '1', content: 'Result 1', title: 'Title 1' },
      { id: '2', content: 'Result 2', title: 'Title 2' },
    ];

    mockInvoke.mockResolvedValueOnce({
      data: { results: mockResults, total: 2 },
      error: null,
    });

    const { result } = renderHook(() => useSearch({ userId }));

    act(() => {
      result.current.setQuery('test query');
    });

    await act(async () => {
      await result.current.search();
    });

    expect(mockInvoke).toHaveBeenCalledWith('search-memory', {
      body: {
        query: 'test query',
        userId,
        useSemanticSearch: true,
        limit: 50,
      },
    });

    expect(result.current.results).toHaveLength(2);
    expect(mockToast.success).toHaveBeenCalled();
  });

  it('respects minimum query length', async () => {
    const { result } = renderHook(() => 
      useSearch({ userId, minQueryLength: 3 })
    );

    act(() => {
      result.current.setQuery('ab');
    });

    await act(async () => {
      await result.current.search();
    });

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result.current.results).toEqual([]);
  });

  it('shows info toast when no results found', async () => {
    mockInvoke.mockResolvedValueOnce({
      data: { results: [], total: 0 },
      error: null,
    });

    const { result } = renderHook(() => useSearch({ userId }));

    act(() => {
      result.current.setQuery('nonexistent');
    });

    await act(async () => {
      await result.current.search();
    });

    expect(mockToast.info).toHaveBeenCalledWith('No results found');
  });

  it('handles search errors gracefully', async () => {
    mockInvoke.mockResolvedValueOnce({
      data: null,
      error: new Error('Search failed'),
    });

    const { result } = renderHook(() => useSearch({ userId }));

    act(() => {
      result.current.setQuery('test query');
    });

    await act(async () => {
      await result.current.search();
    });

    expect(result.current.error).toBeTruthy();
    expect(mockToast.error).toHaveBeenCalledWith('Search failed');
  });

  it('toggles semantic search mode', () => {
    const { result } = renderHook(() => useSearch({ userId }));

    expect(result.current.useSemanticSearch).toBe(true);

    act(() => {
      result.current.setUseSemanticSearch(false);
    });

    expect(result.current.useSemanticSearch).toBe(false);
  });

  it('clears results via clearResults()', async () => {
    mockInvoke.mockResolvedValueOnce({
      data: { results: [{ id: '1', content: 'Result' }], total: 1 },
      error: null,
    });

    const { result } = renderHook(() => useSearch({ userId }));

    act(() => {
      result.current.setQuery('test');
    });

    await act(async () => {
      await result.current.search();
    });

    expect(result.current.results).toHaveLength(1);

    act(() => {
      result.current.clearResults();
    });

    expect(result.current.results).toEqual([]);
    expect(result.current.query).toBe('');
    expect(result.current.error).toBeNull();
  });

  it('uses keyword search when semantic is disabled', async () => {
    mockInvoke.mockResolvedValueOnce({
      data: { results: [], total: 0 },
      error: null,
    });

    const { result } = renderHook(() => useSearch({ userId }));

    act(() => {
      result.current.setUseSemanticSearch(false);
      result.current.setQuery('test query');
    });

    await act(async () => {
      await result.current.search();
    });

    expect(mockInvoke).toHaveBeenCalledWith('search-memory', {
      body: expect.objectContaining({
        useSemanticSearch: false,
      }),
    });
  });
});
