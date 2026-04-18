/**
 * Workspace — Thesis Engine UI (Wave D: Claude trades autonomously).
 *
 * Tab bar across the top:
 *   - Theses          — the 3-col hypothesis view (minus the killed approval queue,
 *                       plus a "Claude reviews" column for the selected thesis)
 *   - Trade Log       — Claude's trade ideas + executed trades, filterable
 *   - Claude's Book   — Claude's paper account: banner, equity curve, open positions
 *   - Divergence      — James vs Claude equity overlay + side-by-side stats
 *
 * Wave-D ground rule: Claude is an independent trader. James does not approve.
 * James reviews AFTER THE FACT. Reviews are sandboxed into ct_james_reviews
 * and never read by any Claude-facing function.
 *
 * Authorship coloring (Granola-style):
 *   - Pure Claude rows        → text-muted-foreground, subtle muted left border
 *   - James-edited rows       → text-foreground, primary-colored left border
 * Applied to: claim, because bullets, invalidate_if, evidence summaries.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Brain, Check, X, Bot, Newspaper, Activity, Zap, Radar, Flame,
  AlertTriangle, Pencil, Save, RotateCcw, TrendingUp, TrendingDown, Circle,
  ThumbsUp, ThumbsDown, MessageSquare,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  LineChart, Line, YAxis, XAxis, ResponsiveContainer, Tooltip,
} from 'recharts';
import { ChartSafe } from '@/components/ChartSafe';
import { SessionBadge } from '@/components/command/SessionBadge';
import { finiteDomain } from '@/lib/chartSanitize';
import {
  useHypothesesList,
  useHypothesis,
  useLinkedAlerts,
  useLinkedGrades,
  useEditHypothesis,
  useRecentlyProposedHypotheses,
  useReviewHypothesis,
  useHypothesisReviews,
  type Hypothesis,
  type HypothesisEvidence,
  type HypothesisStatus,
  type HypothesisHorizon,
  type EvidenceType,
} from '@/hooks/useHypotheses';
import { TradeLogTab } from '@/components/workspace/TradeLogTab';
import { ClaudesBookTab } from '@/components/workspace/ClaudesBookTab';
import { DivergenceTab } from '@/components/workspace/DivergenceTab';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const STATUS_OPTIONS: Array<{ value: HypothesisStatus | 'all'; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'supported', label: 'Supported' },
  { value: 'refuted', label: 'Refuted' },
  { value: 'zombie', label: 'Zombie' },
  { value: 'all', label: 'All' },
];

const HORIZON_OPTIONS: HypothesisHorizon[] = ['session', 'week', 'month', 'open'];

function statusDotClass(s: HypothesisStatus): string {
  switch (s) {
    case 'open': return 'bg-blue-400';
    case 'supported': return 'bg-green-400';
    case 'refuted': return 'bg-red-400';
    case 'zombie': return 'bg-amber-400';
    case 'retired': return 'bg-muted-foreground';
  }
}

function statusChipClass(s: HypothesisStatus): string {
  switch (s) {
    case 'open': return 'bg-blue-500/15 text-blue-400 border-blue-500/30';
    case 'supported': return 'bg-green-500/15 text-green-400 border-green-500/30';
    case 'refuted': return 'bg-red-500/15 text-red-400 border-red-500/30';
    case 'zombie': return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
    case 'retired': return 'bg-muted/50 text-muted-foreground border-muted';
  }
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return `${Math.floor(diff / (30 * 86_400_000))}mo ago`;
}

const EVIDENCE_ICON: Record<EvidenceType, typeof Brain> = {
  observation: Radar,
  alert: AlertTriangle,
  grade: Check,
  news: Newspaper,
  flow: Activity,
  gex: Zap,
  regime: Flame,
  catalyst: Brain,
  manual: Pencil,
};

/**
 * Granola-style coloring. If the row (or hypothesis) has been edited by
 * james we render in primary/foreground tones; otherwise the text is still
 * "Claude's" — muted to visually de-weight un-reviewed material.
 */
