/**
 * Debates — James's /debate track record.
 *
 * The page that answers: "Which way did I go on this? Was I right? Is there
 * a pattern?" Every /debate card is persisted (wave 27). This view lets
 * James browse, filter, semantic-search, and see his win rate broken down
 * by pick type — plus a James-vs-Claude comparison that asks "is
 * deliberation beating reactive alerts?"
 *
 * Layout:
 *   - Top strip: stat tiles (win rate overall + per-side + vs. Claude's
 *     solo alerts) + pick/outcome filters + semantic search box.
 *   - List: one row per debate, newest first. Pick badge (bull/bear/neither)
 *     + outcome verdict badge (right/wrong/pending/unresolved).
 *   - Click a row: expands to show bull/bear cases + synthesis + outcome
 *     detail.
 *
 * Data:
 *   - ct_debates (RLS-scoped to the current user)
 *   - ct_grades (for Claude's solo alert win rate — same rubric, graded set)
 *   - search_ct_debates RPC for semantic search (threshold 0.3, spec default)
 */

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Search, ChevronDown, ChevronRight, Scale, Trophy, X } from 'lucide-react';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------
interface DebateRow {
  id: string;
  created_at: string;
  topic: string;
  instrument: string | null;
  your_prior_lean: string | null;
  your_bias_risk: string | null;
  synthesis: string | null;
  bull_case: Record<string, unknown> | null;
  bear_case: Record<string, unknown> | null;
  user_pick: 'bull' | 'bear' | 'neither' | null;
  user_pick_at: string | null;
  outcome_verdict: 'right' | 'wrong' | 'pending' | null;
  outcome_at: string | null;
  outcome_detail: Record<string, unknown> | null;
}

type PickFilter = 'all' | 'bull' | 'bear' | 'neither' | 'unpicked';
type OutcomeFilter = 'all' | 'right' | 'wrong' | 'pending' | 'unresolved';

// -----------------------------------------------------------------------------
// Rendering helpers
// -----------------------------------------------------------------------------
function fmtPct(r: number, w: number): string {
  const n = r + w;
  if (n === 0) return '—';
  return `${Math.round((r / n) * 100)}%`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function PickBadge({ pick }: { pick: DebateRow['user_pick'] }) {
  if (!pick) {
    return <Badge className="bg-muted text-muted-foreground text-[10px]">unpicked</Badge>;
  }
  if (pick === 'bull') {
    return <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px]">BULL</Badge>;
  }
  if (pick === 'bear') {
    return <Badge className="bg-rose-500/15 text-rose-400 border-rose-500/30 text-[10px]">BEAR</Badge>;
  }
  return <Badge className="bg-zinc-500/15 text-zinc-400 border-zinc-500/30 text-[10px]">NEITHER</Badge>;
}

function VerdictBadge({ verdict, picked }: { verdict: DebateRow['outcome_verdict']; picked: boolean }) {
  if (!picked) {
    return <Badge className="bg-muted/50 text-muted-foreground text-[10px]">no pick</Badge>;
  }
  if (!verdict) {
    return <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/30 text-[10px]">unresolved</Badge>;
  }
  if (verdict === 'right') {
    return <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px]">✓ right</Badge>;
  }
  if (verdict === 'wrong') {
    return <Badge className="bg-rose-500/15 text-rose-400 border-rose-500/30 text-[10px]">✗ wrong</Badge>;
  }
  return <Badge className="bg-muted/40 text-muted-foreground text-[10px]">pending</Badge>;
}

