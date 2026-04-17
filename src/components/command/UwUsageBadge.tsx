import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

type UsageRow = {
  session_date: string;
  observed_at: string;
  daily_count: number;
  daily_limit: number;
  pct: number;
};

function tier(pct: number): { label: string; bg: string; fg: string } {
  if (pct >= 95) return { label: 'EXHAUST', bg: 'bg-red-600/20', fg: 'text-red-400' };
  if (pct >= 85) return { label: 'HOT', bg: 'bg-orange-500/20', fg: 'text-orange-300' };
  if (pct >= 70) return { label: 'WARM', bg: 'bg-yellow-500/20', fg: 'text-yellow-300' };
  if (pct >= 40) return { label: 'OK', bg: 'bg-emerald-500/10', fg: 'text-emerald-300' };
  return { label: 'COOL', bg: 'bg-emerald-500/5', fg: 'text-emerald-400/80' };
}

export function UwUsageBadge() {
  const { data } = useQuery<UsageRow | null>({
    queryKey: ['uw-usage-latest'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_uw_usage_latest')
        .select('*')
        .order('session_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return null;
      return data as UsageRow | null;
    },
    refetchInterval: 60_000,
  });

  if (!data || !data.daily_limit) return null;
  const t = tier(data.pct);
  const barPct = Math.min(100, Math.max(0, data.pct));

  return (
    <div className={`inline-flex items-center gap-2 rounded-md px-2 py-1 text-[10px] font-medium ${t.bg} ${t.fg}`} title={`UW API: ${data.daily_count.toLocaleString()} / ${data.daily_limit.toLocaleString()} today (updated ${new Date(data.observed_at).toLocaleTimeString()})`}>
      <span className="uppercase tracking-wider opacity-70">UW</span>
      <span className="tabular-nums font-semibold">{data.pct}%</span>
      <div className="h-1 w-16 overflow-hidden rounded-full bg-black/40">
        <div className={`h-full ${t.fg.replace('text-', 'bg-')}`} style={{ width: `${barPct}%` }} />
      </div>
      <span className="opacity-70 tabular-nums">{data.daily_count.toLocaleString()}/{data.daily_limit.toLocaleString()}</span>
      <span className="uppercase tracking-wider font-bold">{t.label}</span>
    </div>
  );
}
