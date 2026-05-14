/**
 * TapeCommentaryRender — canonical renderer for ct_tape_commentary text.
 *
 * This is the SINGLE SOURCE OF TRUTH for rendering tape-commentary on every
 * human-facing surface (banner, arc, alpha strip, claude's-read, /tape-reader).
 * If you add a new consumer, IMPORT this — don't reimplement. Class-killed
 * rendering-layer drift on 2026-05-14 (Ship 8).
 *
 * Producer (ct-tape-reader edge fn) emits richly-formatted prose:
 *   - `**TODAY HH:MM ET** —` bold prefix
 *   - inline `**bold**` markdown for contract anchors / themes
 *   - flag_ids (UUID[]) and flow_ids (number[]) accompanying the text
 *
 * Responsibilities:
 *   1. Render `**...**` bolds via react-markdown (no literal asterisks anywhere).
 *   2. Resolve flag_ids → linked chips to /flags?id=<uuid>.
 *   3. Resolve flow_ids → linked chips to /tape.
 *   4. (Optional) Δ-from-prior summary line: which `**bold contract anchors**`
 *      are NEW in this read vs the prior one, which carried forward.
 *
 * Modes:
 *   - default: full render (prose + chip rows + Δ-summary if priorCommentary)
 *   - compact: prose only, smaller font, no chips/Δ — for banner/strip surfaces
 *     where the bold anchors carry the read and chips would clutter
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { cn } from '@/lib/utils';
import { Flag, TrendingUp, GitBranch } from 'lucide-react';

export interface TapeCommentaryRenderProps {
  /** Raw commentary text from ct_tape_commentary.commentary (may contain `**bold**` markdown). */
  commentary: string;
  /** UUID array from ct_tape_commentary.flag_ids — rendered as chips linking to /flags?id=<uuid>. */
  flagIds?: string[] | null;
  /** Integer array from ct_tape_commentary.flow_ids — rendered as chips linking to /tape. */
  flowIds?: number[] | null;
  /** Prior commentary text. When provided, a Δ-from-prior line surfaces NEW vs CARRIED bold anchors. */
  priorCommentary?: string | null;
  /** Compact mode: prose-only render for banner / top-strip surfaces. No chips, no Δ. */
  compact?: boolean;
  /** Extra classes on outer wrapper. */
  className?: string;
}

/**
 * Extract the set of `**bolded**` anchor strings from a commentary blob.
 * Used to diff NEW vs CARRIED anchors between adjacent reads.
 */
function extractBoldAnchors(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  // Non-greedy match between ** ... ** (single-line; producer doesn't span paragraphs in one bold).
  const re = /\*\*([^*\n]+?)\*\*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const a = m[1].trim();
    if (a.length > 0) out.push(a);
  }
  return out;
}

/** Truncate a long anchor label for the chip row. */
function shortAnchor(s: string, max = 48): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export function TapeCommentaryRender({
  commentary,
  flagIds,
  flowIds,
  priorCommentary,
  compact = false,
  className,
}: TapeCommentaryRenderProps) {
  const { newAnchors, carriedAnchors } = useMemo(() => {
    if (!priorCommentary || !commentary) return { newAnchors: [] as string[], carriedAnchors: [] as string[] };
    const cur = extractBoldAnchors(commentary);
    const prior = new Set(extractBoldAnchors(priorCommentary).map((s) => s.toLowerCase()));
    const seen = new Set<string>();
    const newer: string[] = [];
    const carried: string[] = [];
    for (const a of cur) {
      const key = a.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (prior.has(key)) carried.push(a);
      else newer.push(a);
    }
    return { newAnchors: newer, carriedAnchors: carried };
  }, [commentary, priorCommentary]);

  const showDelta = !compact && !!priorCommentary && (newAnchors.length > 0 || carriedAnchors.length > 0);
  const flagList = (flagIds ?? []).filter((id) => typeof id === 'string' && id.length > 0);
  const flowList = (flowIds ?? []).filter((id) => typeof id === 'number' && Number.isFinite(id));
  const showChips = !compact && (flagList.length > 0 || flowList.length > 0);

  return (
    <div className={cn('space-y-2', className)}>
      {showDelta && (
        <div className="text-[10px] font-mono leading-snug border-l-2 border-primary/40 pl-2 py-0.5 bg-primary/[0.04]">
          {newAnchors.length > 0 && (
            <div>
              <span className="uppercase tracking-wider text-emerald-300 mr-1">NEW:</span>
              <span className="text-foreground/85">
                {newAnchors.slice(0, 4).map(shortAnchor).join(' · ')}
                {newAnchors.length > 4 && <span className="text-muted-foreground"> · +{newAnchors.length - 4} more</span>}
              </span>
            </div>
          )}
          {carriedAnchors.length > 0 && (
            <div>
              <span className="uppercase tracking-wider text-muted-foreground mr-1">CARRIED:</span>
              <span className="text-foreground/65">
                {carriedAnchors.slice(0, 4).map(shortAnchor).join(' · ')}
                {carriedAnchors.length > 4 && <span className="text-muted-foreground"> · +{carriedAnchors.length - 4} more</span>}
              </span>
            </div>
          )}
        </div>
      )}

      <div
        className={cn(
          'tape-commentary-prose text-foreground/90 leading-snug',
          compact ? 'text-sm' : 'text-sm md:text-[13px] leading-relaxed',
        )}
      >
        <ReactMarkdown
          components={{
            // Keep markdown rendering inline-ish: producer output is one paragraph per read.
            p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
            strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
            em: ({ children }) => <em className="italic">{children}</em>,
            // Strip any code/link blocks if producer ever emits them — we don't want raw HTML pass-through.
            a: ({ children }) => <span>{children}</span>,
            code: ({ children }) => <span className="font-mono">{children}</span>,
          }}
        >
          {commentary}
        </ReactMarkdown>
      </div>

      {showChips && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {flagList.map((id) => (
            <Link
              key={`flag-${id}`}
              to={`/flags?id=${id}`}
              className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/20 transition-colors"
              title={`Specialist flag ${id}`}
            >
              <Flag className="w-2.5 h-2.5" />
              {id.slice(0, 8)}
            </Link>
          ))}
          {flowList.map((id) => (
            <Link
              key={`flow-${id}`}
              to={`/tape`}
              className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 border border-sky-500/20 transition-colors"
              title={`Flow alert ${id}`}
            >
              <TrendingUp className="w-2.5 h-2.5" />
              {id}
            </Link>
          ))}
          {(flagList.length === 0 || flowList.length === 0) && (
            <span className="inline-flex items-center gap-1 text-[9px] font-mono text-muted-foreground/50 px-1.5 py-0.5">
              <GitBranch className="w-2.5 h-2.5" />
              {flagList.length} flag · {flowList.length} flow
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default TapeCommentaryRender;
