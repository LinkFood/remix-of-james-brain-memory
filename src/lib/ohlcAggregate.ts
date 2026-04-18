/**
 * ohlcAggregate — bucket ct_price_ticks into OHLC bars.
 *
 * Input: list of ticks with tick_time (ISO) + price (and optional volume).
 * Output: sparse array of OHLC bars keyed by floor-bucketed timestamps.
 *
 * Bucket logic: each bar's time_bucket is floor(tick_ms / bucketMs) * bucketMs,
 * in epoch ms (UTC). Missing buckets are NOT filled — sparse output is fine
 * because candle renderers treat each bar independently on a time-number axis.
 *
 * Within a bucket:
 *   open  = first tick in time order
 *   close = last tick in time order
 *   high  = max price
 *   low   = min price
 *   volume = sum of tick.volume if present, else undefined
 */

export interface PriceTick {
  /** ISO timestamp. */
  tick_time: string;
  /** Last trade price (or mid, per capture convention). */
  price: number;
  /** Optional volume/size — ct_price_ticks doesn't always carry it. */
  volume?: number | null;
}

export interface OhlcBar {
  /** Epoch ms at the bucket floor (UTC). */
  time_bucket: number;
  /** ISO of the bucket floor (convenience). */
  iso: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Undefined when ticks don't carry volume. */
  volume?: number;
  /** Number of ticks that contributed — useful for sparseness warnings. */
  n: number;
}

const MIN_MS = 60_000;

/**
 * Aggregate ticks into OHLC bars.
 *
 * @param ticks ct_price_ticks rows (any order — will be sorted internally).
 * @param intervalMin bucket width in minutes. Default 5.
 * @returns OHLC bars sorted ascending by time_bucket. Sparse — gaps not filled.
 */
export function aggregateToOhlc(
  ticks: PriceTick[],
  intervalMin = 5,
): OhlcBar[] {
  if (!Array.isArray(ticks) || ticks.length === 0) return [];
  const bucketMs = Math.max(1, Math.floor(intervalMin)) * MIN_MS;

  // Normalize + parse + drop non-finite prices.
  const parsed: Array<{ t: number; price: number; volume: number | null }> = [];
  for (const tk of ticks) {
    if (!tk || typeof tk.tick_time !== 'string') continue;
    const t = Date.parse(tk.tick_time);
    if (!Number.isFinite(t)) continue;
    const p = typeof tk.price === 'number' ? tk.price : Number(tk.price);
    if (!Number.isFinite(p)) continue;
    const v =
      typeof tk.volume === 'number' && Number.isFinite(tk.volume)
        ? tk.volume
        : null;
    parsed.push({ t, price: p, volume: v });
  }
  if (parsed.length === 0) return [];
  parsed.sort((a, b) => a.t - b.t);

  // Fold into buckets.
  const buckets = new Map<number, OhlcBar>();
  for (const { t, price, volume } of parsed) {
    const key = Math.floor(t / bucketMs) * bucketMs;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        time_bucket: key,
        iso: new Date(key).toISOString(),
        open: price,
        high: price,
        low: price,
        close: price,
        volume: volume ?? undefined,
        n: 1,
      });
    } else {
      // Ticks already sorted ascending ⇒ open stays, close updates each hit.
      existing.close = price;
      if (price > existing.high) existing.high = price;
      if (price < existing.low) existing.low = price;
      if (volume !== null) {
        existing.volume = (existing.volume ?? 0) + volume;
      }
      existing.n += 1;
    }
  }

  return Array.from(buckets.values()).sort(
    (a, b) => a.time_bucket - b.time_bucket,
  );
}
