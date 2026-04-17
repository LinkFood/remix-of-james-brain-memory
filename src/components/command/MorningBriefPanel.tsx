import { useRef, useState } from 'react';
import { useLatestMorningBrief } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Mic, Play, Pause } from 'lucide-react';

function fmtDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function MorningBriefPanel() {
  const { data: brief, isLoading } = useLatestMorningBrief();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  function toggle() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      el.play();
      setPlaying(true);
    } else {
      el.pause();
      setPlaying(false);
    }
  }

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <Mic className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Morning Brief</h3>
        {brief && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            {fmtDate(brief.for_date)}
            {brief.duration_seconds ? ` · ${Math.round(brief.duration_seconds)}s` : ''}
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
          {brief.audio_url ? (
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={toggle} className="h-8">
                {playing ? (
                  <><Pause className="w-3.5 h-3.5 mr-1" /> Pause</>
                ) : (
                  <><Play className="w-3.5 h-3.5 mr-1" /> Play</>
                )}
              </Button>
              <audio
                ref={audioRef}
                src={brief.audio_url}
                preload="none"
                onEnded={() => setPlaying(false)}
                onPause={() => setPlaying(false)}
                onPlay={() => setPlaying(true)}
                className="hidden"
              />
              <span className="text-[10px] text-muted-foreground">audio ready</span>
            </div>
          ) : (
            <div className="text-[10px] text-muted-foreground italic">
              script only — TTS unavailable for this run
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
