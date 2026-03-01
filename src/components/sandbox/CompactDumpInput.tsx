/**
 * CompactDumpInput — Slim brain dump bar for the widget grid dashboard.
 *
 * Single-line on blur, expands to multi-line on focus.
 * Calls smart-save directly (same flow as DumpInput).
 */

import { useState, useRef, useCallback } from 'react';
import { Brain, Send, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { retryWithBackoff } from '@/lib/retryWithBackoff';

const SMART_SAVE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/smart-save`;
const COLD_START_TIMEOUT = 45000;

interface CompactDumpInputProps {
  userId: string;
}

export default function CompactDumpInput({ userId }: CompactDumpInputProps) {
  const [content, setContent] = useState('');
  const [focused, setFocused] = useState(false);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(async () => {
    const text = content.trim();
    if (!text || saving) return;

    setSaving(true);
    setContent('');

    try {
      const { error: refreshError } = await supabase.auth.getUser();
      if (refreshError) throw new Error('Not authenticated');

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      await retryWithBackoff(
        async () => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), COLD_START_TIMEOUT);

          try {
            const res = await fetch(SMART_SAVE_URL, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`,
                'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
              },
              body: JSON.stringify({
                content: text,
                userId,
                source: 'manual',
              }),
              signal: controller.signal,
            });
            clearTimeout(timeoutId);

            if (!res.ok) {
              const errorData = await res.json().catch(() => ({}));
              throw new Error(errorData.error || `Request failed: ${res.status}`);
            }

            return res.json();
          } catch (err: any) {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') {
              throw new Error('Request timed out');
            }
            throw err;
          }
        },
        { maxRetries: 3, baseDelayMs: 2000, toastId: 'compact-dump-retry', showToast: true },
      );

      toast.success('Saved to brain');
      setFocused(false);
      textareaRef.current?.blur();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast.error('Failed to save', { description: msg.slice(0, 100) });
      setContent(text); // Restore on failure
    } finally {
      setSaving(false);
    }
  }, [content, saving, userId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div className="mx-4 mt-2 mb-1 flex items-start gap-2 px-3 py-2 rounded-lg bg-white/[0.03] backdrop-blur-sm border border-white/10">
      <Brain className="w-4 h-4 text-muted-foreground mt-2 shrink-0" />

      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          if (!content.trim()) setFocused(false);
        }}
        onKeyDown={handleKeyDown}
        placeholder="Dump something in..."
        rows={focused ? 3 : 1}
        disabled={saving}
        className="flex-1 bg-transparent text-sm text-white/80 placeholder:text-white/30 resize-none outline-none py-1.5 transition-all duration-200"
      />

      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-white"
        disabled={!content.trim() || saving}
        onClick={handleSubmit}
      >
        {saving ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Send className="w-4 h-4" />
        )}
      </Button>
    </div>
  );
}
