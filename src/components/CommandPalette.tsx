/**
 * CommandPalette — cmd+K / ctrl+K power-user launcher.
 *
 * Four result categories (fuzzy-searched across all):
 *   - Routes    → all TopNav paths (labels match nav labels)
 *   - Tickers   → current watchlist from ct_config `watcher.watchlist`
 *   - Alerts    → last 10 ct_alerts (opens LinkGexDeep Sheet for that ticker)
 *   - Actions   → Fire watcher, Commit trade, Replay, Preflight, Kill switch, etc.
 *
 * Mounted once inside TrackedRoutes so the global hotkey works on every
 * authenticated page. The hotkey listener deliberately no-ops when focus is
 * in a text-entry element so typing `k` in an input doesn't steal focus.
 *
 * Kill switch note: `KillSwitchButton` owns its own modal state, so the
 * palette dispatches a `ct:open-kill-switch` CustomEvent and the button
 * listens for it. Keeps the palette decoupled from that component's internals.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronRight,
  Compass,
  LineChart,
  Bell,
  Zap,
  OctagonX,
  FileCheck,
  Repeat,
  ClipboardCheck,
  TrendingUp,
  Radio,
  FileText,
  Search as SearchIcon,
  AlertTriangle,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { LinkGexDeep } from '@/components/command/LinkGexDeep';
import { triggerCoTrader } from '@/hooks/useCoTraderData';
import { toast } from 'sonner';

// ---------------------------------------------------------------------------
// Route catalog — mirrors NAV_GROUPS in TopNav.tsx. Labels kept identical so
// users type the name they see in the nav.
// ---------------------------------------------------------------------------

interface RouteEntry {
  path: string;
  label: string;
  group: string;
}

const ROUTES: RouteEntry[] = [
  // Trade
  { path: '/',             label: 'Station',        group: 'Trade' },
  { path: '/commit',       label: 'Commit',         group: 'Trade' },
  { path: '/book',         label: 'Book',           group: 'Trade' },
  { path: '/session',      label: 'Timeline',       group: 'Trade' },
  // Review
  { path: '/scorecard',    label: 'Scorecard',      group: 'Review' },
  { path: '/playbooks',    label: 'Playbooks',      group: 'Review' },
  { path: '/principles',   label: 'Principles',     group: 'Review' },
  { path: '/prompts',      label: 'Prompt A/B',     group: 'Review' },
  { path: '/replay',       label: 'Replay',         group: 'Review' },
  { path: '/rules',        label: 'Custom Rules',   group: 'Review' },
  // System
  { path: '/preflight',    label: 'Preflight',      group: 'System' },
  { path: '/health',       label: 'Health',         group: 'System' },
  { path: '/crons',        label: 'Crons',          group: 'System' },
  { path: '/agents',       label: 'Agents',         group: 'System' },
  { path: '/activity-live',label: 'Activity Live',  group: 'System' },
  // More
  { path: '/dashboard',    label: 'Dashboard',      group: 'More' },
  { path: '/jac',          label: 'JAC',            group: 'More' },
  { path: '/calendar',     label: 'Calendar',       group: 'More' },
  { path: '/brain',        label: 'Brain',          group: 'More' },
  { path: '/activity',     label: 'Activity',       group: 'More' },
  { path: '/reports',      label: 'Reports',        group: 'More' },
  { path: '/search',       label: 'Search',         group: 'More' },
  { path: '/code',         label: 'Code',           group: 'More' },
  { path: '/ct-settings',  label: 'CT Config',      group: 'More' },
  { path: '/settings',     label: 'Settings',       group: 'More' },
  { path: '/stress',       label: 'Stress',         group: 'More' },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ItemKind = 'route' | 'ticker' | 'alert' | 'action';

interface PaletteItem {
  kind: ItemKind;
  /** Stable ID for keyed rendering */
  id: string;
  /** Primary label the user reads and types against */
  label: string;
  /** Right-aligned contextual hint (e.g. "→ /book", "bullish conv=5") */
  hint?: string;
  /** Category header under which this item is grouped */
  section: string;
  /** Icon rendered on the left */
  icon: React.ComponentType<{ className?: string }>;
  /** What happens on Enter / click */
  execute: () => void | Promise<void>;
  /** Optional recency for tie-breaking within equal scores (higher = newer) */
  recency?: number;
}

