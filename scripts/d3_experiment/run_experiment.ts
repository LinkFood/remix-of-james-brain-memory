/**
 * D3 Feature-Isolation Experiment — orchestrator.
 *
 * Filled in 2026-05-07. Pulls ct_specialist_reads in a window, fans out the
 * 8 feature loaders per wakeup, writes one row per (ticker, wakeup_at,
 * generation_id) into ct_d3_feature_observations.
 *
 * Brief: scope/2026-05-08-d3-feature-isolation-experiment.md
 *
 * Run mode: analysis-mode (Tenet 26). Terminal-Claude / shell invokes;
 * never wired as an edge function.
 *
 * CLI flags:
 *   --window=14                         (days, default 14)
 *   --tickers=SPY,QQQ,...               (default = canonical 10)
 *   --start=2026-05-06T13:30:00Z        (overrides --window if set)
 *   --end=2026-05-06T20:00:00Z          (overrides --window if set)
 *   --dry-run                           (no write — distributions only)
 *   --tag=label                         (append to generation_id)
 */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.84.0";
import {
  reconstructFeatures,
  type FeatureVector,
  type Wakeup,
} from "./feature_reconstruction.ts";

// The createClient<T> default generics drift between supabase-js minor
// versions; the loaders in feature_reconstruction.ts are typed against the
// neutral SupabaseClient. Centralize the cast at the boundary.
type AnyClient = SupabaseClient;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const URL = Deno.env.get("SUPABASE_URL") ?? "https://rvhyotvklfowklzjahdd.supabase.co";
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");

const TICKERS_DEFAULT = [
  "NVDA", "AAPL", "AMZN", "TSLA", "IWM",
  "GOOGL", "META", "QQQ", "SPY", "MSFT",
];

const BATCH_SIZE = 25;            // wakeups per parallel batch
const WRITE_CHUNK = 100;          // rows per upsert call

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  windowDays: number;
  tickers: string[];
  start: string | null;
  end: string | null;
  dryRun: boolean;
  tag: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    windowDays: 14,
    tickers: TICKERS_DEFAULT,
    start: null,
    end: null,
    dryRun: false,
    tag: null,
  };
  for (const a of argv) {
    if (a.startsWith("--window=")) out.windowDays = Number(a.slice(9));
    else if (a.startsWith("--tickers=")) {
      out.tickers = a.slice(10).split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
    }
    else if (a.startsWith("--start=")) out.start = a.slice(8);
    else if (a.startsWith("--end=")) out.end = a.slice(6);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--tag=")) out.tag = a.slice(6);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Generation tag
// ---------------------------------------------------------------------------

function makeGenerationId(tag: string | null): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return tag ? `d3_${tag}_${ts}` : `d3_run_${ts}`;
}

// ---------------------------------------------------------------------------
// Wakeup pull (per-ticker, paginated DESC, scoped to window)
// ---------------------------------------------------------------------------

interface SpecialistReadRow {
  id: number;
  ticker: string;
  updated_at: string;
  conviction: number | null;
  direction_lean: string | null;
}

