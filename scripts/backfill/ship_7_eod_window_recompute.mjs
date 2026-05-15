#!/usr/bin/env node
/**
 * Ship 7 α — EOD scorecard window-correction backfill
 *
 * Recomputes alpha_pct (in morning_brief_scorecard) + session_pct + session_range_pct
 * (in per_ticker_close) for every ct_eod_reports row since 2026-04-29 using the
 * CORRECT full-session ct_price_bars window via per-ticker REST queries (each
 * under the PostgREST 1000-row cap that was silently truncating the producer).
 *
 * Surgical UPDATE: touches ONLY the two JSONB fields. Sonnet prose (commentary,
 * carryover_thesis, lessons_today, etc.) is preserved verbatim — the prompt
 * already echoes alpha_pct/session_pct from input, so the Sonnet text was
 * grading on the correct framing within the broken-window-math constraints
 * (i.e. it said "AAPL +0.3% beat the call" when actual close was -1.8%; the
 * +0.3% pre-market figure was the input it had).
 *
 * Run: SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill/ship_7_eod_window_recompute.mjs
 * Or:  KEY=$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd | grep service_role | awk '{print $NF}') && \
 *      SUPABASE_SERVICE_ROLE_KEY=$KEY node scripts/backfill/ship_7_eod_window_recompute.mjs
 *
 * Outputs row counts + per-session diff for audit.
 */

const SUPABASE_URL = 'https://rvhyotvklfowklzjahdd.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY env var required');
  process.exit(1);
}

const REST = `${SUPABASE_URL}/rest/v1`;
const HEADERS = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
};

async function rest(path, opts = {}) {
  const r = await fetch(`${REST}${path}`, {
    ...opts,
    headers: { ...HEADERS, ...(opts.headers || {}) },
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`REST ${path} → ${r.status} ${t}`);
  }
  if (r.status === 204) return null;
  return r.json();
}

/** Mirror of dailyMoveFromBars in ct-eod-report/index.ts. */
function dailyMoveFromBars(rows) {
  if (!rows || rows.length === 0) {
    return { open: null, close: null, high: null, low: null, pct: null, rangePct: null };
  }
  // Sort ascending by ts (REST returns ASC already, but defensive).
  rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const first = rows[0];
  const last = rows[rows.length - 1];
  const o = Number(first.open);
  const c = Number(last.close);
  let hi = -Infinity, lo = Infinity;
  for (const r of rows) {
    const h = Number(r.high), l = Number(r.low);
    if (Number.isFinite(h) && h > hi) hi = h;
    if (Number.isFinite(l) && l < lo) lo = l;
  }
  if (!Number.isFinite(hi)) hi = c;
  if (!Number.isFinite(lo)) lo = c;
  const pct = (Number.isFinite(o) && Number.isFinite(c) && o !== 0) ? ((c - o) / o) * 100 : null;
  const rangePct = (Number.isFinite(hi) && Number.isFinite(lo) && o !== 0 && Number.isFinite(o)) ? ((hi - lo) / o) * 100 : null;
  return {
    open: Number.isFinite(o) ? o : null,
    close: Number.isFinite(c) ? c : null,
    high: Number.isFinite(hi) ? hi : null,
    low: Number.isFinite(lo) ? lo : null,
    pct: pct != null ? Math.round(pct * 100) / 100 : null,
    rangePct: rangePct != null ? Math.round(rangePct * 100) / 100 : null,
  };
}

async function getBarsForTicker(ticker, dayStartIso, dayEndIso) {
  const q = `/ct_price_bars?select=ticker,ts,timeframe,open,high,low,close&ticker=eq.${ticker}&timeframe=in.(1m,5m)&ts=gte.${dayStartIso}&ts=lte.${dayEndIso}&order=ts.asc&limit=4000`;
  return rest(q);
}

