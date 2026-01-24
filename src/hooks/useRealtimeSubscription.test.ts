/**
 * Tests for useRealtimeSubscription hook
 * 
 * @module hooks/useRealtimeSubscription.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRealtimeSubscription } from './useRealtimeSubscription';

// Mock channel with chainable methods
const mockOn = vi.fn();
const mockSubscribe = vi.fn();
const mockRemoveChannel = vi.fn();

const mockChannel = {
  on: mockOn.mockReturnThis(),
  subscribe: mockSubscribe.mockReturnThis(),
};

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    channel: vi.fn(() => mockChannel),
    removeChannel: mockRemoveChannel,
  },
}));

// Get the mocked supabase
import { supabase } from '@/integrations/supabase/client';

describe('useRealtimeSubscription', () => {
  const userId = 'test-user-id';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates subscription with correct channel name', () => {
    renderHook(() => useRealtimeSubscription({ userId }));

    expect(supabase.channel).toHaveBeenCalledWith(`entries-realtime-${userId}`);
  });

  it('subscribes to postgres_changes with user filter', () => {
    renderHook(() => useRealtimeSubscription({ userId }));

    expect(mockOn).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({
        event: '*',
        schema: 'public',
        table: 'entries',
        filter: `user_id=eq.${userId}`,
      }),
      expect.any(Function)
    );
  });

  it('uses custom table name when provided', () => {
    renderHook(() => 
      useRealtimeSubscription({ userId, table: 'custom_table' })
    );

    expect(supabase.channel).toHaveBeenCalledWith(`custom_table-realtime-${userId}`);
    expect(mockOn).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({
        table: 'custom_table',
      }),
      expect.any(Function)
    );
  });

  it('does not create subscription when enabled is false', () => {
    renderHook(() => 
      useRealtimeSubscription({ userId, enabled: false })
    );

    expect(supabase.channel).not.toHaveBeenCalled();
  });

  it('does not create subscription when userId is empty', () => {
    renderHook(() => 
      useRealtimeSubscription({ userId: '' })
    );

    expect(supabase.channel).not.toHaveBeenCalled();
  });

  it('calls subscribe on the channel', () => {
    renderHook(() => useRealtimeSubscription({ userId }));

    expect(mockSubscribe).toHaveBeenCalled();
  });

  it('removes channel on unmount', () => {
    const { unmount } = renderHook(() => useRealtimeSubscription({ userId }));

    unmount();

    expect(mockRemoveChannel).toHaveBeenCalledWith(mockChannel);
  });

  it('calls onInsert callback for INSERT events', () => {
    const onInsert = vi.fn();
    renderHook(() => useRealtimeSubscription({ userId, onInsert }));

    // Get the callback passed to .on()
    const callback = mockOn.mock.calls[0][2];

    // Simulate INSERT event
    callback({
      eventType: 'INSERT',
      new: { id: 'new-entry', content: 'New content' },
    });

    expect(onInsert).toHaveBeenCalledWith({ id: 'new-entry', content: 'New content' });
  });

  it('calls onUpdate callback for UPDATE events', () => {
    const onUpdate = vi.fn();
    renderHook(() => useRealtimeSubscription({ userId, onUpdate }));

    const callback = mockOn.mock.calls[0][2];

    callback({
      eventType: 'UPDATE',
      new: { id: 'entry-1', content: 'Updated content' },
    });

    expect(onUpdate).toHaveBeenCalledWith({ id: 'entry-1', content: 'Updated content' });
  });

  it('calls onDelete callback for DELETE events', () => {
    const onDelete = vi.fn();
    renderHook(() => useRealtimeSubscription({ userId, onDelete }));

    const callback = mockOn.mock.calls[0][2];

    callback({
      eventType: 'DELETE',
      old: { id: 'deleted-entry' },
    });

    expect(onDelete).toHaveBeenCalledWith({ id: 'deleted-entry' });
  });
});
