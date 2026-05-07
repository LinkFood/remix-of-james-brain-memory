/**
 * D3 Feature-Isolation Experiment — orchestrator.
 *
 * Status: SCAFFOLD ONLY (2026-05-08). Wakeup pull and write logic
 * skeletoned; loaders in feature_reconstruction.ts are stubs. Do NOT
 * run today.
 *
 * Brief: scope/2026-05-08-d3-feature-isolation-experiment.md
 *
 * Run mode: analysis-mode (Tenet 26). Terminal-Claude invokes; never wired
 * as an edge function. Daily window-extension cron is the ONE exception
 * (see cron_schedule.sql) and only runs after loaders verified.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.84.0";
import {
  reconstructFeatures,
  type FeatureVector,
  type Wakeup,
} from "./feature_reconstruction.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const URL = Deno.env.get("SUPABASE_URL") ?? "https://rvhyotvklfowklzjahdd.supabase.co";
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");

const TICKERS = [
  "NVDA", "AAPL", "AMZN", "TSLA", "IWM",
  "GOOGL", "META", "QQQ", "SPY", "MSFT",
];

const WINDOW_DAYS = 14;
const BATCH_SIZE = 25;            // wakeups per parallel batch
const PARALLEL_FEATURE_FANOUT = 7; // matches reconstructFeatures Promise.all

// ---------------------------------------------------------------------------
// Generation tag — groups all rows from a single run
// ---------------------------------------------------------------------------

function makeGenerationId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `d3_run_${ts}`;
}

// ---------------------------------------------------------------------------
// Wakeup pull
// ---------------------------------------------------------------------------

async function pullWakeups(
  supabase: ReturnType<typeof createClient>,
  windowStart: string,
  windowEnd: string,
): Promise<Wakeup[]> {
  // PostgREST 1000-row cap → paginate via .range() per ticker.
  // TODO: implement per-ticker scan with .range() pagination, sort DESC
  //       (createMissingTracks lesson).
  void supabase; void windowStart; void windowEnd;
  return [];
}

// ---------------------------------------------------------------------------
// Output writer
// ---------------------------------------------------------------------------

async function writeObservations(
  supabase: ReturnType<typeof createClient>,
  rows: Array<Wakeup & FeatureVector & { generation_id: string; cluster: string }>,
): Promise<void> {
  // TODO: upsert into ct_d3_feature_observations on (ticker, wakeup_at, generation_id).
  //       Batch in chunks of 100. Service role bypasses RLS by design.
  void supabase; void rows;
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  const supabase = createClient(URL, KEY!);
  const generationId = makeGenerationId();

  const windowEnd = new Date().toISOString();
  const windowStart = new Date(
    Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  console.log(`[d3] generation=${generationId} window=${windowStart}..${windowEnd}`);
  console.log(`[d3] tickers=${TICKERS.join(",")}`);

  const wakeups = await pullWakeups(supabase, windowStart, windowEnd);
  console.log(`[d3] pulled ${wakeups.length} wakeups`);

  // TODO batch wakeups, run reconstructFeatures(...) in BATCH_SIZE parallel,
  // attach cluster + generation_id, hand off to writeObservations.
  void reconstructFeatures;
  void assignCluster;
  void BATCH_SIZE;
  void PARALLEL_FEATURE_FANOUT;

  console.log(`[d3] DONE generation=${generationId}`);
}

if (import.meta.main) {
  await main();
}