/** computeVerdict mirror — must match supabase/functions/ct-eod-report/index.ts. */
function computeVerdict(openTilt, sessionPct, sessionRangePct, thresholds) {
  if (sessionPct == null || !Number.isFinite(Number(sessionPct))) return 'neutral';
  const pct = Number(sessionPct);
  const range = sessionRangePct != null ? Number(sessionRangePct) : null;
  const { leanWinPct, neutralLossPct, avoidChopRangePct } = thresholds;

  if (openTilt === 'long_lean') {
    if (pct >= leanWinPct) return 'win';
    if (pct <= -neutralLossPct) return 'loss';
    return pct > 0 ? 'partial' : 'neutral';
  }
  if (openTilt === 'short_lean') {
    if (pct <= -leanWinPct) return 'win';
    if (pct >= neutralLossPct) return 'loss';
    return pct < 0 ? 'partial' : 'neutral';
  }
  if (openTilt === 'avoid' || openTilt === 'skip') {
    if (range != null && range >= avoidChopRangePct) return 'loss';
    return 'win';
  }
  // neutral / null tilt
  if (Math.abs(pct) >= neutralLossPct) return 'loss';
  return 'neutral';
}

function summarizeScorecard(rows) {
  let wins = 0, partials = 0, neutrals = 0, losses = 0;
  for (const r of rows) {
    if (r.verdict === 'win') wins++;
    else if (r.verdict === 'partial') partials++;
    else if (r.verdict === 'loss') losses++;
    else neutrals++;
  }
  const n = rows.length;
  const score_pct = n > 0 ? Math.round(((wins + 0.5 * partials) / n) * 100) : null;
  return { wins, partials, neutrals, losses, score_pct };
}