function authorTextClass(editedByJames: boolean): string {
  return editedByJames ? 'text-foreground' : 'text-muted-foreground';
}
function authorBorderClass(editedByJames: boolean): string {
  return editedByJames
    ? 'border-l-2 border-primary/60'
    : 'border-l-2 border-muted-foreground/20';
}

// ---------------------------------------------------------------------------
// Page — tab bar across the top routes between Theses / Trade Log / Book /
// Divergence. The Theses tab renders the original 3-col workspace; the other
// three render dedicated components.
// ---------------------------------------------------------------------------
export default function Workspace() {
  const [tab, setTab] = useState<'theses' | 'trades' | 'book' | 'divergence'>('theses');

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1600px] mx-auto p-4 space-y-3">
        <header>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Brain className="w-6 h-6 text-primary" />
            <span className="text-primary">Workspace</span>
            <span className="text-sm text-muted-foreground font-normal">
              Claude trades autonomously — you observe, review retrospectively
            </span>
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Theses are Claude's. Trade ideas and trades are Claude's. Your thumbs are sandboxed into
            ct_james_reviews and never read back by any Claude-facing function.
          </p>
        </header>

        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList className="grid w-full md:w-auto md:inline-flex grid-cols-4 gap-1">
            <TabsTrigger value="theses" className="text-xs">Theses</TabsTrigger>
            <TabsTrigger value="trades" className="text-xs">Trade Log</TabsTrigger>
            <TabsTrigger value="book" className="text-xs">Claude's Book</TabsTrigger>
            <TabsTrigger value="divergence" className="text-xs">Divergence</TabsTrigger>
          </TabsList>

          <TabsContent value="theses" className="mt-3">
            <ThesesTab />
          </TabsContent>
          <TabsContent value="trades" className="mt-3">
            <TradeLogTab />
          </TabsContent>
          <TabsContent value="book" className="mt-3">
            <ClaudesBookTab />
          </TabsContent>
          <TabsContent value="divergence" className="mt-3">
            <DivergenceTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Theses tab — original 3-col layout, minus the killed approval queue, plus
// a "Recently proposed" informational column and a "Claude reviews" column
// for the selected thesis.
// ---------------------------------------------------------------------------
function ThesesTab() {
  const [statusFilter, setStatusFilter] = useState<HypothesisStatus | 'all'>('open');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: list = [], isLoading: listLoading } = useHypothesesList(statusFilter);
  const { data: recentlyProposed = [] } = useRecentlyProposedHypotheses();

  const effectiveSelectedId = useMemo(() => {
    if (!list.length) return null;
    if (selectedId && list.some((h) => h.id === selectedId)) return selectedId;
    return list[0].id;
  }, [list, selectedId]);

  return (
    <div className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)_280px]">
      {/* ---------- LEFT RAIL ---------- */}
      <aside className="space-y-2">
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as HypothesisStatus | 'all')}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value} className="text-xs">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="space-y-1.5 max-h-[calc(100vh-220px)] overflow-y-auto pr-1">
          {listLoading ? (
            <Card className="p-3 text-xs text-muted-foreground">loading...</Card>
          ) : list.length === 0 ? (
            <Card className="p-3 text-xs text-muted-foreground leading-relaxed">
              No theses yet — the proposer runs Monday 7am ET, or trigger manually via /health.
            </Card>
          ) : (
            list.map((h) => (
              <HypothesisListCard
                key={h.id}
                hypothesis={h}
                selected={h.id === effectiveSelectedId}
                onClick={() => setSelectedId(h.id)}
              />
            ))
          )}
        </div>
      </aside>

      {/* ---------- MIDDLE ---------- */}
      <main className="min-w-0">
        {effectiveSelectedId ? (
          <ThesisDocument id={effectiveSelectedId} />
        ) : (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            Pick a thesis from the list.
          </Card>
        )}
      </main>

      {/* ---------- RIGHT RAIL ---------- */}
      <aside className="space-y-4 max-h-[calc(100vh-220px)] overflow-y-auto pr-1">
        {/* Recently proposed — informational, no approval buttons. Writes
            sandboxed thumbs to ct_james_reviews. */}
        <section className="space-y-2">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground px-1">
            <Bot className="w-3 h-3" />
            <span>Recently proposed</span>
            <span className="ml-auto font-mono">{recentlyProposed.length}</span>
          </div>
          <div className="space-y-1.5">
            {recentlyProposed.length === 0 ? (
              <Card className="p-3 text-xs text-muted-foreground">
                No fresh hypotheses. The proposer runs weekly.
              </Card>
            ) : (
              recentlyProposed.map((h) => (
                <RecentlyProposedCard
                  key={h.id}
                  hypothesis={h}
                  onOpen={() => setSelectedId(h.id)}
                />
              ))
            )}
          </div>
        </section>

        {/* Claude reviews — James's recent thumbs on the selected thesis. */}
        <section className="space-y-2">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground px-1">
            <MessageSquare className="w-3 h-3" />
            <span>Your reviews</span>
          </div>
          <ClaudeReviewsColumn hypothesisId={effectiveSelectedId} />
        </section>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LEFT RAIL — list card