async function pullWakeupsForTicker(
  supabase: AnyClient,
  ticker: string,
  startIso: string,
  endIso: string,
): Promise<Wakeup[]> {
  const out: Wakeup[] = [];
  const PAGE = 1000;
  let from = 0;
  for (let pageIdx = 0; pageIdx < 20; pageIdx++) {
    const { data, error } = await supabase
      .from("ct_specialist_reads")
      .select("id, ticker, updated_at, conviction, direction_lean")
      .eq("ticker", ticker)
      .gte("updated_at", startIso)
      .lte("updated_at", endIso)
      .order("updated_at", { ascending: false })  // DESC per starvation lesson
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`pull_wakeups[${ticker}] page ${pageIdx}: ${error.message}`);
    const batch = (data ?? []) as SpecialistReadRow[];
    for (const r of batch) {
      out.push({
        ticker: r.ticker,
        wakeup_at: r.updated_at,
        conviction: typeof r.conviction === "number" ? r.conviction : 0,
        read_id: String(r.id),
      });
    }
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function pullWakeups(
  supabase: AnyClient,
  tickers: string[],
  startIso: string,
  endIso: string,
): Promise<Wakeup[]> {
  const all: Wakeup[] = [];
  for (const t of tickers) {
    const rows = await pullWakeupsForTicker(supabase, t, startIso, endIso);
    all.push(...rows);
  }
  // Sort ascending by wakeup_at so logs show chronological progress.
  all.sort((a, b) => Date.parse(a.wakeup_at) - Date.parse(b.wakeup_at));
  return all;
}

// ---------------------------------------------------------------------------
// Cluster assignment (per brief §4)
// ---------------------------------------------------------------------------

function assignCluster(conviction: number): "low" | "mid" | "high" {
  if (conviction <= 45) return "low";
  if (conviction >= 55) return "high";
  return "mid";
}

// ---------------------------------------------------------------------------
// Output writer
// ---------------------------------------------------------------------------

interface ObservationRow extends FeatureVector {
  generation_id: string;
  ticker: string;
  wakeup_at: string;
  read_id: string;
  conviction: number;
  cluster: "low" | "mid" | "high";
  reconstruction_error_flags: Record<string, string[]>;
}

async function writeObservations(
  supabase: AnyClient,
  rows: ObservationRow[],
): Promise<{ written: number; errors: string[] }> {
  const errors: string[] = [];
  let written = 0;
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    const payload = chunk.map((r) => ({
      generation_id: r.generation_id,
      ticker: r.ticker,
      wakeup_at: r.wakeup_at,
      read_id: r.read_id,
      conviction: r.conviction,
      cluster: r.cluster,
      f1_flow_pulse_unusual: r.f1_flow_pulse_unusual,
      f2_heatmap_front_week_value: r.f2_heatmap_front_week_value,
      f3_regime: r.f3_regime,
      f4_news_count: r.f4_news_count,
      f4_news_max_severity: r.f4_news_max_severity,
      f5_event_recency_present: r.f5_event_recency_present,
      f6_signature_alarm_count: r.f6_signature_alarm_count,
      f7_has_0dte_today: r.f7_has_0dte_today,
      f8_last_flag_outcome: r.f8_last_flag_outcome,
      reconstruction_error_flags: r.reconstruction_error_flags,
    }));
    // Cast through unknown — supabase-js generic inference for upsert
    // collapses the row type to `never` when no Database typing is supplied.
    const { error } = await (supabase
      .from("ct_d3_feature_observations") as unknown as {
        upsert: (v: unknown[], opts: { onConflict: string }) => Promise<{ error: { message: string } | null }>;
      })
      .upsert(payload as unknown[], { onConflict: "generation_id,ticker,wakeup_at" });
    if (error) errors.push(`chunk_${i}:${error.message}`);
    else written += chunk.length;
  }
  return { written, errors };
}

// ---------------------------------------------------------------------------
// Distribution summary (printed at end)
// ---------------------------------------------------------------------------

interface Distribution {
  total: number;
  withErrors: number;
  perLoaderErrors: Record<string, number>;
  f1: { true: number; false: number; null: number };
  f2: { positive: number; negative: number; zero: number; null: number };
  f3: Record<string, number>;
  f4_news_count: { p50: number; p95: number; max: number; nonzero_pct: number };
  f4_max_severity: Record<string, number>;
  f5_present_pct: number;
  f6_distribution: Record<string, number>; // "0", "1", "2+"
  f7_true_pct: number;
  f8: Record<string, number>;
  per_ticker_count: Record<string, number>;
  cluster_count: Record<string, number>;
}

