/**
 * useTradeJournal — read + write journal state for one trade row.
 *
 * Reads:
 *   - Lives off the already-cached `book_all_trades` / `ct_trades_today`
 *     query via queryClient.getQueryData so we don't double-fetch. Any
 *     direct parent can also just pass the initial trade in; the hook
 *     reconciles on save.
 *
 * Writes (James's notes):
 *   - Debounced (800ms) direct supabase UPDATE. RLS policy
 *     ct_trades_journal_update + the column-scope trigger in migration
 *     20260419000015 restrict authenticated writes to journal columns.
 *   - Optimistic — updates the query cache immediately, rolls back on error.
 *
 * Regenerate (Claude's post-mortem):
 *   - Calls the ct-book-manager-regen-postmortem edge function (a thin
 *     wrapper that reruns firePostMortem for one trade_id). Not in this
 *     PR's scope — for now, regenerate is wired to a supabase.functions.invoke
 *     call on `ct-book-manager` with a special `regen_trade_id` param.
 *     If the function doesn't support it yet, the button shows a toast
 *     saying "regenerate not deployed" instead of silently failing.
 *
 * journal_version handling:
 *   - The hook increments journal_version only when regenerate succeeds.
 *   - James's notes edits do NOT bump version (version tracks Claude
 *     regenerations, not edit churn on the freeform field).
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import type { CtTradeRow } from '@/hooks/useCoTraderData';

const SAVE_DEBOUNCE_MS = 800;

export interface UseTradeJournalResult {
  jamesNotes: string;
  setJamesNotes: (v: string) => void;
  /** Fire an immediate save (used on blur). Debounced save still flushes if pending. */
  flushSave: () => Promise<void>;
  saving: boolean;
  saveError: string | null;
  lastSavedAt: string | null;
  regenerate: () => Promise<void>;
  regenerating: boolean;
  regenError: string | null;
}

export function useTradeJournal(trade: CtTradeRow): UseTradeJournalResult {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [jamesNotes, setJamesNotesLocal] = useState<string>(trade.james_notes ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(trade.journal_updated_at ?? null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);

  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWrittenRef = useRef<string>(trade.james_notes ?? '');

  // If the upstream trade row changes (new fetch), and the user hasn't diverged
  // from last-saved, re-sync the textarea. Avoid clobbering in-flight edits.
  useEffect(() => {
    const upstream = trade.james_notes ?? '';
    if (jamesNotes === lastWrittenRef.current) {
      lastWrittenRef.current = upstream;
      setJamesNotesLocal(upstream);
      setLastSavedAt(trade.journal_updated_at ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trade.james_notes, trade.journal_updated_at]);

  const writeNow = useCallback(
    async (value: string) => {
      setSaving(true);
      setSaveError(null);
      const nowIso = new Date().toISOString();

      // Optimistic cache update — update every cached CtTradeRow that matches id.
      const keys = [['book_all_trades'], ['ct_trades_today']];
      const snapshots: Array<{ key: ReadonlyArray<unknown>; data: CtTradeRow[] | undefined }> = [];
      for (const k of keys) {
        const data = qc.getQueryData<CtTradeRow[]>(k);
        snapshots.push({ key: k, data });
        if (data) {
          qc.setQueryData<CtTradeRow[]>(
            k,
            data.map(r => (r.id === trade.id ? { ...r, james_notes: value, journal_updated_at: nowIso } : r)),
          );
        }
      }

      const { error } = await supabase
        .from('ct_trades')
        .update({ james_notes: value, journal_updated_at: nowIso })
        .eq('id', trade.id);

      if (error) {
        // Roll back optimistic writes
        for (const s of snapshots) qc.setQueryData(s.key, s.data);
        setSaveError(error.message);
        setSaving(false);
        toast({ title: 'Journal save failed', description: error.message, variant: 'destructive' });
        return;
      }

      lastWrittenRef.current = value;
      setLastSavedAt(nowIso);
      setSaving(false);
    },
    [qc, toast, trade.id],
  );

  const scheduleDebouncedSave = useCallback(
    (value: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      pendingRef.current = value;
      timerRef.current = setTimeout(() => {
        const v = pendingRef.current;
        pendingRef.current = null;
        timerRef.current = null;
        if (v != null && v !== lastWrittenRef.current) {
          void writeNow(v);
        }
      }, SAVE_DEBOUNCE_MS);
    },
    [writeNow],
  );

  const setJamesNotes = useCallback(
    (v: string) => {
      setJamesNotesLocal(v);
      scheduleDebouncedSave(v);
    },
    [scheduleDebouncedSave],
  );

  const flushSave = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const v = pendingRef.current;
    pendingRef.current = null;
    if (v != null && v !== lastWrittenRef.current) {
      await writeNow(v);
    }
  }, [writeNow]);

  // On unmount, best-effort flush so switching rows doesn't drop edits.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const v = pendingRef.current;
      pendingRef.current = null;
      if (v != null && v !== lastWrittenRef.current) {
        // Fire and forget — can't await in cleanup.
        void writeNow(v);
      }
    };
  }, [writeNow]);

  /**
   * Regenerate Claude's post-mortem. Invokes ct-book-manager with a
   * { regen_trade_id } body. If the backend doesn't recognize that param
   * (older deploy), we show a toast and leave the existing note alone.
   * On success, we bump journal_version locally for immediate UI feedback;
   * the backend is the authority and the next trades refetch reconciles.
   */
  const regenerate = useCallback(async () => {
    setRegenerating(true);
    setRegenError(null);
    try {
      const { data, error } = await supabase.functions.invoke('ct-book-manager', {
        body: { regen_trade_id: trade.id },
      });
      if (error) throw error;
      const ok = data && (data as { ok?: boolean }).ok !== false;
      if (!ok) throw new Error('regenerate not supported on this deploy');

      // Optimistic bump of journal_version in caches (no new claude_notes
      // text yet — it's fire-and-forget on the server).
      for (const k of [['book_all_trades'], ['ct_trades_today']]) {
        const rows = qc.getQueryData<CtTradeRow[]>(k);
        if (!rows) continue;
        qc.setQueryData<CtTradeRow[]>(
          k,
          rows.map(r => (r.id === trade.id ? { ...r, journal_version: (r.journal_version ?? 1) + 1 } : r)),
        );
      }
      toast({ title: 'Regenerating post-mortem', description: 'Claude will update the note shortly.' });
      // Schedule a refetch in a few seconds to pick up the new text.
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['book_all_trades'] });
        qc.invalidateQueries({ queryKey: ['ct_trades_today'] });
      }, 5000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRegenError(msg);
      toast({ title: 'Regenerate failed', description: msg, variant: 'destructive' });
    } finally {
      setRegenerating(false);
    }
  }, [qc, toast, trade.id]);

  return {
    jamesNotes,
    setJamesNotes,
    flushSave,
    saving,
    saveError,
    lastSavedAt,
    regenerate,
    regenerating,
    regenError,
  };
}

/** "4h ago" style relative time, kept small & local. */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return 'never';
  const s = Math.max(0, Math.round((Date.now() - d) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const days = Math.round(h / 24);
  return `${days}d ago`;
}
