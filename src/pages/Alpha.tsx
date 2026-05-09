/**
 * /alpha — Tape v2 alpha surface (NEW route, separate from /tape and /tape-v2).
 *
 * Surgical-grade institutional flow diagnostic at one-person scale. Bloomberg-
 * terminal-class identity per captain's brief 2026-05-09. NOT a consumer
 * dashboard, NOT a 0DTE gambling tool. Leading-indicator across temporal
 * layers (near + medium + long horizon positioning visibility).
 *
 * Architecture (load-bearing, per brief):
 *   - PUSH NOT RENDER. Non-alpha signals (specialists, full news panel,
 *     Flow Pulse, Stacking, alarms, conviction shifts, regime transitions,
 *     hot contracts) push via Slack emission layer (PR #63). Page renders
 *     working alpha surfaces + Claude's reads of them, nothing else.
 *   - THREE TEMPORAL LAYERS STACK. Top: synthesis (Claude's read). Middle:
 *     leading indicators. Bottom: long-horizon positioning depth. Each
 *     layer fills as its surface ships; surfaces don't pre-render as
 *     placeholders.
 *   - THE CAPTAIN EMBEDS EVERYTHING. Every read is embedded at write time;
 *     semantic recall surfaces are activated incrementally per surface
 *     (tape commentary first — Phase 1+4; news second — Phase 2+5).
 *
 * Iter #2.6 (2026-05-09): top specialist reads section + 4 placeholder
 * sections removed per captain decisions. Push-not-render strict;
 * surfaces land in their temporal-layer position when their iter ships.
 * Trajectory captured in docs/audit/tape-v2-iteration-log.md.
 */

import { Card } from '@/components/ui/card';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { AlphaTopStrip } from '@/components/alpha/AlphaTopStrip';
import { TapeReaderArc } from '@/components/alpha/TapeReaderArc';
import { ClaudesRead } from '@/components/alpha/ClaudesRead';
import { NewsCausalityMatrix } from '@/components/alpha/NewsCausalityMatrix';

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

      {/* Tape Reader Arc — today's mood evolution as a single glanceable
          horizontal primitive. Phase 3 of the audit-driven loop. */}
      <TapeReaderArc />

      {/* Synthesis — Claude's read sits at the top of every captain glance.
          Phase 4 (semantic recall) composed inside ClaudesRead. */}
      <ClaudesRead />

      {/* News Causality Matrix — Phase 5 of the audit-driven loop. The
          derived signal documented in ct_news_causality.sql since
          2026-04-16 ("Bloomberg moves NVDA flow 68% of the time") finally
          surfaced. */}
      <NewsCausalityMatrix />

      {/* Footer rationale — captain reading discipline */}
      <Card className="p-2.5 bg-muted/5 border-muted/20">
        <div className="text-[9.5px] text-muted-foreground/70 leading-snug">
          v2 architecture: push for non-alphas, render for alphas + system reads of them.
          Specialists, Flow Pulse, full news panel, Stacking → off this page; arrive via Slack
          emission. Future surfaces (Flow Butterfly multi-day, Heatmap alpha-class, Curated tape,
          Long-dated OI momentum) land in their temporal-layer position when each iter ships.
          Every iteration appended to <span className="font-mono">docs/audit/tape-v2-iteration-log.md</span>.
          Captain validates each iteration on the live URL.
        </div>
      </Card>
    </div>
  );
}