function summarize(rows: ObservationRow[]): Distribution {
  const dist: Distribution = {
    total: rows.length,
    withErrors: 0,
    perLoaderErrors: {},
    f1: { true: 0, false: 0, null: 0 },
    f2: { positive: 0, negative: 0, zero: 0, null: 0 },
    f3: {},
    f4_news_count: { p50: 0, p95: 0, max: 0, nonzero_pct: 0 },
    f4_max_severity: {},
    f5_present_pct: 0,
    f6_distribution: { "0": 0, "1": 0, "2+": 0 },
    f7_true_pct: 0,
    f8: {},
    per_ticker_count: {},
    cluster_count: {},
  };
  const newsCounts: number[] = [];
  let f5True = 0, f7True = 0, f4Nonzero = 0;
  for (const r of rows) {
    dist.per_ticker_count[r.ticker] = (dist.per_ticker_count[r.ticker] ?? 0) + 1;
    dist.cluster_count[r.cluster] = (dist.cluster_count[r.cluster] ?? 0) + 1;

    const errs = r.reconstruction_error_flags?.errors ?? [];
    if (errs.length > 0) {
      dist.withErrors++;
      for (const e of errs) {
        const loader = e.split(":")[0];
        dist.perLoaderErrors[loader] = (dist.perLoaderErrors[loader] ?? 0) + 1;
      }
    }

    if (r.f1_flow_pulse_unusual === true) dist.f1.true++;
    else if (r.f1_flow_pulse_unusual === false) dist.f1.false++;
    else dist.f1.null++;

    if (r.f2_heatmap_front_week_value === null) dist.f2.null++;
    else if (r.f2_heatmap_front_week_value > 0) dist.f2.positive++;
    else if (r.f2_heatmap_front_week_value < 0) dist.f2.negative++;
    else dist.f2.zero++;

    const r3 = r.f3_regime ?? "null";
    dist.f3[r3] = (dist.f3[r3] ?? 0) + 1;

    newsCounts.push(r.f4_news_count);
    if (r.f4_news_count > 0) f4Nonzero++;
    const sev = r.f4_news_max_severity == null ? "null" : String(r.f4_news_max_severity);
    dist.f4_max_severity[sev] = (dist.f4_max_severity[sev] ?? 0) + 1;

    if (r.f5_event_recency_present) f5True++;

    const f6Bucket = r.f6_signature_alarm_count === 0 ? "0"
      : r.f6_signature_alarm_count === 1 ? "1" : "2+";
    dist.f6_distribution[f6Bucket]++;

    if (r.f7_has_0dte_today) f7True++;

    const out = r.f8_last_flag_outcome ?? "null";
    dist.f8[out] = (dist.f8[out] ?? 0) + 1;
  }

  newsCounts.sort((a, b) => a - b);
  const p = (q: number) =>
    newsCounts.length === 0 ? 0 : newsCounts[Math.min(newsCounts.length - 1, Math.floor(newsCounts.length * q))];
  dist.f4_news_count.p50 = p(0.5);
  dist.f4_news_count.p95 = p(0.95);
  dist.f4_news_count.max = newsCounts.length === 0 ? 0 : newsCounts[newsCounts.length - 1];
  dist.f4_news_count.nonzero_pct = rows.length === 0 ? 0 : (f4Nonzero / rows.length) * 100;

  dist.f5_present_pct = rows.length === 0 ? 0 : (f5True / rows.length) * 100;
  dist.f7_true_pct = rows.length === 0 ? 0 : (f7True / rows.length) * 100;
  return dist;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function processBatch(
  supabase: AnyClient,
  batch: Wakeup[],
  generationId: string,
): Promise<ObservationRow[]> {
  const results = await Promise.all(
    batch.map(async (w) => {
      const { features, errors } = await reconstructFeatures(supabase, w);
      const row: ObservationRow = {
        generation_id: generationId,
        ticker: w.ticker,
        wakeup_at: w.wakeup_at,
        read_id: w.read_id,
        conviction: w.conviction,
        cluster: assignCluster(w.conviction),
        reconstruction_error_flags: errors.length > 0 ? { errors } : {},
        ...features,
      };
      return row;
    }),
  );
  return results;
}

async function main() {
  const args = parseArgs(Deno.args);
  const supabase = createClient(URL, KEY!) as unknown as AnyClient;
  const generationId = makeGenerationId(args.tag);

  const endIso = args.end ?? new Date().toISOString();
  const startIso = args.start ??
    new Date(Date.parse(endIso) - args.windowDays * 24 * 60 * 60 * 1000).toISOString();

  console.log(`[d3] generation=${generationId}`);
  console.log(`[d3] window=${startIso}..${endIso}`);
  console.log(`[d3] tickers=${args.tickers.join(",")}`);
  console.log(`[d3] dry-run=${args.dryRun}`);

  const t0 = Date.now();
  const wakeups = await pullWakeups(supabase, args.tickers, startIso, endIso);
  console.log(`[d3] pulled ${wakeups.length} wakeups in ${Date.now() - t0}ms`);
  if (wakeups.length === 0) {
    console.log(`[d3] DONE generation=${generationId} (no wakeups)`);
    return;
  }

  const allRows: ObservationRow[] = [];
  for (let i = 0; i < wakeups.length; i += BATCH_SIZE) {
    const batch = wakeups.slice(i, i + BATCH_SIZE);
    const tBatch = Date.now();
    const rows = await processBatch(supabase, batch, generationId);
    allRows.push(...rows);
    console.log(
      `[d3] batch ${i / BATCH_SIZE + 1}/${Math.ceil(wakeups.length / BATCH_SIZE)} ` +
      `(${batch.length} wakeups, ${Date.now() - tBatch}ms)`,
    );
  }

  const dist = summarize(allRows);
  console.log(`[d3] DISTRIBUTION:`);
  console.log(JSON.stringify(dist, null, 2));

  if (args.dryRun) {
    console.log(`[d3] DRY-RUN — skipping write. ${allRows.length} rows would be written.`);
  } else {
    const wt = Date.now();
    const { written, errors } = await writeObservations(supabase, allRows);
    console.log(`[d3] wrote ${written}/${allRows.length} rows in ${Date.now() - wt}ms`);
    if (errors.length > 0) {
      console.log(`[d3] write errors:`, errors);
    }
  }

  console.log(`[d3] DONE generation=${generationId} total=${Date.now() - t0}ms`);
}

if (import.meta.main) {
  await main();
}
