/**
 * /alpha — Tape v2 alpha surface (NEW route, separate from /tape and /tape-v2).
 *
 * Surgical-grade institutional flow diagnostic at one-person scale. Bloomberg-
 * terminal-class identity per captain's brief 2026-05-09. NOT a consumer
 * dashboard, NOT a 0DTE gambling tool. Leading-indicator across three
 * temporal layers (near + medium + long horizon positioning visibility).
 *
 * Architecture (load-bearing, per brief):
 *   - PUSH NOT RENDER. Non-alpha signals (specialists, full news panel,
 *     Flow Pulse, Stacking, alarms, conviction shifts, regime transitions,
 *     hot contracts) push via Slack emission layer (PR #63). Page renders
 *     the four alpha surfaces + Claude's reads of them, nothing else.
 *   - THREE TEMPORAL LAYERS STACK. Top: synthesis (Claude's read). Middle:
 *     leading indicators (Flow Butterfly historical / Heatmap alpha-class /
 *     Curated tape). Bottom: long-horizon positioning depth.
 *   - THE CAPTAIN EMBEDS EVERYTHING. Every read is embedded at write time;
 *     semantic recall surfaces are activated incrementally per surface
 *     (tape commentary first — iter #2; butterfly second; heatmap GEX is
 *     JAC-core kernel work).
 *
 * Iter #1 ships:
 *   - Route + page shell + layout
 *   - AlphaTopStrip (compressed regime/tide/VIX/push count)
 *   - ClaudesRead (full-width synthesis section using existing tape +
 *     specialist hooks)
 *   - Four alpha surfaces as honest placeholders pointing at iter #N
 *
 * Iter #2-#5 wire each surface in turn. See iteration log entries.
 */

import { Card } from '@/components/ui/card';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Activity, Flame, Filter, Layers } from 'lucide-react';
import { AlphaTopStrip } from '@/components/alpha/AlphaTopStrip';
import { ClaudesRead } from '@/components/alpha/ClaudesRead';
import { AlphaPlaceholderSection } from '@/components/alpha/AlphaPlaceholderSection';

export default function Alpha() {
  return (
    <div className="space-y-3 p-4">
      {/* Identity strip — minimal, surgical */}
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-mono uppercase tracking-wider text-muted-foreground">
          Alpha · v2 · surgical diagnostic
        </h1>
        <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground">
          <Link
            to="/tape"
            className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
            title="Original /tape — figure-it-out-yourself surface"
          >
            v1 /tape <ArrowUpRight className="w-3 h-3" />
          </Link>
          <Link
            to="/tape-v2"
            className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
            title="/tape-v2 — command-center composition surface"
          >
            v1 /tape-v2 <ArrowUpRight className="w-3 h-3" />
          </Link>
        </div>
      </div>

      {/* Top strip — compressed regime + tide + VIX + push count */}
      <AlphaTopStrip />

      {/* Synthesis — Claude's read sits at the top of every captain glance */}
      <ClaudesRead />

      {/* Two middle-layer alphas — Flow Butterfly historical (medium) +
          Heatmap alpha-class (near) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <AlphaPlaceholderSection
          icon={Activity}
          label="Flow Butterfly · multi-day arc"
          shippingIn="iter #2"
          rationale="Per-ticker cross magnitude × last 5d, points colored by tertile (s/m/L) and phase. Watchlist consensus rollup row above. Reads from ct_butterfly_cross_events corpus (PR #79/#80; first useful arc once corpus has ≥5 RTH days, ≈ 5/15)."
        />
        <AlphaPlaceholderSection
          icon={Flame}
          label="Heatmap · alpha-class"
          shippingIn="iter #3"
          rationale="Baseline-comparison ON by default. Strike-side dominant direction badges. Drill panel surfaces per-alert conviction + multi-mode agreement. Refactor of current /heatmap with the toolbar surfaced and underutilized cells turned on."
        />
      </div>

      {/* Curated live tape — flagged/stacked contracts only */}
      <AlphaPlaceholderSection
        icon={Filter}
        label="Curated tape · flagged/stacked contracts only"
        shippingIn="iter #4"
        rationale="get_v2_curated_tape RPC composes ct_scored_flow + ct_flags + ct_contract_tracks + ct_specialist_reads filters into 10–30 ranked rows. Same detection floor as PR #63 hot_contract emission (signal/alert tiers). Live, filtered to what the system has classified as worth watching."
      />

      {/* Long-horizon positioning depth */}
      <AlphaPlaceholderSection
        icon={Layers}
        label="Long-dated positioning · OI momentum"
        shippingIn="iter #5"
        rationale="10 tickers × 12 month buckets. Cell color = monthly OI Δ% (building → emerald, leaking → rose). Reveals where institutions are positioned 6–12 months out. Needs ct_oi_monthly_baselines aggregation table + nightly cron + extended OI delta RPC. Bounded by ct_oi_snapshots availability (live since 2026-04-23)."
      />

      {/* Footer rationale — captain reading discipline */}
      <Card className="p-2.5 bg-muted/5 border-muted/20">
        <div className="text-[9.5px] text-muted-foreground/70 leading-snug">
          v2 architecture: push for non-alphas, render for alphas + system reads of them.
          Specialists, Flow Pulse, full news panel, Stacking → off this page; arrive via Slack
          emission. Every iteration appended to <span className="font-mono">docs/audit/tape-v2-iteration-log.md</span>.
          Captain validates each iteration on the live URL.
        </div>
      </Card>
    </div>
  );
}