interface AlertRow {
  id: string;
  instruments: string[] | null;
  direction: string | null;
  conviction: number | null;
  glance: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Fuzzy scoring
//
// Three-tier score with a normalized length penalty so "SPY" beats a long
// label that happens to start with "SPY-something".
//
//   prefix (case-insensitive)    → 1000 − label.length
//   contains (substring)         →  500 − indexOf(q)
//   chars-in-order subsequence   →  100 − extraCharCount
//   no match                     →    0  (filtered out)
//
// Empty query returns 1 so everything passes; sort preserves natural order.
// Ties broken by recency (newer first), then by label length (shorter first).
// ---------------------------------------------------------------------------

function fuzzyScore(query: string, label: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const l = label.toLowerCase();

  if (l.startsWith(q)) return 1000 - Math.min(label.length, 99);

  const idx = l.indexOf(q);
  if (idx >= 0) return 500 - Math.min(idx, 99);

  // Subsequence: every query char appears in order somewhere in label.
  let li = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    while (li < l.length && l[li] !== c) li++;
    if (li >= l.length) return 0;
    li++;
  }
  const extra = l.length - q.length;
  return Math.max(1, 100 - Math.min(extra, 99));
}

function sortByScore(a: { score: number; item: PaletteItem }, b: { score: number; item: PaletteItem }): number {
  if (b.score !== a.score) return b.score - a.score;
  const ar = a.item.recency ?? 0;
  const br = b.item.recency ?? 0;
  if (br !== ar) return br - ar;
  return a.item.label.length - b.item.label.length;
}

// ---------------------------------------------------------------------------
// Data hooks — prefetched so the palette is instant on open.
// ---------------------------------------------------------------------------

function useWatchlistTickers() {
  return useQuery<string[]>({
    queryKey: ['palette', 'watchlist'],
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_config')
        .select('value')
        .eq('key', 'watcher.watchlist')
        .maybeSingle();
      if (error) return [];
      return Array.isArray(data?.value) ? (data!.value as string[]) : [];
    },
  });
}