// ---------------------------------------------------------------------------
function HypothesisListCard({
  hypothesis, selected, onClick,
}: {
  hypothesis: Hypothesis;
  selected: boolean;
  onClick: () => void;
}) {
  const editedByJames = hypothesis.last_edited_by === 'james';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded-md transition-colors ${
        selected
          ? 'bg-primary/10 ring-1 ring-primary/50'
          : 'bg-card hover:bg-muted/30 ring-1 ring-border'
      } ${authorBorderClass(editedByJames)}`}
    >
      <div className="p-2.5 space-y-1.5">
        <div className={`text-xs leading-snug line-clamp-2 ${authorTextClass(editedByJames)}`}>
          {hypothesis.claim}
        </div>
        <div className="flex items-center gap-1.5 text-[10px]">
          <span
            className={`w-1.5 h-1.5 rounded-full ${statusDotClass(hypothesis.status)}`}
            title={hypothesis.status}
          />
          <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">
            {hypothesis.horizon}
          </Badge>
          <span className="text-muted-foreground font-mono ml-auto">elo {hypothesis.elo}</span>
        </div>
        <ConfidenceBar confidence={hypothesis.confidence} compact />
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// RIGHT RAIL — recently-proposed card. No approval gate. Thumbs-up/down +
// optional note write to ct_james_reviews (subject_type='hypothesis'). Row
// cannot block Claude.
// ---------------------------------------------------------------------------
function RecentlyProposedCard({
  hypothesis, onOpen,
}: {
  hypothesis: Hypothesis;
  onOpen: () => void;
}) {
  const review = useReviewHypothesis();
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);

  const submit = (thumb: 'up' | 'down') => {
    review.mutate(
      { hypothesisId: hypothesis.id, thumb, note: note.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(`Review saved (${thumb === 'up' ? '+' : '-'})`);
          setNote('');
          setNoteOpen(false);
        },
        onError: (e) => toast.error(`Review failed: ${(e as Error).message}`),
      },
    );
  };

  return (
    <Card className={`p-2.5 space-y-2 ${authorBorderClass(false)}`}>
      <button
        type="button"
        onClick={onOpen}
        className={`text-left w-full text-[11px] leading-snug line-clamp-3 hover:text-foreground transition-colors ${authorTextClass(false)}`}
      >
        {hypothesis.claim}
      </button>
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">
          {hypothesis.horizon}
        </Badge>
        {hypothesis.tickers.length > 0 && (
          <span className="font-mono truncate">{hypothesis.tickers.slice(0, 3).join(' ')}</span>
        )}
        <span className="ml-auto">{timeAgo(hypothesis.created_at)}</span>
      </div>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-green-400 hover:text-green-300 hover:bg-green-500/10"
          disabled={review.isPending}
          onClick={() => submit('up')}
          title="Thumbs up"
        >
          <ThumbsUp className="w-3 h-3" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-red-400 hover:text-red-300 hover:bg-red-500/10"
          disabled={review.isPending}
          onClick={() => submit('down')}
          title="Thumbs down"
        >
          <ThumbsDown className="w-3 h-3" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground ml-auto"
          onClick={() => setNoteOpen(v => !v)}
          title="Add note"
        >
          <MessageSquare className="w-3 h-3" />
        </Button>
      </div>
      {noteOpen && (
        <Input
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="note — sandboxed, Claude never reads"
          className="text-[10px] h-7"
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Claude reviews column — recent James thumbs on the selected thesis.
// Reads ct_james_reviews (subject_type='hypothesis'). James-only surface.
// ---------------------------------------------------------------------------
function ClaudeReviewsColumn({ hypothesisId }: { hypothesisId: string | null }) {
  const { data: reviews = [], isLoading } = useHypothesisReviews(hypothesisId);
  if (!hypothesisId) {
    return (
      <Card className="p-3 text-xs text-muted-foreground">
        Select a thesis to see your reviews on it.
      </Card>
    );
  }
  if (isLoading) {
    return <Card className="p-3 text-xs text-muted-foreground">loading reviews...</Card>;
  }
  if (reviews.length === 0) {
    return (
      <Card className="p-3 text-xs text-muted-foreground">
        No reviews yet on this thesis. Thumbs from "Recently proposed" land here.
      </Card>
    );
  }
  return (
    <div className="space-y-1.5">
      {reviews.map(r => (
        <Card key={r.id} className="p-2 text-[11px] space-y-1">
          <div className="flex items-center gap-1.5">
            {r.thumb === 'up' && <ThumbsUp className="w-3 h-3 text-green-400" />}
            {r.thumb === 'down' && <ThumbsDown className="w-3 h-3 text-red-400" />}
            {r.thumb === 'neutral' && <Circle className="w-3 h-3 text-muted-foreground" />}
            <span className={
              r.thumb === 'up' ? 'text-green-400 font-semibold'
              : r.thumb === 'down' ? 'text-red-400 font-semibold'
              : 'text-muted-foreground'
            }>
              {r.thumb}
            </span>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {timeAgo(r.created_at)}
            </span>
          </div>
          {r.note && (
            <div className="text-[11px] leading-snug text-foreground/90">{r.note}</div>
          )}
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MIDDLE — selected thesis document
// ---------------------------------------------------------------------------
function ThesisDocument({ id }: { id: string }) {
  const { hypothesis, evidence, events, isLoading } = useHypothesis(id);
  const { data: linkedAlerts = [] } = useLinkedAlerts(id);
  const { data: linkedGrades = [] } = useLinkedGrades(id);
  const edit = useEditHypothesis();
  const navigate = useNavigate();

  // Local inline-edit state. Reset when the hypothesis id changes.
  const [editing, setEditing] = useState(false);
  const [draftClaim, setDraftClaim] = useState('');
  const [draftBecause, setDraftBecause] = useState<string[]>([]);
  const [draftInvalidate, setDraftInvalidate] = useState('');
  const [draftTickers, setDraftTickers] = useState('');
  const [draftHorizon, setDraftHorizon] = useState<HypothesisHorizon>('session');

  const primeDraft = (h: Hypothesis) => {
    setDraftClaim(h.claim);
    setDraftBecause([...h.because]);
    setDraftInvalidate(h.invalidate_if);
    setDraftTickers(h.tickers.join(' '));
    setDraftHorizon(h.horizon);
  };

  const startEdit = () => {
    if (!hypothesis) return;
    primeDraft(hypothesis);
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
  };
  const saveEdit = () => {
    if (!hypothesis) return;
    const tickers = draftTickers
      .split(/[\s,]+/)
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);
    const because = draftBecause.map((b) => b.trim()).filter(Boolean);
    edit.mutate(
      {
        id: hypothesis.id,
        patch: {
          claim: draftClaim.trim(),
          because,
          invalidate_if: draftInvalidate.trim(),
          tickers,
          horizon: draftHorizon,
        },
      },
      {
        onSuccess: () => {
          toast.success('Thesis edits saved');
          setEditing(false);
        },
        onError: (e) => toast.error(`Save failed: ${(e as Error).message}`),
      },
    );
  };

  // IMPORTANT: hook call MUST happen before any early return to stay
  // rules-of-hooks compliant. We feed it current confidence (or 0.5 when
  // the hypothesis hasn't loaded yet) — the series is discarded in the
  // loading branch anyway.
  const confidenceSeries = useMemoConfidenceSeries(events, hypothesis?.confidence ?? 0.5);

  if (isLoading || !hypothesis) {
    return <Card className="p-8 text-center text-sm text-muted-foreground">Loading thesis...</Card>;
  }

  const editedByJames = hypothesis.last_edited_by === 'james';

  return (
    <div className="space-y-3">
      {/* Header */}
      <Card className={`p-4 space-y-3 ${authorBorderClass(editedByJames)}`}>
        <div className="flex items-start gap-2">
          {editing ? (
            <Textarea
              value={draftClaim}
              onChange={(e) => setDraftClaim(e.target.value)}
              className="text-base font-semibold leading-snug min-h-[64px]"
              placeholder="claim"
            />
          ) : (
            <div className={`text-base font-semibold leading-snug flex-1 ${authorTextClass(editedByJames)}`}>
              {hypothesis.claim}
            </div>
          )}

          <div className="flex flex-col gap-1 items-end shrink-0">
            <Badge
              variant="outline"
              className={`text-[10px] px-1.5 py-0 ${statusChipClass(hypothesis.status)}`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full mr-1 ${statusDotClass(hypothesis.status)}`}
              />
              {hypothesis.status}
            </Badge>
            <span className="text-[10px] text-muted-foreground font-mono">
              elo {hypothesis.elo}
            </span>
          </div>
        </div>

        <ConfidenceBar confidence={hypothesis.confidence} />

        <div className="flex items-center gap-2 text-[10px] text-muted-foreground flex-wrap">
          <span>created {timeAgo(hypothesis.created_at)}</span>
          <span>·</span>
          <span>last tested {timeAgo(hypothesis.last_tested_at)}</span>
          <span>·</span>
          <span>by {hypothesis.created_by}</span>
          {hypothesis.last_edited_by && (
            <>
              <span>·</span>
              <span className="text-primary">edited by {hypothesis.last_edited_by}</span>
            </>
          )}
          <div className="ml-auto flex items-center gap-1">
            {editing ? (
              <>
                <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={cancelEdit}>
                  <RotateCcw className="w-3 h-3 mr-1" />Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  disabled={edit.isPending}
                  onClick={saveEdit}
                >
                  <Save className="w-3 h-3 mr-1" />Save
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={startEdit}>
                <Pencil className="w-3 h-3 mr-1" />Edit
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* Because / Invalidate / Tickers */}
      <Card className="p-4 space-y-4">
        {/* Because */}
        <section>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            <TrendingUp className="w-3 h-3" /> Because
          </div>
          {editing ? (
            <BecauseEditor value={draftBecause} onChange={setDraftBecause} />
          ) : hypothesis.because.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">(no reasons recorded)</div>
          ) : (
            <ul className="space-y-1.5">
              {hypothesis.because.map((b, i) => (
                <li
                  key={i}
                  className={`text-xs leading-snug pl-2 ${authorBorderClass(editedByJames)} ${authorTextClass(editedByJames)}`}
                >
                  {b}
                </li>
              ))}
            </ul>
          )}
        </section>

        <Separator />

        {/* Invalidate if */}
        <section>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            <TrendingDown className="w-3 h-3" /> Invalidate if
          </div>
          {editing ? (
            <Input
              value={draftInvalidate}
              onChange={(e) => setDraftInvalidate(e.target.value)}
              className="text-xs h-8"
              placeholder="what would make this wrong?"
            />
          ) : (
            <div
              className={`text-xs leading-snug pl-2 ${authorBorderClass(editedByJames)} ${authorTextClass(editedByJames)}`}
            >
              {hypothesis.invalidate_if || <span className="italic text-muted-foreground">(none recorded)</span>}
            </div>
          )}
        </section>

        <Separator />

        {/* Tickers + horizon */}
        <section>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            <Circle className="w-3 h-3" /> Tickers & horizon
          </div>
          {editing ? (
            <div className="flex items-center gap-2">
              <Input
                value={draftTickers}
                onChange={(e) => setDraftTickers(e.target.value)}
                placeholder="SPY QQQ AAPL"
                className="text-xs h-8 uppercase"
              />
              <Select value={draftHorizon} onValueChange={(v) => setDraftHorizon(v as HypothesisHorizon)}>
                <SelectTrigger className="h-8 text-xs w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HORIZON_OPTIONS.map((h) => (
                    <SelectItem key={h} value={h} className="text-xs">{h}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 flex-wrap">
              {hypothesis.tickers.length > 0 ? hypothesis.tickers.map((t) => (
                <Badge key={t} variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
                  {t}
                </Badge>
              )) : <span className="text-xs text-muted-foreground italic">(no tickers)</span>}
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 ml-auto">
                horizon: {hypothesis.horizon}
              </Badge>
            </div>
          )}
        </section>
      </Card>

      {/* Evidence stack */}
      <Card className="p-4">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-3">
          <Activity className="w-3 h-3" /> Evidence stack
          <span className="ml-auto font-mono">n={evidence.length}</span>
        </div>
        {evidence.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">
            No evidence yet. Observations, alerts, and grades auto-attach as they land.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {evidence.map((e) => (
              <EvidenceRow key={e.id} evidence={e} />
            ))}
          </div>
        )}
      </Card>

      {/* Linked alerts / grades */}
      <Card className="p-4">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-3">
          <AlertTriangle className="w-3 h-3" /> Linked alerts &amp; grades
          <span className="ml-auto font-mono">
            {linkedAlerts.length}a · {linkedGrades.length}g
          </span>
        </div>
        {linkedAlerts.length === 0 && linkedGrades.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">
            Nothing linked yet. Flags and alerts tagged with this thesis will appear here.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {linkedAlerts.map((a) => (
              <button
                key={`${a.kind}-${a.id}`}
                type="button"
                onClick={() => navigate('/scorecard')}
                className="w-full flex items-center gap-2 text-xs py-1.5 px-1 hover:bg-muted/30 rounded transition-colors text-left"
              >
                <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 uppercase">
                  {a.kind}
                </Badge>
                <span className="font-mono font-semibold">{a.instrument ?? '—'}</span>
                <span className="text-muted-foreground">{a.claimed_direction ?? ''}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{timeAgo(a.created_at)}</span>
              </button>
            ))}
            {linkedGrades.map((g) => (
              <button
                key={`grade-${g.id}`}
                type="button"
                onClick={() => navigate('/scorecard')}
                className="w-full flex items-center gap-2 text-xs py-1.5 px-1 hover:bg-muted/30 rounded transition-colors text-left"
              >
                <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 uppercase">
                  grade
                </Badge>
                <span className="font-mono font-semibold">{g.instrument}</span>
                <span className="text-muted-foreground">{g.claimed_direction} → {g.actual_direction}</span>
                <span className={`font-mono ${g.actual_return_pct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {g.actual_return_pct >= 0 ? '+' : ''}{g.actual_return_pct.toFixed(2)}%
                </span>
                <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">{g.verdict}</Badge>
                <span className="ml-auto text-[10px] text-muted-foreground">{timeAgo(g.graded_at)}</span>
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* Confidence history sparkline */}
      <Card className="p-4">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
          <TrendingUp className="w-3 h-3" /> Confidence history
          <span className="ml-auto">
            <SessionBadge />
          </span>
        </div>
        {confidenceSeries.length < 2 ? (
          <div className="text-xs text-muted-foreground italic h-[80px] flex items-center">
            Not enough confidence updates yet to draw a line.
          </div>
        ) : (
          <ChartSafe label="confidence history">
            <div className="h-[80px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={confidenceSeries} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                  <XAxis dataKey="idx" hide />
                  <YAxis
                    hide
                    domain={finiteDomain(
                      Math.min(...confidenceSeries.map((p) => p.v)),
                      Math.max(...confidenceSeries.map((p) => p.v)),
                      [0, 1],
                      0.05,
                    )}
                  />
                  <Tooltip
                    contentStyle={{ fontSize: 11, background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}
                    formatter={(v: number) => [`${(v * 100).toFixed(0)}%`, 'confidence']}
                    labelFormatter={(_, payload) => {
                      const p = payload && payload[0] && payload[0].payload;
                      if (!p) return '';
                      return new Date(p.at).toLocaleString();
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="v"
                    stroke="hsl(var(--primary))"
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </ChartSafe>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evidence row
// ---------------------------------------------------------------------------
function EvidenceRow({ evidence }: { evidence: HypothesisEvidence }) {
  const Icon = EVIDENCE_ICON[evidence.evidence_type] ?? Brain;
  const editedByJames = evidence.added_by === 'james';
  const polarityColor = evidence.polarity === 'for' ? 'text-green-400' : 'text-red-400';
  const polaritySymbol = evidence.polarity === 'for' ? '✓' : '✗';
  return (
    <div className={`py-2 pl-2 flex items-start gap-2 ${authorBorderClass(editedByJames)}`}>
      <Icon className="w-3.5 h-3.5 shrink-0 mt-0.5 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="uppercase tracking-wider">{evidence.evidence_type}</span>
          <span className={`font-bold ${polarityColor}`} title={evidence.polarity}>{polaritySymbol}</span>
          <span className="font-mono">w={evidence.weight.toFixed(2)}</span>
          <span className="ml-auto">by {evidence.added_by} · {timeAgo(evidence.added_at)}</span>
        </div>
        <div className={`text-xs leading-snug mt-0.5 ${authorTextClass(editedByJames)}`}>
          {evidence.summary ?? <span className="italic text-muted-foreground">(no summary)</span>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Because editor — list of textareas with add/remove
// ---------------------------------------------------------------------------
function BecauseEditor({
  value, onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const updateAt = (i: number, v: string) => {
    const next = [...value];
    next[i] = v;
    onChange(next);
  };
  const removeAt = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const add = () => onChange([...value, '']);

  return (
    <div className="space-y-1.5">
      {value.map((b, i) => (
        <div key={i} className="flex items-center gap-1">
          <Input
            value={b}
            onChange={(e) => updateAt(i, e.target.value)}
            className="text-xs h-8"
            placeholder="reason"
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0 shrink-0"
            onClick={() => removeAt(i)}
            title="Remove"
          >
            <X className="w-3 h-3" />
          </Button>
        </div>
      ))}
      <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={add}>
        + add reason
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confidence bar
// ---------------------------------------------------------------------------
function ConfidenceBar({ confidence, compact = false }: { confidence: number; compact?: boolean }) {
  const pct = Math.max(0, Math.min(1, confidence));
  const color = pct >= 0.66 ? 'bg-green-400' : pct >= 0.33 ? 'bg-amber-400' : 'bg-red-400';
  return (
    <div className={`flex items-center gap-1.5 ${compact ? 'text-[9px]' : 'text-[10px]'}`}>
      <div className={`flex-1 ${compact ? 'h-1' : 'h-1.5'} rounded-full bg-muted overflow-hidden`}>
        <div className={`h-full ${color} transition-all`} style={{ width: `${pct * 100}%` }} />
      </div>
      <span className="font-mono text-muted-foreground">{(pct * 100).toFixed(0)}%</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confidence series from event log — each confidence_update row lands on
// the line. Ambient time order, filter to rows with a valid after_value.
// If there are 0 or 1 points we append the current confidence so the caller
// can fall back to the "not enough data" copy uniformly.
// ---------------------------------------------------------------------------
function useMemoConfidenceSeries(
  events: ReturnType<typeof useHypothesis>['events'],
  currentConfidence: number,
) {
  return useMemo(() => {
    const points: Array<{ idx: number; at: string; v: number }> = [];
    let idx = 0;
    for (const e of events) {
      if (e.event_type !== 'confidence_update' && e.event_type !== 'created') continue;
      if (e.after_value == null || !Number.isFinite(e.after_value)) continue;
      points.push({ idx, at: e.created_at, v: e.after_value });
      idx++;
    }
    // Always pin the current confidence as the last point — otherwise a
    // hypothesis with only a `created` event would render as a single dot.
    if (Number.isFinite(currentConfidence)) {
      points.push({ idx, at: new Date().toISOString(), v: currentConfidence });
    }
    return points;
  }, [events, currentConfidence]);
}
