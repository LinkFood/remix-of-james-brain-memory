import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';

type UsageRow = {
  month: string;
  monthly_count: number;
  monthly_limit: number;
  pct: number;
  last_call_at: string | null;
};

function tier(pct: number): { label: string; bg: string; fg: string } {
  if (pct >= 95) return { label: 'EXHAUST', bg: 'bg-red-600/20', fg: 'text-red-400' };
  if (pct >= 90) return { label: 'HOT', bg: 'bg-orange-500/20', fg: 'text-orange-300' };
  if (pct >= 70) return { label: 'WARM', bg: 'bg-yellow-500/20', fg: 'text-yellow-300' };
  if (pct >= 40) return { label: 'OK', bg: 'bg-emerald-500/10', fg: 'text-emerald-300' };
  return { label: 'COOL', bg: 'bg-emerald-500/5', fg: 'text-emerald-400/80' };
}

export function TavilyUsageBadge() {
  const { data } = useQuery<UsageRow | null>({
    queryKey: ['tavily-usage-monthly'],
    queryFn: async () => {
      const { data, error } = await supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .from('ct_tavily_usage_monthly' as any)
        .select('*')
        .order('month', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return null;
      return data as UsageRow | null;
    },
    refetchInterval: 60_000,
  });

  if (!data || !data.monthly_limit) return null;
  const t = tier(data.pct);
  const barPct = Math.min(100, Math.max(0, data.pct));

  const lastCallStr = data.last_call_at ? new Date(data.last_call_at).toLocaleString() : 'never';
  const title = `Tavily: ${data.monthly_count.toLocaleString()} / ${data.monthly_limit.toLocaleString()} this month (last call ${lastCallStr})`;

  return (
    <Link to="/budget" className={`inline-flex items-center gap-2 rounded-md px-2 py-1 text-[10px] font-medium ${t.bg} ${t.fg} hover:brightness-125 transition-all`} title={title}>
      <span className="uppercase tracking-wider opacity-70">TVLY</span>
      <span className="tabular-nums font-semibold">{data.pct}%</span>
      <div className="h-1 w-16 overflow-hidden rounded-full bg-black/40">
        <div className={`h-full ${t.fg.replace('text-', 'bg-')}`} style={{ width: `${barPct}%` }} />
      </div>
      <span className="opacity-70 tabular-nums">{data.monthly_count.toLocaleString()}/{data.monthly_limit.toLocaleString()}</span>
      <span className="uppercase tracking-wider font-bold">{t.label}</span>
    </Link>
  );
}