function useRecentAlerts() {
  return useQuery<AlertRow[]>({
    queryKey: ['palette', 'recent-alerts'],
    refetchInterval: 30_000,
    staleTime: 15_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_alerts')
        .select('id, instruments, direction, conviction, glance, created_at')
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) return [];
      return (data ?? []) as AlertRow[];
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgoShort(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * True iff focus is in a text-entry surface. Covers: <input> (except
 * checkbox/radio/button), <textarea>, [contenteditable]. This is what
 * prevents cmd+K from hijacking a user mid-sentence.
 */
function isTextInputFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type.toLowerCase();
    // Allow palette to open on non-text inputs like checkboxes/radios.
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file'].includes(type);
  }
  return false;
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

const MAX_RESULTS = 30;

export function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Deep-dive Sheet state (used when an alert row is selected)
  const [deepTicker, setDeepTicker] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { data: watchlist = [] } = useWatchlistTickers();
  const { data: alerts = [] } = useRecentAlerts();

  // -------------------------------------------------------------------------
  // Global hotkey — cmd+K / ctrl+K. Also Esc to close.
  // -------------------------------------------------------------------------
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      // cmd+K (Mac) / ctrl+K (Win/Linux) — do NOT fire if focus is in a text
      // input unless the palette is already open (we want Esc from within).
      const isK = e.key.toLowerCase() === 'k';
      const modifier = e.metaKey || e.ctrlKey;
      if (isK && modifier && !e.altKey && !e.shiftKey) {
        if (!open && isTextInputFocused()) return;
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Reset selection + focus input when opening.
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIdx(0);
      // Timeout lets the dialog mount before focusing.
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const close = () => setOpen(false);

  const goRoute = (path: string) => { navigate(path); close(); };

  const openAlertDeep = (ticker: string) => {
    setDeepTicker(ticker);
    close();
  };

  // -------------------------------------------------------------------------
  // Build the flat item list. Memoized on data deps — rebuilt whenever
  // watchlist or alerts change, not on every keystroke.
  // -------------------------------------------------------------------------
  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];

    // Routes
    for (const r of ROUTES) {
      out.push({
        kind: 'route',
        id: `route:${r.path}`,
        label: r.label,
        hint: `→ ${r.path}`,
        section: `Routes · ${r.group}`,
        icon: Compass,
        execute: () => goRoute(r.path),
      });
    }

    // Tickers
    for (const t of watchlist) {
      out.push({
        kind: 'ticker',
        id: `ticker:${t}`,
        label: t,
        hint: 'ticker terminal',
        section: 'Tickers',
        icon: LineChart,
        execute: () => goRoute(`/ticker/${encodeURIComponent(t)}`),
      });
    }

    // Recent alerts
    for (const a of alerts) {
      const tk = (a.instruments && a.instruments[0]) || '?';
      const dir = a.direction ?? '—';
      const conv = a.conviction ?? 0;
      const ago = timeAgoShort(a.created_at);
      out.push({
        kind: 'alert',
        id: `alert:${a.id}`,
        label: `ALERT ${tk} ${dir} conv=${conv} (${ago})`,
        hint: a.glance ? a.glance.slice(0, 48) : undefined,
        section: 'Recent alerts',
        icon: Bell,
        recency: new Date(a.created_at).getTime(),
        execute: () => openAlertDeep(tk),
      });
    }

    // Actions — labels are the strings the user types. Keep them verb-first.
    const actions: Array<Omit<PaletteItem, 'kind' | 'section'>> = [
      {
        id: 'action:fire-watcher',
        label: 'Fire watcher now',
        hint: 'ct_watcher · ~15-30s',
        icon: Zap,
        execute: async () => {
          close();
          const r = await triggerCoTrader('watcher');
          if (r.ok) toast.success('watcher fired — 15-30s to land');
          else toast.error(`watcher failed: ${r.error}`);
        },
      },
      {
        id: 'action:fire-grader',
        label: 'Run grader now',
        hint: 'ct_grader',
        icon: ClipboardCheck,
        execute: async () => {
          close();
          const r = await triggerCoTrader('grader');
          if (r.ok) toast.success('grader fired'); else toast.error(`grader failed: ${r.error}`);
        },
      },
      {
        id: 'action:fire-flow',
        label: 'Fire flow ingester',
        hint: 'ct_flow_ingester',
        icon: TrendingUp,
        execute: async () => {
          close();
          const r = await triggerCoTrader('flow_ingester');
          if (r.ok) toast.success('flow ingester fired'); else toast.error(`flow failed: ${r.error}`);
        },
      },
      {
        id: 'action:fire-news',
        label: 'Fire news ingester',
        hint: 'ct_news_ingester',
        icon: Radio,
        execute: async () => {
          close();
          const r = await triggerCoTrader('news_ingester');
          if (r.ok) toast.success('news ingester fired'); else toast.error(`news failed: ${r.error}`);
        },
      },
      {
        id: 'action:fire-morning-brief',
        label: 'Run morning brief',
        hint: 'ct_morning_brief',
        icon: FileText,
        execute: async () => {
          close();
          const r = await triggerCoTrader('morning_brief');
          if (r.ok) toast.success('morning brief fired'); else toast.error(`brief failed: ${r.error}`);
        },
      },
      {
        id: 'action:fire-eod-recap',
        label: 'Run EOD recap',
        hint: 'ct_eod_recap',
        icon: FileText,
        execute: async () => {
          close();
          const r = await triggerCoTrader('eod_recap');
          if (r.ok) toast.success('EOD recap fired'); else toast.error(`recap failed: ${r.error}`);
        },
      },
      {
        id: 'action:commit-trade',
        label: 'Commit trade',
        hint: '→ /commit',
        icon: FileCheck,
        execute: () => goRoute('/commit'),
      },
      {
        id: 'action:replay-today',
        label: 'Replay today',
        hint: '→ /replay',
        icon: Repeat,
        execute: () => { goRoute('/replay'); },
      },
      {
        id: 'action:view-preflight',
        label: 'View preflight',
        hint: '→ /preflight',
        icon: ClipboardCheck,
        execute: () => goRoute('/preflight'),
      },
      {
        id: 'action:open-search',
        label: 'Search brain',
        hint: '→ /search',
        icon: SearchIcon,
        execute: () => goRoute('/search'),
      },
      {
        id: 'action:kill-switch',
        label: 'Kill switch engage',
        hint: 'opens arm dialog',
        icon: OctagonX,
        execute: () => {
          close();
          // KillSwitchButton listens for this and opens its own modal.
          window.dispatchEvent(new CustomEvent('ct:open-kill-switch'));
        },
      },
      {
        id: 'action:health',
        label: 'View health',
        hint: '→ /health',
        icon: AlertTriangle,
        execute: () => goRoute('/health'),
      },
    ];
    for (const a of actions) {
      out.push({ kind: 'action', section: 'Actions', ...a });
    }

    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- goRoute is stable
  }, [watchlist, alerts]);

  // -------------------------------------------------------------------------
  // Filter + sort + cap. Recompute on query or items change.
  // -------------------------------------------------------------------------
  const results = useMemo<PaletteItem[]>(() => {
    const scored = items
      .map((item) => ({ item, score: fuzzyScore(query, item.label) }))
      .filter((x) => x.score > 0);
    scored.sort(sortByScore);
    return scored.slice(0, MAX_RESULTS).map((x) => x.item);
  }, [items, query]);

  // Clamp selected index when results shrink.
  useEffect(() => {
    if (selectedIdx >= results.length) setSelectedIdx(Math.max(0, results.length - 1));
  }, [results.length, selectedIdx]);

  // Scroll selected row into view.
  useEffect(() => {
    if (!listRef.current) return;
    const row = listRef.current.querySelector<HTMLElement>(`[data-idx="${selectedIdx}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  // Group results by section for rendering, preserving overall sort order.
  const grouped = useMemo(() => {
    const g: Array<{ section: string; items: Array<{ item: PaletteItem; flatIdx: number }> }> = [];
    results.forEach((item, idx) => {
      const last = g[g.length - 1];
      if (last && last.section === item.section) {
        last.items.push({ item, flatIdx: idx });
      } else {
        g.push({ section: item.section, items: [{ item, flatIdx: idx }] });
      }
    });
    return g;
  }, [results]);

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = results[selectedIdx];
      if (chosen) void chosen.execute();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  return (
    <>
      {/* ----- Palette modal ----- */}
      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] px-4"
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          onClick={close}
        >
          {/* Backdrop with blur */}
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

          {/* Panel */}
          <div
            className="relative w-full max-w-[500px] rounded-xl border border-white/10 bg-zinc-900/95 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Search input */}
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-white/10">
              <SearchIcon className="w-4 h-4 text-muted-foreground shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setSelectedIdx(0); }}
                onKeyDown={onInputKeyDown}
                placeholder="Jump to anything…"
                aria-label="Command palette search"
                aria-controls="command-palette-results"
                aria-activedescendant={results[selectedIdx] ? `cmd-item-${selectedIdx}` : undefined}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 outline-none"
                autoComplete="off"
                spellCheck={false}
              />
              <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded border border-white/10 text-[10px] text-muted-foreground font-mono">
                esc
              </kbd>
            </div>

            {/* Results list */}
            <div
              ref={listRef}
              id="command-palette-results"
              role="listbox"
              aria-label="Command palette results"
              className="max-h-[60vh] overflow-y-auto py-1"
            >
              {results.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                  No matches for <span className="font-mono text-foreground/70">"{query}"</span>
                </div>
              ) : (
                grouped.map((group) => (
                  <div key={group.section}>
                    <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">
                      {group.section}
                    </div>
                    {group.items.map(({ item, flatIdx }) => {
                      const selected = flatIdx === selectedIdx;
                      const Icon = item.icon;
                      return (
                        <div
                          key={item.id}
                          id={`cmd-item-${flatIdx}`}
                          role="option"
                          aria-selected={selected}
                          data-idx={flatIdx}
                          onMouseMove={() => setSelectedIdx(flatIdx)}
                          onClick={() => void item.execute()}
                          className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer text-sm ${
                            selected
                              ? 'bg-primary/15 text-foreground'
                              : 'text-foreground/85 hover:bg-white/5'
                          }`}
                        >
                          <ChevronRight
                            className={`w-3.5 h-3.5 shrink-0 transition-opacity ${
                              selected ? 'opacity-100 text-primary' : 'opacity-0'
                            }`}
                          />
                          <Icon className="w-4 h-4 shrink-0 text-muted-foreground" />
                          <span className="flex-1 truncate">{item.label}</span>
                          {item.hint && (
                            <span className="shrink-0 text-[11px] text-muted-foreground/70 truncate max-w-[40%]">
                              {item.hint}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            {/* Footer hints */}
            <div className="flex items-center justify-between px-3 py-1.5 border-t border-white/10 bg-black/30 text-[10px] text-muted-foreground">
              <div className="flex items-center gap-3">
                <span><kbd className="font-mono">↑↓</kbd> navigate</span>
                <span><kbd className="font-mono">↵</kbd> select</span>
                <span><kbd className="font-mono">esc</kbd> close</span>
              </div>
              <div>{results.length} / {items.length}</div>
            </div>
          </div>
        </div>
      )}

      {/* ----- LinkGexDeep Sheet, driven by alert selections ----- */}
      <Sheet open={deepTicker !== null} onOpenChange={(o) => { if (!o) setDeepTicker(null); }}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-[860px] bg-black border-white/10 p-0 overflow-y-auto"
        >
          {deepTicker && <LinkGexDeep ticker={deepTicker} enabled={deepTicker !== null} />}
        </SheetContent>
      </Sheet>
    </>
  );
}
