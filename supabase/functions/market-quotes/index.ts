import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserIdWithServiceRole } from '../_shared/auth.ts';

const DEFAULT_SYMBOLS = ['SPY', 'QQQ', 'DIA', 'GLD', 'USO', 'BINANCE:BTCUSDT', 'BINANCE:ETHUSDT'];

const NAME_MAP: Record<string, string> = {
  SPY: 'S&P 500',
  QQQ: 'Nasdaq 100',
  DIA: 'Dow 30',
  GLD: 'Gold',
  USO: 'Crude Oil',
  'BINANCE:BTCUSDT': 'Bitcoin',
  'BINANCE:ETHUSDT': 'Ethereum',
};

interface QuoteResult {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  high: number;
  low: number;
  previousClose: number;
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);

  try {
    const body = await req.json().catch(() => ({}));

    const { userId, error: authError } = await extractUserIdWithServiceRole(req, body);
    if (authError || !userId) {
      return new Response(JSON.stringify({ error: authError ?? 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const apiKey = Deno.env.get('FINNHUB_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'FINNHUB_API_KEY not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const symbols: string[] = Array.isArray(body.symbols) && body.symbols.length > 0
      ? body.symbols
      : DEFAULT_SYMBOLS;

    const results = await Promise.allSettled(
      symbols.map(async (symbol: string) => {
        const res = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`
        );
        if (!res.ok) throw new Error(`Finnhub returned ${res.status} for ${symbol}`);
        const data = await res.json();
        return {
          symbol,
          name: NAME_MAP[symbol] || symbol,
          price: data.c,
          change: data.d,
          changePercent: data.dp,
          high: data.h,
          low: data.l,
          previousClose: data.pc,
        } as QuoteResult;
      })
    );

    const quotes: QuoteResult[] = [];
    const errors: string[] = [];

    for (const result of results) {
      if (result.status === 'fulfilled') {
        // Skip quotes with all-zero data (Finnhub returns zeros for invalid/unsupported symbols)
        if (result.value.price === 0 && result.value.previousClose === 0) {
          errors.push(`${result.value.symbol}: returned zero data (unsupported or market closed)`);
          console.warn(`[market-quotes] Zero data for ${result.value.symbol}`);
        } else {
          quotes.push(result.value);
        }
      } else {
        const errMsg = result.reason?.message || 'Unknown error';
        errors.push(errMsg);
        console.error(`[market-quotes] Symbol fetch failed: ${errMsg}`);
      }
    }

    console.log(`[market-quotes] ${quotes.length} quotes fetched, ${errors.length} errors`);

    const response: Record<string, unknown> = {
      quotes,
      timestamp: new Date().toISOString(),
    };
    if (errors.length > 0) response.errors = errors;

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error in market-quotes:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal server error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
