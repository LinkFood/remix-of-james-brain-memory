/**
 * WeeklyReflectionPanel — Claude's Sunday self-reflection.
 *
 * Pulls the latest ct_reports where report_type='weekly', renders the
 * 8 required sections as collapsible cards. Each section is expandable
 * (click to open). Links to /reports?tab=weekly for history.
 *
 * Placement: top of /scorecard, below the header.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useVoiceAlerts } from '@/hooks/useVoiceAlerts';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  TrendingUp,
  TrendingDown,
  Layers,
  AlertTriangle,
  Target,
  Compass,
  Activity,
  ExternalLink,
  Play,
  Pause,
  Volume2,
  Loader2,
  Mic,
} from 'lucide-react';

// --------------- Types ---------------

interface WeeklyReport {
  id: string;
  report_type: string;
  period_start: string;
  period_end: string;
  summary: string | null;
  decomposition: WeeklyDecomposition | null;
  scorecard: Record<string, unknown> | null;
  self_assessment: string | null;
  audio_url: string | null;
  audio_duration_ms: number | null;
  created_at: string;
}

interface ThemeAttrRow {
  theme?: string;
  count?: number;
  pnl_pct?: number;
  win_rate?: number;
  note?: string;
}

interface WeeklyDecomposition {
  subtype?: string;
  week_start?: string;
  week_end?: string;
  sparsity_flag?: boolean;
  corpus_empty?: boolean;
  trading_days?: number;
  worked?: string[];
  didnt_work?: string[];
  theme_attribution?: ThemeAttrRow[];
  new_biases?: string;
  calibration_note?: string;
  next_week_posture?: string;
  structural_read?: string;
  script?: string;
  counts?: Record<string, number>;
}

// --------------- Helpers ---------------

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null) return '—';
  const v = n.toFixed(digits);
  return n >= 0 ? `+${v}%` : `${v}%`;
}

function fmtRate(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${(n * 100).toFixed(0)}%`;
}

function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * "Current week" = report's period_end is within the last 7 days. Used to
 * gate auto-play — we don't want to auto-play last month's reflection when
 * James loads /scorecard, only the freshly-landed Sunday one.
 */
function isCurrentWeek(periodEndIso: string | null | undefined): boolean {
  if (!periodEndIso) return false;
  const ageMs = Date.now() - new Date(periodEndIso).getTime();
  return ageMs >= 0 && ageMs <= 7 * 24 * 60 * 60 * 1000;
}

// --------------- Data hook ---------------

function useLatestWeekly() {
  return useQuery<WeeklyReport | null>({
    queryKey: ['ct_latest_weekly_reflection'],
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('ct_reports')
        .select('id, report_type, period_start, period_end, summary, decomposition, scorecard, self_assessment, audio_url, audio_duration_ms, created_at')
        .eq('report_type', 'weekly')
        .order('period_end', { ascending: false })
        .limit(1)
        .maybeSingle();
      return (data ?? null) as WeeklyReport | null;
    },
  });
}

// --------------- Section primitive ---------------

interface SectionProps {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  empty?: boolean;
  emptyLabel?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  badgeRight?: React.ReactNode;
}

