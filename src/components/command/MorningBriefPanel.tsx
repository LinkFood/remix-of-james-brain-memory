import { useEffect, useMemo, useRef, useState } from 'react';
import { useLatestMorningBrief } from '@/hooks/useCoTraderData';
import { useVoiceAlerts } from '@/hooks/useVoiceAlerts';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Mic, Play, Pause, Volume2, Loader2 } from 'lucide-react';

const AUTO_PLAY_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

function fmtDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function MorningBriefPanel() {
  const { data: brief, isLoading } = useLatestMorningBrief();
  const { enabled: voiceEnabled } = useVoiceAlerts();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const autoPlayedFor = useRef<string | null>(null); // guard so we don't replay on re-renders
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [seeking, setSeeking] = useState(false);

  // On-demand TTS fallback (when audio_url is null)
  const [onDemandUrl, setOnDemandUrl] = useState<string | null>(null);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);

  const effectiveSrc = brief?.audio_url ?? onDemandUrl ?? null;

  const isFresh = useMemo(() => {
    if (!brief?.created_at) return false;
    const ageMs = Date.now() - new Date(brief.created_at).getTime();
    return ageMs >= 0 && ageMs <= AUTO_PLAY_MAX_AGE_MS;
  }, [brief?.created_at]);

  // Auto-play once per brief if voice toggle is on AND brief is <30min old
  useEffect(() => {
    if (!brief?.audio_url || !voiceEnabled || !isFresh) return;
    if (autoPlayedFor.current === brief.for_date) return;
    const el = audioRef.current;
    if (!el) return;
    autoPlayedFor.current = brief.for_date;
    // Some browsers require explicit load() before play() when preload='metadata'
    el.load();
    const p = el.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        // Autoplay blocked — user can still press Play. Reset guard so a later
        // manual voice-enable action gets another shot on next mount.
        autoPlayedFor.current = null;
      });
    }
  }, [brief?.audio_url, brief?.for_date, voiceEnabled, isFresh]);

  // Revoke blob URL on unmount / when replaced
  useEffect(() => {
    return () => {
      if (onDemandUrl && onDemandUrl.startsWith('blob:')) {
        URL.revokeObjectURL(onDemandUrl);
      }
    };
  }, [onDemandUrl]);

  function toggle() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
    } else {
      el.pause();
    }
  }

  function onSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const el = audioRef.current;
    if (!el || !durationSec) return;
    const next = (Number(e.target.value) / 1000) * durationSec;
    setCurrentTime(next);
    el.currentTime = next;
  }

  async function generateOnDemand() {
    if (!brief?.script || ttsLoading) return;
    setTtsLoading(true);
    setTtsError(null);
    try {
      // Call the existing elevenlabs-tts edge function. It returns audio/mpeg bytes.
      const { data, error } = await supabase.functions.invoke<Blob>('elevenlabs-tts', {
        body: { text: brief.script },
      });
      if (error) throw error;
      if (!data) throw new Error('empty response');
      const blob = data instanceof Blob ? data : new Blob([data], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      setOnDemandUrl(url);
      // Play once loaded
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
  const shownDuration = durationSec || (brief?.duration_seconds ?? 0);

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <Mic className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Morning Brief</h3>
        {brief && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            {fmtDate(brief.for_date)}
            {shownDuration ? ` · ${fmtClock(shownDuration)}` : ''}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">loading…</div>
      ) : !brief ? (
        <div className="text-sm text-muted-foreground">
          no brief yet — fires weekdays at 10:45 UTC (6:45am ET)
        </div>
      ) : (
        <div className="space-y-3 text-xs">
          {effectiveSrc ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={toggle} className="h-8">
                  {playing ? (
                    <><Pause className="w-3.5 h-3.5 mr-1" /> Pause</>
                  ) : (
                    <><Play className="w-3.5 h-3.5 mr-1" /> Play</>
                  )}
                </Button>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {fmtClock(currentTime)} / {fmtClock(durationSec || (brief.duration_seconds ?? 0))}
                </span>
                {voiceEnabled && isFresh && brief.audio_url && (
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
                aria-label="Narration progress"
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
                disabled={ttsLoading || !brief.script}
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
                  script only — tap to generate
                </span>
              )}
            </div>
          )}

          <p className="text-foreground/90 whitespace-pre-wrap leading-relaxed">
            {brief.script}
          </p>
        </div>
      )}
    </Card>
  );
}
