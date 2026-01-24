/**
 * Tests for useEntryActions hook
 * 
 * @module hooks/useEntryActions.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useEntryActions } from './useEntryActions';

// Mock supabase client
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockEq = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(() => ({
      update: mockUpdate,
      delete: mockDelete,
    })),
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

describe('useEntryActions', () => {
  const entryId = 'test-entry-id';

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Setup default chain
    mockUpdate.mockReturnValue({ eq: mockEq });
    mockDelete.mockReturnValue({ eq: mockEq });
    mockEq.mockResolvedValue({ error: null });
  });

  describe('toggleStar', () => {
    it('stars an entry and calls onEntryUpdate', async () => {
      const onEntryUpdate = vi.fn();
      const { result } = renderHook(() => useEntryActions({ onEntryUpdate }));

      await result.current.toggleStar(entryId, true);

      expect(mockUpdate).toHaveBeenCalledWith({ starred: true });
      expect(mockEq).toHaveBeenCalledWith('id', entryId);
      expect(onEntryUpdate).toHaveBeenCalledWith(entryId, { starred: true });
      expect(mockToast.success).toHaveBeenCalledWith('Starred');
    });

    it('unstars an entry', async () => {
      const onEntryUpdate = vi.fn();
      const { result } = renderHook(() => useEntryActions({ onEntryUpdate }));

      await result.current.toggleStar(entryId, false);

      expect(mockUpdate).toHaveBeenCalledWith({ starred: false });
      expect(mockToast.success).toHaveBeenCalledWith('Unstarred');
    });

    it('shows error toast on failure', async () => {
      mockEq.mockResolvedValueOnce({ error: new Error('Database error') });

      const { result } = renderHook(() => useEntryActions());

      await result.current.toggleStar(entryId, true);

      expect(mockToast.error).toHaveBeenCalledWith('Failed to update');
    });
  });

  describe('toggleArchive', () => {
    it('archives an entry and calls onEntryRemove', async () => {
      const onEntryRemove = vi.fn();
      const { result } = renderHook(() => useEntryActions({ onEntryRemove }));

      await result.current.toggleArchive(entryId);

      expect(mockUpdate).toHaveBeenCalledWith({ archived: true });
      expect(onEntryRemove).toHaveBeenCalledWith(entryId);
      expect(mockToast.success).toHaveBeenCalledWith('Archived');
    });

    it('shows error toast on failure', async () => {
      mockEq.mockResolvedValueOnce({ error: new Error('Database error') });

      const { result } = renderHook(() => useEntryActions());

      await result.current.toggleArchive(entryId);

      expect(mockToast.error).toHaveBeenCalledWith('Failed to archive');
    });
  });

  describe('deleteEntry', () => {
    it('deletes an entry and calls callbacks', async () => {
      const onEntryRemove = vi.fn();
      const onStatsUpdate = vi.fn();
      const { result } = renderHook(() => 
        useEntryActions({ onEntryRemove, onStatsUpdate })
      );

      await result.current.deleteEntry(entryId);

      expect(mockDelete).toHaveBeenCalled();
      expect(onEntryRemove).toHaveBeenCalledWith(entryId);
      expect(onStatsUpdate).toHaveBeenCalledWith(entryId, 'delete');
      expect(mockToast.success).toHaveBeenCalledWith('Deleted');
    });

    it('shows error toast on failure', async () => {
      mockEq.mockResolvedValueOnce({ error: new Error('Database error') });

      const { result } = renderHook(() => useEntryActions());

      await result.current.deleteEntry(entryId);

      expect(mockToast.error).toHaveBeenCalledWith('Failed to delete');
    });
  });

  describe('toggleListItem', () => {
    it('updates list item and calls onEntryUpdate', async () => {
      const onEntryUpdate = vi.fn();
      const { result } = renderHook(() => useEntryActions({ onEntryUpdate }));

      const listItems = [
        { text: 'Item 1', checked: false },
        { text: 'Item 2', checked: false },
      ];

      await result.current.toggleListItem(entryId, listItems, 0, true);

      expect(mockUpdate).toHaveBeenCalled();
      expect(onEntryUpdate).toHaveBeenCalledWith(entryId, {
        list_items: [
          { text: 'Item 1', checked: true },
          { text: 'Item 2', checked: false },
        ],
      });
    });

    it('shows error toast on failure', async () => {
      mockEq.mockResolvedValueOnce({ error: new Error('Database error') });

      const { result } = renderHook(() => useEntryActions());

      await result.current.toggleListItem(entryId, [], 0, true);

      expect(mockToast.error).toHaveBeenCalledWith('Failed to update item');
    });
  });
});