async function getThresholds() {
  // Match defaults from ct-eod-report/index.ts.
  const cfg = await rest(`/ct_config?select=key,value&key=in.(eod_report_verdict_lean_win_pct,eod_report_verdict_neutral_loss_pct,eod_report_verdict_avoid_chop_range_pct)`);
  const map = new Map((cfg || []).map((r) => [r.key, r.value]));
  const num = (k, d) => {
    const v = map.get(k);
    if (v == null) return d;
    const n = Number(typeof v === 'object' ? v.value ?? v : v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    leanWinPct: num('eod_report_verdict_lean_win_pct', 0.4),
    neutralLossPct: num('eod_report_verdict_neutral_loss_pct', 0.8),
    avoidChopRangePct: num('eod_report_verdict_avoid_chop_range_pct', 1.5),
  };
}

async function main() {
  const thresholds = await getThresholds();
  console.log('thresholds:', thresholds);

  const reports = await rest('/ct_eod_reports?select=id,session_date,per_ticker_close,morning_brief_scorecard,scorecard_summary&session_date=gte.2026-04-29&order=session_date.asc');
  console.log(`pulled ${reports.length} EOD reports since 2026-04-29`);

  let totalUpdated = 0;
  let totalTickersTouched = 0;
  const auditTrail = [];

  for (const report of reports) {
    const { id, session_date, per_ticker_close, morning_brief_scorecard } = report;
    // Window: NY day midnight ≈ 04:00 UTC; session end ≈ 21:00 UTC. Match producer.
    const dayStartIso = `${session_date}T04:00:00Z`;
    // Use end-of-trading-day UTC anchor (after-hours runs to 00:00 UTC next day,
    // but EOD report's now() at fire is typically 21:00-21:30 UTC; for backfill
    // we want the close-of-RTH window, so cap at 20:00 UTC + 30m grace).
    const dayEndIso = `${session_date}T20:30:00Z`;

    const tickers = (per_ticker_close || []).map((c) => c.ticker).filter(Boolean);
    if (tickers.length === 0) {
      console.log(`${session_date}: skipped (no per_ticker_close rows)`);
      continue;
    }

    // Fan-out: one query per ticker.
    const barsByTicker = new Map();
    const fetchResults = await Promise.all(
      tickers.map(async (t) => {
        const rows = await getBarsForTicker(t, dayStartIso, dayEndIso);
        return { t, rows };
      }),
    );
    for (const { t, rows } of fetchResults) {
      barsByTicker.set(t, rows || []);
    }

    // Rewrite per_ticker_close with corrected math.
    const oldByTicker = new Map((per_ticker_close || []).map((c) => [c.ticker, c]));
    const oldScorecardByTicker = new Map((morning_brief_scorecard || []).map((c) => [c.ticker, c]));

    const newPerTickerClose = (per_ticker_close || []).map((c) => {
      const move = dailyMoveFromBars(barsByTicker.get(c.ticker));
      return {
        ...c,
        session_pct: move.pct,
        session_range_pct: move.rangePct,
      };
    });

    // Rewrite morning_brief_scorecard with corrected alpha_pct + verdict +
    // updated actual_outcome string. Commentary (Sonnet prose) preserved
    // verbatim — captain decision: prose echoes the broken pct so it'd read
    // inconsistent vs corrected alpha_pct, but rewriting prose requires
    // re-running Sonnet. Out of scope for this surgical pass; flagged as
    // potential follow-up.
    const newScorecard = (morning_brief_scorecard || []).map((sc) => {
      const move = dailyMoveFromBars(barsByTicker.get(sc.ticker));
      // Need open_tilt for verdict recompute — pull from per_ticker_close.
      const cl = oldByTicker.get(sc.ticker);
      const openTilt = cl?.open_tilt ?? null;
      const newVerdict = computeVerdict(openTilt, move.pct, move.rangePct, thresholds);
      // Update actual_outcome string to reflect corrected close. Preserve
      // the flow-side suffix if present (after the · separator).
      const oldOutcome = sc.actual_outcome ?? '';
      const flowSuffix = (() => {
        const i = oldOutcome.indexOf('·');
        return i >= 0 ? ` ·${oldOutcome.slice(i + 1)}` : '';
      })();
      const newOutcome = move.pct != null
        ? `closed ${move.pct >= 0 ? '+' : ''}${move.pct.toFixed(2)}%${flowSuffix}`
        : `no price data${flowSuffix}`;
      return {
        ...sc,
        alpha_pct: move.pct,
        verdict: newVerdict,
        actual_outcome: newOutcome,
      };
    });

    const newSummary = summarizeScorecard(newScorecard);

    // UPDATE the three JSONB fields. Surgical — leaves session_summary,
    // regime_close, carryover_themes, lessons_today, etc. untouched.
    const r = await fetch(`${REST}/ct_eod_reports?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify({
        per_ticker_close: newPerTickerClose,
        morning_brief_scorecard: newScorecard,
        scorecard_summary: newSummary,
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error(`${session_date}: UPDATE failed → ${r.status} ${t}`);
      continue;
    }

    totalUpdated++;
    totalTickersTouched += tickers.length;

    // Audit diff: old vs new score_pct + a couple sample tickers.
    const oldSummary = report.scorecard_summary || {};
    const sample = newScorecard.slice(0, 2).map((sc) => {
      const oldSc = oldScorecardByTicker.get(sc.ticker) || {};
      return `${sc.ticker}: alpha ${oldSc.alpha_pct ?? 'null'}→${sc.alpha_pct ?? 'null'}, verdict ${oldSc.verdict}→${sc.verdict}`;
    }).join(' | ');
    auditTrail.push({ session_date, oldScore: oldSummary.score_pct, newScore: newSummary.score_pct, sample });
    console.log(`${session_date}: ${tickers.length} tickers · score_pct ${oldSummary.score_pct}% → ${newSummary.score_pct}% · ${sample}`);
  }

  console.log('\n=== SUMMARY ===');
  console.log(`reports updated: ${totalUpdated}`);
  console.log(`ticker-session cells re-computed: ${totalTickersTouched}`);
  console.log('\nper-session score_pct shift:');
  for (const a of auditTrail) {
    console.log(`  ${a.session_date}: ${a.oldScore}% → ${a.newScore}%`);
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
