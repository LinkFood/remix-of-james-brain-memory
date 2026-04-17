import { useState } from 'react';
import { postJamesView, type PostJamesViewInput } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Flag, Loader2 } from 'lucide-react';

type Direction = PostJamesViewInput['direction'];
type Horizon   = PostJamesViewInput['horizon'];

const DIRECTIONS: Direction[] = ['bullish', 'bearish', 'neutral', 'volatility'];
const HORIZONS:   Horizon[]   = ['1h', '4h', 'EOD', 'next-day', 'weekly'];

export function JamesViewForm() {
  const qc = useQueryClient();
  const [instrument, setInstrument] = useState('');
  const [direction, setDirection]   = useState<Direction>('bullish');
  const [horizon, setHorizon]       = useState<Horizon>('EOD');
  const [conviction, setConviction] = useState<number>(3);
  const [rationale, setRationale]   = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!instrument.trim()) {
      toast.error('ticker required');
      return;
    }
    setSubmitting(true);
    try {
      const r = await postJamesView({
        instrument: instrument.trim(),
        direction,
        conviction,
        horizon,
        rationale: rationale.trim() || undefined,
      });
      if (r.ok) {
        toast.success(`view logged — ${direction} ${instrument.toUpperCase()} ${horizon}`);
        setInstrument('');
        setRationale('');
        setConviction(3);
        qc.invalidateQueries({ queryKey: ['ct_disagreements'] });
      } else {
        toast.error(`failed: ${r.error}`);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <Flag className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Post a view</h3>
      </div>

      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <Input
            placeholder="ticker (e.g. SPY)"
            value={instrument}
            onChange={e => setInstrument(e.target.value)}
            className="h-8 text-xs"
            maxLength={10}
          />
          <Select value={direction} onValueChange={v => setDirection(v as Direction)}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DIRECTIONS.map(d => <SelectItem key={d} value={d} className="text-xs">{d}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Select value={horizon} onValueChange={v => setHorizon(v as Horizon)}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HORIZONS.map(h => <SelectItem key={h} value={h} className="text-xs">{h}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={String(conviction)} onValueChange={v => setConviction(parseInt(v))}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 4, 5].map(n => <SelectItem key={n} value={String(n)} className="text-xs">conv {n}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <Textarea
          placeholder="rationale (optional)"
          value={rationale}
          onChange={e => setRationale(e.target.value)}
          rows={2}
          className="text-xs resize-none"
        />

        <Button size="sm" className="w-full h-8 text-xs" onClick={submit} disabled={submitting}>
          {submitting ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> posting…</> : 'Log view'}
        </Button>
      </div>
    </Card>
  );
}
