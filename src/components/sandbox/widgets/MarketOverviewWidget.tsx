import { useState, useEffect, useCallback } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import type { WidgetProps } from '@/types/widget';

interface Quote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  high: number;
  low: number;
  previousClose: number;
}

const MARKET_SYMBOLS = ['SPY', 'QQQ', 'DIA', 'GLD', 'USO'];
const CRYPTO_SYMBOLS = ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT'];

function changeColor(change: number): string {
  if (change > 0) return 'text-emerald-400';
  if (change < 0) return 'text-red-400';
  return 'text-white/40';
}

function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return price.toFixed(2);
}

function formatChange(change: number, percent: number): string {
  const sign = change > 0 ? '+' : '';
  return `${sign}${change.toFixed(2)} (${sign}${percent.toFixed(2)}%)`;
}

export default function MarketOverviewWidget({ compact, activeTab, expanded }: WidgetProps) {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const tab = activeTab || 'markets';

  const fetchQuotes = useCallback(async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const { data, error: fnError } = await supabase.functions.invoke('market-quotes', {
        body: {},
      });

      if (fnError) {
        setError(fnError.message || 'Failed to fetch quotes');
        return;
      }

      if (data?.quotes) {
        setQuotes(data.quotes);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch quotes');
    }
  }, []);

  useEffect(() => {
    fetchQuotes().finally(() => setLoading(false));

    const interval = setInterval(fetchQuotes, 300000);
    return () => clearInterval(interval);
  }, [fetchQuotes]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-[10px] text-white/30">Loading...</span>
      </div>
    );
  }

  if (error && quotes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-white/30">
        <TrendingDown className="w-6 h-6" />
        <span className="text-[11px]">{error}</span>
      </div>
    );
  }

  const filtered = quotes.filter(q =>
    tab === 'crypto'
      ? CRYPTO_SYMBOLS.includes(q.symbol)
      : MARKET_SYMBOLS.includes(q.symbol)
  );

  if (filtered.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-white/30">
        <Minus className="w-6 h-6" />
        <span className="text-[11px]">No data available</span>
      </div>
    );
  }

  const limit = compact ? 3 : filtered.length;
  const visible = filtered.slice(0, limit);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {visible.map(quote => (
        <div
          key={quote.symbol}
          className="flex items-center gap-2 px-3 py-2 border-b border-white/5 last:border-b-0"
        >
          <div className="flex-1 min-w-0">
            <p className="text-[11px] text-white/70 line-clamp-1">{quote.name}</p>
            {expanded && (
              <div className="flex gap-3 mt-0.5">
                <span className="text-[9px] text-white/30">H {formatPrice(quote.high)}</span>
                <span className="text-[9px] text-white/30">L {formatPrice(quote.low)}</span>
                <span className="text-[9px] text-white/30">PC {formatPrice(quote.previousClose)}</span>
              </div>
            )}
          </div>

          <div className="flex flex-col items-end shrink-0">
            <span className="text-[12px] font-semibold text-white/80">
              {formatPrice(quote.price)}
            </span>
            <span className={`text-[9px] ${changeColor(quote.change)}`}>
              {formatChange(quote.change, quote.changePercent)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