function Section({ title, icon: Icon, empty, emptyLabel, children, defaultOpen = false, badgeRight }: SectionProps) {
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
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground">{title}</span>
        {badgeRight && <span className="ml-auto">{badgeRight}</span>}
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 text-xs text-foreground/90 leading-relaxed">
          {empty ? (
            <div className="text-muted-foreground italic">{emptyLabel ?? 'No data this week.'}</div>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}

// --------------- Theme attribution table ---------------

function ThemeAttributionTable({ rows }: { rows: ThemeAttrRow[] }) {
  if (rows.length === 0) {
    return <div className="text-muted-foreground italic">No themes with trades this week.</div>;
  }
  return (
    <div className="divide-y divide-border">
      {rows.map((row, i) => {
        const pnl = typeof row.pnl_pct === 'number' ? row.pnl_pct : null;
        const color = pnl == null
          ? 'text-muted-foreground'
          : pnl > 0 ? 'text-emerald-400'
          : pnl < 0 ? 'text-red-400'
          : 'text-muted-foreground';
        return (
          <div key={`${row.theme ?? 'unknown'}-${i}`} className="py-1.5 flex items-center gap-2 text-[11px]">
            <span className="font-mono font-semibold text-foreground">{row.theme ?? 'unknown'}</span>
            <span className="text-muted-foreground">n={row.count ?? 0}</span>
            <span className="text-muted-foreground">wr {fmtRate(row.win_rate)}</span>
            <span className={`ml-auto font-mono font-semibold ${color}`}>{fmtPct(pnl)}</span>
            {row.note && (
              <span className="w-full text-[10.5px] text-foreground/70 mt-0.5 leading-snug">
                {row.note}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// --------------- Main ---------------

export function WeeklyReflectionPanel() {
  const { data: report, isLoading } = useLatestWeekly();
  const { enabled: voiceEnabled } = useVoiceAlerts();

  const decomp = useMemo<WeeklyDecomposition>(() => {
    return (report?.decomposition ?? {}) as WeeklyDecomposition;
  }, [report]);

  // -------- Audio player state (mirrors MorningBriefPanel) --------
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const autoPlayedFor = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [seeking, setSeeking] = useState(false);

  // On-demand TTS fallback (when audio_url is null — generation failed or
  // we're viewing an older report that pre-dates TTS integration)
  const [onDemandUrl, setOnDemandUrl] = useState<string | null>(null);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);

  const effectiveSrc = report?.audio_url ?? onDemandUrl ?? null;
  const script = decomp.script ?? '';
  const fallbackDurationSec = report?.audio_duration_ms != null
    ? report.audio_duration_ms / 1000
    : 0;

  const isCurrent = useMemo(
    () => isCurrentWeek(report?.period_end ?? null),
    [report?.period_end],
  );

  // Auto-play once per report if voice toggle is on AND the reflection is
  // for the current week (period_end within last 7d). Keyed off report.id
  // so a fresh Sunday reflection replaces any previous one cleanly.
  useEffect(() => {
    if (!report?.audio_url || !voiceEnabled || !isCurrent) return;
    if (autoPlayedFor.current === report.id) return;
    const el = audioRef.current;
    if (!el) return;
    autoPlayedFor.current = report.id;
    el.load();
    const p = el.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        // Autoplay blocked — user can press Play manually. Reset guard so
        // a later voice-enable click gets another shot.
        autoPlayedFor.current = null;
      });
    }
  }, [report?.audio_url, report?.id, voiceEnabled, isCurrent]);

  // Revoke any blob URL we created on unmount / replacement
  useEffect(() => {
    return () => {
      if (onDemandUrl && onDemandUrl.startsWith('blob:')) {
        URL.revokeObjectURL(onDemandUrl);
      }
    };
  }, [onDemandUrl]);

  function toggleAudio() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  }

  function onSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const el = audioRef.current;
    if (!el || !durationSec) return;
    const next = (Number(e.target.value) / 1000) * durationSec;
    setCurrentTime(next);
    el.currentTime = next;
  }

  async function generateOnDemand() {
    if (!script || ttsLoading) return;
    setTtsLoading(true);
    setTtsError(null);
    try {
      const { data, error } = await supabase.functions.invoke<Blob>('elevenlabs-tts', {
        body: { text: script },
      });
      if (error) throw error;
      if (!data) throw new Error('empty response');
      const blob = data instanceof Blob ? data : new Blob([data], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      setOnDemandUrl(url);
      requestAnimationFrame(() => {
        const el = audioRef.current;
        if (el) {
          el.load();
          void el.play();
        }
      });
    } catch (e) {
      setTtsError(e instanceof Error ? e.message : 'TTS failed');
    } finally {
      setTtsLoading(false);
    }
  }

  const progressPermille = durationSec > 0 ? Math.round((currentTime / durationSec) * 1000) : 0;
  const shownDuration = durationSec || fallbackDurationSec;

  if (isLoading) {
    return (
      <Card className="p-4">
        <div className="text-xs text-muted-foreground">Loading weekly reflection…</div>
      </Card>
    );
  }

  if (!report) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-1">
          <BookOpen className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold uppercase tracking-wide">Weekly Reflection</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          No weekly reflections yet. The first one will land Sunday at 5pm ET after a full trading week.
        </p>
      </Card>
    );
  }

  const weekStart = decomp.week_start ?? report.period_start.slice(0, 10);
  const weekEnd = decomp.week_end ?? report.period_end.slice(0, 10);
  const worked = decomp.worked ?? [];
  const didnt = decomp.didnt_work ?? [];
  const themes = decomp.theme_attribution ?? [];
  const newBiases = decomp.new_biases ?? '';
  const calibrationNote = decomp.calibration_note ?? '';
  const posture = decomp.next_week_posture ?? '';
  const structural = decomp.structural_read ?? '';
  const tradingDays = decomp.trading_days ?? 0;
  const sparsity = decomp.sparsity_flag === true;
  const corpusEmpty = decomp.corpus_empty === true;

  return (
    <Card className="p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <BookOpen className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground">
          Weekly Reflection
        </h2>
        <span className="text-[11px] text-muted-foreground">
          week of {fmtDate(weekStart + 'T00:00:00Z')} – {fmtDate(weekEnd + 'T00:00:00Z')}
        </span>
        {sparsity && (
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-amber-400 border-amber-500/30">
            sparse · {tradingDays}d
          </Badge>
        )}
        {corpusEmpty && (
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-muted-foreground">
            corpus empty
          </Badge>
        )}
        <Link
          to="/reports?tab=weekly"
          className="ml-auto text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          view all weekly reflections <ExternalLink className="w-3 h-3" />
        </Link>
      </div>

      {/* Narration — audio player if we have audio, Narrate button otherwise.
          Hidden entirely if there's no script (e.g. corpus-empty week). */}
      {script && (
        <div className="border border-border rounded-md bg-muted/20 px-3 py-2">
          <div className="flex items-center gap-2 mb-1.5">
            <Mic className="w-3.5 h-3.5 text-primary" />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Listen
            </span>
            {shownDuration ? (
              <span className="text-[10px] tabular-nums text-muted-foreground ml-auto">
                {fmtClock(shownDuration)}
              </span>
            ) : null}
          </div>
          {effectiveSrc ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={toggleAudio} className="h-8">
                  {playing ? (
                    <><Pause className="w-3.5 h-3.5 mr-1" /> Pause</>
                  ) : (
                    <><Play className="w-3.5 h-3.5 mr-1" /> Play</>
                  )}
                </Button>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {fmtClock(currentTime)} / {fmtClock(shownDuration)}
                </span>
                {voiceEnabled && isCurrent && report.audio_url && (
                  <span className="text-[10px] text-primary/70 ml-auto">auto-play armed</span>
                )}
              </div>
              <input
                type="range"
                min={0}
                max={1000}
                value={progressPermille}
                onChange={onSeek}
                onMouseDown={() => setSeeking(true)}
                onMouseUp={() => setSeeking(false)}
                onTouchStart={() => setSeeking(true)}
                onTouchEnd={() => setSeeking(false)}
                disabled={!durationSec}
                className="w-full h-1 accent-primary cursor-pointer disabled:opacity-40"
                aria-label="Weekly reflection narration progress"
              />
              <audio
                ref={audioRef}
                src={effectiveSrc}
                preload="metadata"
                onLoadedMetadata={(e) => setDurationSec(e.currentTarget.duration || 0)}
                onTimeUpdate={(e) => { if (!seeking) setCurrentTime(e.currentTarget.currentTime); }}
                onEnded={() => { setPlaying(false); setCurrentTime(0); }}
                onPause={() => setPlaying(false)}
                onPlay={() => setPlaying(true)}
                className="hidden"
              />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={generateOnDemand}
                disabled={ttsLoading}
                className="h-8"
                title="Generate narration on demand"
              >
                {ttsLoading ? (
                  <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> Generating…</>
                ) : (
                  <><Volume2 className="w-3.5 h-3.5 mr-1" /> Narrate</>
                )}
              </Button>
              {ttsError && (
                <span className="text-[10px] text-destructive">{ttsError}</span>
              )}
              {!ttsError && !ttsLoading && (
                <span className="text-[10px] text-muted-foreground italic">
                  script ready — tap to generate audio
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Week summary — always open */}
      {report.summary && (
        <div className="text-xs text-foreground/90 leading-relaxed bg-muted/20 rounded p-2.5">
          {report.summary}
        </div>
      )}

      {/* 7 collapsible sections */}
      <div className="space-y-1.5">
        <Section
          title="What worked"
          icon={TrendingUp}
          defaultOpen={worked.length > 0}
          empty={worked.length === 0}
          emptyLabel="No clear wins to call out this week."
          badgeRight={worked.length > 0 ? (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0">{worked.length}</Badge>
          ) : null}
        >
          <ul className="list-disc pl-4 space-y-1">
            {worked.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </Section>

        <Section
          title="What didn't work"
          icon={TrendingDown}
          defaultOpen={didnt.length > 0}
          empty={didnt.length === 0}
          emptyLabel="No clear losses to call out this week."
          badgeRight={didnt.length > 0 ? (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0">{didnt.length}</Badge>
          ) : null}
        >
          <ul className="list-disc pl-4 space-y-1">
            {didnt.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </Section>

        <Section
          title="Theme attribution"
          icon={Layers}
          empty={themes.length === 0}
          emptyLabel="No thesis_theme activity with trades this week."
          badgeRight={themes.length > 0 ? (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0">{themes.length}</Badge>
          ) : null}
        >
          <ThemeAttributionTable rows={themes} />
        </Section>

        <Section
          title="New biases"
          icon={AlertTriangle}
          empty={!newBiases || newBiases.trim().length === 0}
          emptyLabel="No new biases identified this week."
        >
          <div className="whitespace-pre-wrap">{newBiases}</div>
        </Section>

        <Section
          title="Calibration note"
          icon={Target}
          empty={!calibrationNote || calibrationNote.trim().length === 0}
          emptyLabel="Not enough graded calls to assess calibration."
        >
          <div className="whitespace-pre-wrap">{calibrationNote}</div>
        </Section>

        <Section
          title="Next-week posture"
          icon={Compass}
          defaultOpen
          empty={!posture || posture.trim().length === 0}
          emptyLabel="No specific posture set."
        >
          <div className="whitespace-pre-wrap">{posture}</div>
        </Section>

        <Section
          title="Structural read"
          icon={Activity}
          empty={!structural || structural.trim().length === 0}
          emptyLabel="No dominant structural pattern identified."
        >
          <div className="whitespace-pre-wrap">{structural}</div>
        </Section>
      </div>
    </Card>
  );
}

export default WeeklyReflectionPanel;
