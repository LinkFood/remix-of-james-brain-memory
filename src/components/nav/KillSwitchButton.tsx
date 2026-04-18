/**
 * KillSwitchButton — TopNav control for the Co-Trader emergency kill switch.
 *
 * States:
 *   - DISARMED → small "arm" button. Click opens modal with reason + duration.
 *   - ARMED    → big red "KILL" button with countdown (if auto_release) or
 *                "manual" label. Click opens modal with "DISARM" confirm.
 *
 * 10s polling via useCtKillSwitch keeps state in sync across tabs / sessions
 * (e.g. /kill fired from Slack will flip the UI within 10s).
 *
 * This is the Claude kill switch — NOT the JAC agent-task cancel. See the
 * existing <Button onClick={killAll}> block in TopNav for that.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCtKillSwitch } from '@/hooks/useCtKillSwitch';

type Duration = '15' | '60' | '240' | 'manual';

const DURATION_LABELS: Record<Duration, string> = {
  '15': '15 min',
  '60': '1 hour',
  '240': '4 hours',
  manual: 'until manually disarmed',
};

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function KillSwitchButton() {
  const { state, engage, disarm, secondsUntilAutoRelease } = useCtKillSwitch();
  const [modalOpen, setModalOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState<Duration>('60');
  const [submitting, setSubmitting] = useState(false);

  const active = state?.active === true;

  const handleEngage = async () => {
    setSubmitting(true);
    const minutes = duration === 'manual' ? null : parseInt(duration, 10);
    await engage(reason, minutes);
    setSubmitting(false);
    setModalOpen(false);
    setReason('');
    setDuration('60');
  };

  const handleDisarm = async () => {
    setSubmitting(true);
    await disarm();
    setSubmitting(false);
    setModalOpen(false);
  };

  // Compact trigger — renders differently based on state.
  const trigger = active ? (
    <button
      onClick={() => setModalOpen(true)}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-600 hover:bg-red-500 text-white text-xs font-bold shadow-[0_0_12px_rgba(239,68,68,0.5)] animate-pulse transition-colors"
      title={`Kill switch engaged: ${state?.engagedReason ?? ''}`}
    >
      <span className="inline-block w-2 h-2 rounded-full bg-white" />
      <span>KILL</span>
      {secondsUntilAutoRelease !== null && (
        <span className="font-mono text-[10px] opacity-80">
          {formatCountdown(secondsUntilAutoRelease)}
        </span>
      )}
    </button>
  ) : (
    <button
      onClick={() => setModalOpen(true)}
      className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
      title="Engage Claude kill switch"
    >
      <span className="inline-block w-2 h-2 rounded-full border border-current" />
      <span className="hidden sm:inline">arm</span>
    </button>
  );

  return (
    <>
      {trigger}

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-md">
          {active ? (
            <>
              <DialogHeader>
                <DialogTitle className="text-red-400">Kill switch is engaged</DialogTitle>
                <DialogDescription>
                  All Claude calls + trade writes are paused. Chat reads still work.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-2 text-xs">
                <div>
                  <span className="text-muted-foreground">Reason:</span>{' '}
                  <span className="font-medium">{state?.engagedReason ?? '(none)'}</span>
                </div>
                {state?.engagedAt && (
                  <div>
                    <span className="text-muted-foreground">Engaged:</span>{' '}
                    <span>{new Date(state.engagedAt).toLocaleString()}</span>
                  </div>
                )}
                {state?.engagedBy && (
                  <div>
                    <span className="text-muted-foreground">Engaged by:</span>{' '}
                    <span>{state.engagedBy}</span>
                  </div>
                )}
                {secondsUntilAutoRelease !== null ? (
                  <div>
                    <span className="text-muted-foreground">Auto-release in:</span>{' '}
                    <span className="font-mono text-red-400">
                      {formatCountdown(secondsUntilAutoRelease)}
                    </span>
                  </div>
                ) : (
                  <div>
                    <span className="text-muted-foreground">Auto-release:</span>{' '}
                    <span>manual disarm only</span>
                  </div>
                )}
              </div>

              <DialogFooter className="gap-2">
                <Button variant="ghost" onClick={() => setModalOpen(false)} disabled={submitting}>
                  Close
                </Button>
                <Button
                  onClick={handleDisarm}
                  disabled={submitting}
                  className="bg-green-600 hover:bg-green-500 text-white"
                >
                  {submitting ? 'Disarming…' : 'DISARM'}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="text-red-400">Engage kill switch</DialogTitle>
                <DialogDescription>
                  Pauses watcher, book-manager, alert commits, curiosity, recaps, and
                  chat commits. Does not close open positions.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="kill-reason" className="text-xs">Reason</Label>
                  <Input
                    id="kill-reason"
                    placeholder="e.g. echo chamber on QQQ, costs spiking, obvious bug"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    autoFocus
                  />
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">Duration</Label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {(Object.keys(DURATION_LABELS) as Duration[]).map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setDuration(d)}
                        className={`px-2 py-1.5 rounded-md text-xs border transition-colors ${
                          duration === d
                            ? 'border-red-500 bg-red-500/10 text-red-400'
                            : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted/50'
                        }`}
                      >
                        {DURATION_LABELS[d]}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <DialogFooter className="gap-2">
                <Button variant="ghost" onClick={() => setModalOpen(false)} disabled={submitting}>
                  Cancel
                </Button>
                <Button
                  onClick={handleEngage}
                  disabled={submitting}
                  className="bg-red-600 hover:bg-red-500 text-white"
                >
                  {submitting ? 'Engaging…' : 'ENGAGE KILL'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