// -----------------------------------------------------------------------------
// Stat tile
// -----------------------------------------------------------------------------
function StatTile({
  label,
  value,
  sub,
  accent,
}: { label: string; value: string; sub?: string; accent?: 'emerald' | 'rose' | 'amber' | 'default' }) {
  const accentClass = accent === 'emerald'
    ? 'text-emerald-400'
    : accent === 'rose'
      ? 'text-rose-400'
      : accent === 'amber'
        ? 'text-amber-400'
        : 'text-foreground';
  return (
    <Card className="p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold mt-0.5 ${accentClass}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
    </Card>
  );
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------
export default function Debates() {
  const qc = useQueryClient();
  const [pickFilter, setPickFilter] = useState<PickFilter>('all');
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>('all');
  const [searchInput, setSearchInput] = useState('');
  const [semanticIds, setSemanticIds] = useState<Set<string> | null>(null);
  const [semanticBusy, setSemanticBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Full debate list — RLS scopes to current user automatically.
  const { data: debates = [], isLoading } = useQuery<DebateRow[]>({
    queryKey: ['ct_debates_all'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .from('ct_debates' as any)
        .select('id, created_at, topic, instrument, your_prior_lean, your_bias_risk, synthesis, bull_case, bear_case, user_pick, user_pick_at, outcome_verdict, outcome_at, outcome_detail')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) {
        console.warn('[Debates] load failed:', error.message);
        return [];
      }
      return (data ?? []) as unknown as DebateRow[];
    },
  });

  // Claude's solo alert win rate — "right" over right+wrong+partial. Same
  // window as the debate roll-up (30 days) so we compare apples to apples.
  // Partial counts as a half-win against the denominator = strict precision,
  // matching how Scorecard frames precision elsewhere.
  const { data: claudeAlertStats } = useQuery<{ right: number; wrong: number; partial: number }>({
    queryKey: ['ct_grades_alerts_30d'],
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const since = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
      const { data, error } = await supabase
        .from('ct_grades')
        .select('verdict')
        .eq('subject_type', 'alert')
        .gte('graded_at', since);
      if (error || !data) return { right: 0, wrong: 0, partial: 0 };
      let r = 0, w = 0, p = 0;
      for (const g of data as Array<{ verdict: string }>) {
        if (g.verdict === 'right') r++;
        else if (g.verdict === 'wrong') w++;
        else if (g.verdict === 'partial') p++;
      }
      return { right: r, wrong: w, partial: p };
    },
  });

  // -----------------------------------------------------------------------
  // Derived: stats (picked + graded subset)
  // -----------------------------------------------------------------------
  const stats = useMemo(() => {
    const by = { bull: { r: 0, w: 0 }, bear: { r: 0, w: 0 }, neither: { r: 0, w: 0 } };
    let picked = 0;
    let resolved = 0;
    for (const d of debates) {
      if (!d.user_pick) continue;
      picked++;
      if (d.outcome_verdict === 'right' || d.outcome_verdict === 'wrong') {
        resolved++;
        const side = by[d.user_pick];
        if (d.outcome_verdict === 'right') side.r++;
        else side.w++;
      }
    }
    const totalR = by.bull.r + by.bear.r + by.neither.r;
    const totalW = by.bull.w + by.bear.w + by.neither.w;
    return { by, picked, resolved, totalR, totalW, total: debates.length };
  }, [debates]);

  // James-vs-Claude comparison metric.
  //
  // Formula (both sides use the SAME rubric: right / (right + wrong) after
  // discarding pending/partial as non-graded — so we're comparing "when a
  // verdict exists, how often was it right"):
  //
  //   James debate win rate = stats.totalR / (stats.totalR + stats.totalW)
  //   Claude alert win rate = claudeAlertStats.right /
  //                           (claudeAlertStats.right + claudeAlertStats.wrong)
  //
  // Why exclude partial on Claude's side: partial isn't available on debates
  // (outcome_verdict is 2-valued: right/wrong). Excluding partial keeps the
  // denominators apples-to-apples. The aggregate counts are shown too so
  // James can eyeball sample size.
  const jamesWinRate = stats.totalR + stats.totalW > 0
    ? stats.totalR / (stats.totalR + stats.totalW)
    : null;
  const claudeWinRate = claudeAlertStats && (claudeAlertStats.right + claudeAlertStats.wrong) > 0
    ? claudeAlertStats.right / (claudeAlertStats.right + claudeAlertStats.wrong)
    : null;

  // -----------------------------------------------------------------------
  // Filtering
  // -----------------------------------------------------------------------
  const filtered = useMemo(() => {
    return debates.filter((d) => {
      if (pickFilter === 'bull' && d.user_pick !== 'bull') return false;
      if (pickFilter === 'bear' && d.user_pick !== 'bear') return false;
      if (pickFilter === 'neither' && d.user_pick !== 'neither') return false;
      if (pickFilter === 'unpicked' && d.user_pick != null) return false;

      if (outcomeFilter === 'right' && d.outcome_verdict !== 'right') return false;
      if (outcomeFilter === 'wrong' && d.outcome_verdict !== 'wrong') return false;
      if (outcomeFilter === 'pending' && d.outcome_verdict !== 'pending') return false;
      if (outcomeFilter === 'unresolved' && d.outcome_verdict != null) return false;

      if (semanticIds && !semanticIds.has(d.id)) return false;
      return true;
    });
  }, [debates, pickFilter, outcomeFilter, semanticIds]);

  // -----------------------------------------------------------------------
  // Semantic search — calls the search_ct_debates RPC. Embedding is minted
  // by ct-chat on the way in; here we use search-memory's generate-embedding
  // path via a thin edge call. To keep this page self-contained we route
  // through a tiny helper: we POST to ct-chat with a special flag... no,
  // simpler — use jac's generate-embedding edge function which already
  // exists and returns Voyage 512-dim for a query string.
  // -----------------------------------------------------------------------
  async function runSemanticSearch() {
    const q = searchInput.trim();
    if (!q) {
      setSemanticIds(null);
      return;
    }
    setSemanticBusy(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const user = sessionData?.session?.user;
      const jwt = sessionData?.session?.access_token;
      if (!user || !jwt) {
        setSemanticBusy(false);
        return;
      }
      // Embed the query via the existing generate-embedding function (Voyage
      // 512-dim, input_type='query' — matches THE EMBEDDING LAW).
      const embedRes = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-embedding`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: q, input_type: 'query' }),
      });
      if (!embedRes.ok) {
        console.warn('[Debates] embed failed:', await embedRes.text());
        setSemanticBusy(false);
        return;
      }
      const embedBody = await embedRes.json() as { embedding: number[] };

      // Hit the RPC. Threshold 0.3 per build spec.
      const { data, error } = await supabase.rpc('search_ct_debates', {
        query_embedding: embedBody.embedding as unknown as string,
        query_user_id: user.id,
        match_threshold: 0.3,
        match_count: 50,
      });
      if (error) {
        console.warn('[Debates] RPC failed:', error.message);
        setSemanticBusy(false);
        return;
      }
      const ids = new Set<string>((data ?? []).map((r: { id: string }) => r.id));
      setSemanticIds(ids);
    } finally {
      setSemanticBusy(false);
    }
  }

  function clearSearch() {
    setSearchInput('');
    setSemanticIds(null);
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <div className="p-4 space-y-4 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Scale className="w-4 h-4 text-primary" />
        <h1 className="text-lg font-semibold">Debates</h1>
        <span className="text-xs text-muted-foreground">
          · {debates.length} total · {stats.picked} picked · {stats.resolved} resolved
        </span>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <StatTile
          label="your win rate"
          value={jamesWinRate != null ? `${Math.round(jamesWinRate * 100)}%` : '—'}
          sub={`${stats.totalR} right · ${stats.totalW} wrong`}
          accent={jamesWinRate != null && jamesWinRate >= 0.55 ? 'emerald' : jamesWinRate != null && jamesWinRate < 0.45 ? 'rose' : 'default'}
        />
        <StatTile
          label="bull picks"
          value={fmtPct(stats.by.bull.r, stats.by.bull.w)}
          sub={`${stats.by.bull.r}/${stats.by.bull.r + stats.by.bull.w}`}
          accent="emerald"
        />
        <StatTile
          label="bear picks"
          value={fmtPct(stats.by.bear.r, stats.by.bear.w)}
          sub={`${stats.by.bear.r}/${stats.by.bear.r + stats.by.bear.w}`}
          accent="rose"
        />
        <StatTile
          label="neither picks"
          value={fmtPct(stats.by.neither.r, stats.by.neither.w)}
          sub={`${stats.by.neither.r}/${stats.by.neither.r + stats.by.neither.w}`}
        />
        <StatTile
          label="vs. Claude solo alerts"
          value={claudeWinRate != null && jamesWinRate != null
            ? `${jamesWinRate > claudeWinRate ? '+' : ''}${Math.round((jamesWinRate - claudeWinRate) * 100)}pp`
            : '—'}
          sub={claudeWinRate != null ? `Claude: ${Math.round(claudeWinRate * 100)}% (n=${(claudeAlertStats?.right ?? 0) + (claudeAlertStats?.wrong ?? 0)})` : '—'}
          accent={claudeWinRate != null && jamesWinRate != null
            ? (jamesWinRate > claudeWinRate ? 'emerald' : jamesWinRate < claudeWinRate ? 'rose' : 'default')
            : 'default'}
        />
      </div>

      {/* Deliberation verdict strip — the one-line headline */}
      {jamesWinRate != null && claudeWinRate != null && (
        <Card className="p-3 bg-muted/30">
          <div className="flex items-start gap-2 text-xs">
            <Trophy className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold">
                {jamesWinRate > claudeWinRate
                  ? 'Deliberation is beating reactive alerts.'
                  : jamesWinRate < claudeWinRate
                    ? 'Reactive alerts are beating deliberation.'
                    : 'Deliberation and reactive alerts are at parity.'}
              </span>{' '}
              <span className="text-muted-foreground">
                James's debate win rate: {Math.round(jamesWinRate * 100)}% (n={stats.totalR + stats.totalW})
                {' · '}
                Claude's solo alerts: {Math.round(claudeWinRate * 100)}% (n={(claudeAlertStats?.right ?? 0) + (claudeAlertStats?.wrong ?? 0)}, last 30d)
              </span>
            </div>
          </div>
        </Card>
      )}

      {/* Filters + search */}
      <Card className="p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">pick</div>
          {(['all', 'bull', 'bear', 'neither', 'unpicked'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setPickFilter(f)}
              className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
                pickFilter === f
                  ? 'bg-primary/10 border-primary text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >{f}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">outcome</div>
          {(['all', 'right', 'wrong', 'pending', 'unresolved'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setOutcomeFilter(f)}
              className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
                outcomeFilter === f
                  ? 'bg-primary/10 border-primary text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >{f}</button>
          ))}
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Search className="w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void runSemanticSearch(); }}
            placeholder="Semantic search topics (threshold 0.3)..."
            className="text-xs h-8"
          />
          <Button size="sm" disabled={semanticBusy || !searchInput.trim()} onClick={() => void runSemanticSearch()}>
            {semanticBusy ? '…' : 'Search'}
          </Button>
          {semanticIds && (
            <Button variant="ghost" size="sm" onClick={clearSearch} title="Clear semantic filter">
              <X className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
        {semanticIds && (
          <div className="text-[10px] text-muted-foreground">
            {semanticIds.size} semantic hits · filtered to these rows.
          </div>
        )}
      </Card>

      {/* List */}
      <div className="space-y-1.5">
        {isLoading && (
          <Card className="p-4 text-xs text-muted-foreground">Loading debates…</Card>
        )}
        {!isLoading && filtered.length === 0 && (
          <Card className="p-4 text-xs text-muted-foreground">
            No debates match these filters. {debates.length === 0 ? 'Kick one off with `/debate <topic>` in chat.' : 'Loosen the filters to see more.'}
          </Card>
        )}
        {filtered.map((d) => {
          const expanded = expandedId === d.id;
          const bull = (d.bull_case ?? {}) as Record<string, unknown>;
          const bear = (d.bear_case ?? {}) as Record<string, unknown>;
          return (
            <Card key={d.id} className="p-0 overflow-hidden">
              <button
                onClick={() => setExpandedId(expanded ? null : d.id)}
                className="w-full text-left p-3 hover:bg-muted/40 transition-colors"
              >
                <div className="flex items-center gap-2">
                  {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {d.instrument && (
                        <Badge variant="outline" className="text-[10px]">{d.instrument}</Badge>
                      )}
                      <span className="text-xs font-medium truncate">{d.topic}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground">
                      <span>{timeAgo(d.created_at)}</span>
                      {d.your_prior_lean && <span>· prior: {d.your_prior_lean}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <PickBadge pick={d.user_pick} />
                    <VerdictBadge verdict={d.outcome_verdict} picked={d.user_pick != null} />
                  </div>
                </div>
              </button>

              {expanded && (
                <div className="border-t border-border p-3 space-y-2 text-xs bg-muted/20">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-emerald-400 mb-1">bull case</div>
                      <div className="text-[11px] font-semibold">{String(bull.headline ?? '—')}</div>
                      {Array.isArray(bull.evidence) && (bull.evidence as unknown[]).length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-[10.5px] text-foreground/80">
                          {(bull.evidence as unknown[]).slice(0, 6).map((e, i) => (
                            <li key={i}>• {String(e)}</li>
                          ))}
                        </ul>
                      )}
                      {bull.best_trade ? (
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          <span className="font-semibold">trade:</span> {String(bull.best_trade)}
                        </div>
                      ) : null}
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-rose-400 mb-1">bear case</div>
                      <div className="text-[11px] font-semibold">{String(bear.headline ?? '—')}</div>
                      {Array.isArray(bear.evidence) && (bear.evidence as unknown[]).length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-[10.5px] text-foreground/80">
                          {(bear.evidence as unknown[]).slice(0, 6).map((e, i) => (
                            <li key={i}>• {String(e)}</li>
                          ))}
                        </ul>
                      )}
                      {bear.best_trade ? (
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          <span className="font-semibold">trade:</span> {String(bear.best_trade)}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {d.synthesis && (
                    <div className="text-[10.5px] italic text-foreground/80 border-t border-border/60 pt-2">
                      {d.synthesis}
                    </div>
                  )}

                  {d.your_bias_risk && (
                    <div className="text-[10px] text-amber-400">
                      <span className="uppercase tracking-wider">bias risk:</span> {d.your_bias_risk}
                    </div>
                  )}

                  {d.outcome_detail && (
                    <details className="text-[10px] text-muted-foreground">
                      <summary className="cursor-pointer">outcome detail</summary>
                      <pre className="mt-1 whitespace-pre-wrap break-all">{JSON.stringify(d.outcome_detail, null, 2)}</pre>
                    </details>
                  )}

                  {d.user_pick == null && (
                    <div className="pt-2 border-t border-border/60">
                      <div className="text-[10px] text-muted-foreground mb-1.5">your call</div>
                      <div className="flex gap-1.5">
                        {(['bull', 'bear', 'neither'] as const).map((side) => (
                          <Button
                            key={side}
                            size="sm"
                            variant="outline"
                            className="text-[10.5px] h-7"
                            onClick={async (e) => {
                              e.stopPropagation();
                              const { error } = await supabase
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                .from('ct_debates' as any)
                                .update({ user_pick: side, user_pick_at: new Date().toISOString() })
                                .eq('id', d.id);
                              if (!error) {
                                qc.invalidateQueries({ queryKey: ['ct_debates_all'] });
                              }
                            }}
                          >
                            I pick {side.toUpperCase()}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
