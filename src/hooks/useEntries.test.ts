/**
 * Tests for useEntries hook
 * 
 * @module hooks/useEntries.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEntries } from './useEntries';
import { createMockEntries } from '@/test/mocks/supabase';

// Mock supabase client
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockOrder = vi.fn();
const mockLimit = vi.fn();
const mockLt = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: mockSelect,
    })),
  },
}));

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

describe('useEntries', () => {
  const userId = 'test-user-id';
  const mockEntries = createMockEntries(5, userId);

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Setup default chain
    mockSelect.mockReturnValue({ eq: mockEq });
    mockEq.mockReturnValue({ eq: mockEq, order: mockOrder });
    mockOrder.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue({ data: mockEntries, error: null });
    mockLt.mockReturnValue({ data: [], error: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches entries on mount', async () => {
    const { result } = renderHook(() => useEntries({ userId }));

    expect(result.current.loading).toBe(true);

    // Wait for the async fetch to complete
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.entries).toHaveLength(5);
  });

  it('calculates stats on initial load', async () => {
    const { result } = renderHook(() => useEntries({ userId }));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.stats.total).toBe(5);
    expect(result.current.stats.byType).toHaveProperty('note');
  });

  it('updates entry locally via updateEntry', async () => {
    const { result } = renderHook(() => useEntries({ userId }));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.updateEntry('entry-0', { starred: true });
    });

    const updatedEntry = result.current.entries.find(e => e.id === 'entry-0');
    expect(updatedEntry?.starred).toBe(true);
  });

  it('removes entry locally via removeEntry', async () => {
    const { result } = renderHook(() => useEntries({ userId }));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const initialLength = result.current.entries.length;

    act(() => {
      result.current.removeEntry('entry-0');
    });

    expect(result.current.entries).toHaveLength(initialLength - 1);
    expect(result.current.entries.find(e => e.id === 'entry-0')).toBeUndefined();
  });

  it('adds entry locally via addEntry', async () => {
    const { result } = renderHook(() => useEntries({ userId }));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const newEntry = {
      id: 'new-entry',
      user_id: userId,
      content: 'New content',
      title: 'New Entry',
      content_type: 'note',
      content_subtype: null,
      tags: [],
      importance_score: 5,
      starred: false,
      archived: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      list_items: [],
      extracted_data: {},
      image_url: null,
      source: 'web',
      event_date: null,
      event_time: null,
      is_recurring: null,
      recurrence_pattern: null,
      embedding: null,
    };

    act(() => {
      result.current.addEntry(newEntry);
    });

    expect(result.current.entries[0].id).toBe('new-entry');
  });

  it('prevents duplicate entries via addEntry', async () => {
    const { result } = renderHook(() => useEntries({ userId }));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const initialLength = result.current.entries.length;
    const existingEntry = result.current.entries[0];

    act(() => {
      result.current.addEntry(existingEntry);
    });

    expect(result.current.entries).toHaveLength(initialLength);
  });

  it('handles fetch error gracefully', async () => {
    mockLimit.mockResolvedValueOnce({ data: null, error: new Error('Database error') });

    const { result } = renderHook(() => useEntries({ userId }));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.entries).toHaveLength(0);
  });

  it('sets hasMore based on page size', async () => {
    // Less than pageSize means no more
    mockLimit.mockResolvedValueOnce({ data: mockEntries.slice(0, 3), error: null });

    const { result } = renderHook(() => useEntries({ userId, pageSize: 10 }));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.hasMore).toBe(false);
  });
});
