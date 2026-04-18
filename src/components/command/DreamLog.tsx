/**
 * DreamLog — latest overnight Claude reflection, placed at the very bottom
 * of CommandStation. Rendered in the morning so James can read what Claude
 * was turning over in the silence between EOD and the open.
 *
 * Shape: one card with collapsible sections (reflection prose, patterns,
 * connections, tomorrow hypotheses). Each hypothesis has a "Track this"
 * button that logs intent locally (v2 would create a custom rule; for now
 * we just toast + persist the click to a local track list).
 *
 * A "Previous dreams" <Select> lets James browse the last ~30 dreams.
 *
 * First few dreams will be thin by design — the reflection compounds as
 * ct_session_embeddings accumulates.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Moon,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Link2,
  FlaskConical,
  Target,
} from 'lucide-react';
import { toast } from 'sonner';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PatternNoticed {
  pattern: string;
  evidence_refs?: string[];
}

interface ConnectionDrawn {
  today_thing: string;
  past_thing: string;
  why_connected: string;
}

interface TomorrowHypothesis {
  hypothesis: string;
  how_to_test: string;
}

interface Dream {
  id: string;
  session_date: string;
  created_at: string;
  reflection: string;
  patterns_noticed: PatternNoticed[] | null;
  connections_drawn: ConnectionDrawn[] | null;
  tomorrow_hypotheses: TomorrowHypothesis[] | null;
  tokens_used: number | null;
  cost_usd: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

function useLatestDream() {
  return useQuery<Dream | null>({
    queryKey: ['ct_latest_dream'],
    refetchInterval: 10 * 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('ct_dreams')
        .select('id, session_date, created_at, reflection, patterns_noticed, connections_drawn, tomorrow_hypotheses, tokens_used, cost_usd')
        .order('session_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      return (data ?? null) as Dream | null;
    },
  });
}

function useDreamHistory() {
  return useQuery<Dream[]>({
    queryKey: ['ct_dream_history'],
    refetchInterval: 30 * 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('ct_dreams')
        .select('id, session_date, created_at, reflection, patterns_noticed, connections_drawn, tomorrow_hypotheses, tokens_used, cost_usd')
        .order('session_date', { ascending: false })
        .limit(30);
      return (data ?? []) as Dream[];
    },
  });
}

// ---------------------------------------------------------------------------
// Section primitive — mirrors WeeklyReflectionPanel style
// ---------------------------------------------------------------------------

interface SectionProps {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  empty?: boolean;
  emptyLabel?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  count?: number;
}

function Section({
  title,
  icon: Icon,
  empty,
  emptyLabel,
  children,
  defaultOpen = false,
  count,
}: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="border border-border rounded-md bg-card/40">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-muted/30 transition-colors"
      >
        <Chevron className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <Icon className="w-3.5 h-3.5 text-primary shrink-0" />
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
          {title}
        </span>
        {typeof count === 'number' && count > 0 && (
          <Badge variant="outline" className="ml-auto text-[9px] px-1.5 py-0">
            {count}
          </Badge>
        )}
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 text-xs text-foreground/90 leading-relaxed">
          {empty ? (
            <div className="text-muted-foreground italic">
              {emptyLabel ?? 'Nothing in this section.'}
            </div>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inner renderer — given a dream, render it. Shared by latest + browsed.
// ---------------------------------------------------------------------------

interface DreamBodyProps {
  dream: Dream;
}

function DreamBody({ dream }: DreamBodyProps) {
  const patterns = useMemo(() => asArray<PatternNoticed>(dream.patterns_noticed), [dream.patterns_noticed]);
  const connections = useMemo(() => asArray<ConnectionDrawn>(dream.connections_drawn), [dream.connections_drawn]);
  const hypotheses = useMemo(() => asArray<TomorrowHypothesis>(dream.tomorrow_hypotheses), [dream.tomorrow_hypotheses]);

  function trackHypothesis(h: TomorrowHypothesis) {
    // v2 would create a custom rule out of `how_to_test`. For now log
    // the intent to sonner (visible) and to localStorage (persistent).
    try {
      const key = 'ct_dream_tracked_hypotheses';
      const existing = JSON.parse(localStorage.getItem(key) ?? '[]') as Array<{
        dream_id: string;
        hypothesis: string;
        how_to_test: string;
        tracked_at: string;
      }>;
      existing.push({
        dream_id: dream.id,
        hypothesis: h.hypothesis,
        how_to_test: h.how_to_test,
        tracked_at: new Date().toISOString(),
      });
      localStorage.setItem(key, JSON.stringify(existing.slice(-50)));
    } catch {
      // best-effort — never throw from a track click
    }
    toast.success('Hypothesis tracked', {
      description: h.hypothesis.slice(0, 120),
    });
  }

  return (
    <div className="space-y-3">
      {/* Reflection prose — always rendered, always readable */}
      <div className="text-xs text-foreground/90 leading-relaxed bg-muted/20 rounded p-2.5 whitespace-pre-wrap">
        {dream.reflection}
      </div>

      <div className="space-y-1.5">
        <Section
          title="Patterns noticed"
          icon={Sparkles}
          count={patterns.length}
          defaultOpen={patterns.length > 0 && patterns.length <= 3}
          empty={patterns.length === 0}
          emptyLabel="No patterns flagged — quiet tape."
        >
          <ul className="space-y-2">
            {patterns.map((p, i) => (
              <li key={i} className="border-l-2 border-primary/30 pl-2">
                <div className="text-foreground/90">{p.pattern}</div>
                {p.evidence_refs && p.evidence_refs.length > 0 && (
                  <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                    {p.evidence_refs.join(' · ')}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Section>

        <Section
          title="Connections drawn"
          icon={Link2}
          count={connections.length}
          empty={connections.length === 0}
          emptyLabel="No cross-session connections drawn."
        >
          <ul className="space-y-2">
            {connections.map((c, i) => (
              <li key={i} className="border-l-2 border-primary/30 pl-2 space-y-0.5">
                <div className="text-[10px] uppercase text-muted-foreground">today</div>
                <div className="text-foreground/90">{c.today_thing}</div>
                <div className="text-[10px] uppercase text-muted-foreground mt-1">past</div>
                <div className="text-foreground/80">{c.past_thing}</div>
                <div className="text-[11px] text-foreground/70 italic mt-1">
                  {c.why_connected}
                </div>
              </li>
            ))}
          </ul>
        </Section>

        <Section
          title="Tomorrow hypotheses"
          icon={FlaskConical}
          count={hypotheses.length}
          defaultOpen={hypotheses.length > 0}
          empty={hypotheses.length === 0}
          emptyLabel="No hypotheses worth carrying into tomorrow."
        >
          <ul className="space-y-2">
            {hypotheses.map((h, i) => (
              <li key={i} className="border border-border rounded-md p-2 space-y-1.5">
                <div className="text-foreground/90 font-medium">{h.hypothesis}</div>
                <div className="text-[11px] text-foreground/70 italic flex items-start gap-1">
                  <Target className="w-3 h-3 mt-0.5 shrink-0 text-muted-foreground" />
                  <span>{h.how_to_test}</span>
                </div>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[10px] px-2"
                    onClick={() => trackHypothesis(h)}
                  >
                    Track this
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main — latest dream + previous dreams dropdown
// ---------------------------------------------------------------------------

export function DreamLog() {
  const { data: latest, isLoading: loadingLatest } = useLatestDream();
  const { data: history = [] } = useDreamHistory();

  // Selected dream ID (null = show latest). History rows are the source of
  // truth since they already carry full content.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const activeDream: Dream | null = useMemo(() => {
    if (!selectedId) return latest ?? null;
    return history.find(d => d.id === selectedId) ?? latest ?? null;
  }, [selectedId, latest, history]);

  if (loadingLatest) {
    return (
      <Card className="p-4">
        <div className="text-xs text-muted-foreground">Loading dream…</div>
      </Card>
    );
  }

  if (!activeDream) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-1">
          <Moon className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold uppercase tracking-wide">Dream Log</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          No dreams yet. Claude reflects overnight at 1am ET weekdays on the session
          just closed — first few will be thin while the history corpus accumulates.
        </p>
      </Card>
    );
  }

  const isShowingLatest = !selectedId || (latest && activeDream.id === latest.id);

  return (
    <Card className="p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <Moon className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground">
          Dream Log
        </h2>
        <span className="text-[11px] text-muted-foreground">
          reflecting on {fmtDate(activeDream.session_date + 'T00:00:00Z')}
        </span>
        {isShowingLatest && (
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-primary border-primary/40">
            latest
          </Badge>
        )}
        {typeof activeDream.cost_usd === 'number' && activeDream.cost_usd > 0 && (
          <span className="text-[10px] text-muted-foreground/70 ml-auto font-mono">
            ${activeDream.cost_usd.toFixed(3)} · {activeDream.tokens_used?.toLocaleString() ?? 0} tok
          </span>
        )}
      </div>

      {/* Previous dreams dropdown — only renders when history has 2+ rows */}
      {history.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase text-muted-foreground tracking-wide">
            Browse
          </span>
          <Select
            value={selectedId ?? (latest?.id ?? '')}
            onValueChange={(v) => setSelectedId(v)}
          >
            <SelectTrigger className="h-7 text-[11px] max-w-xs">
              <SelectValue placeholder="Previous dreams" />
            </SelectTrigger>
            <SelectContent>
              {history.map(d => (
                <SelectItem key={d.id} value={d.id} className="text-[11px]">
                  {fmtDate(d.session_date + 'T00:00:00Z')}
                  {d.id === latest?.id ? ' · latest' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!isShowingLatest && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-[10px] px-2"
              onClick={() => setSelectedId(null)}
            >
              back to latest
            </Button>
          )}
        </div>
      )}

      <DreamBody dream={activeDream} />

      <footer className="pt-1 text-[10px] text-muted-foreground/60">
        Fires weekdays at 1am ET · Sonnet · ~$0.03–0.05 per dream
      </footer>
    </Card>
  );
}

export default DreamLog;
