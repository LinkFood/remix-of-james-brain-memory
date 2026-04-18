/**
 * watcherDispatch.ts — shared helper for event-driven ct-watcher invocations.
 *
 * The scheduled watcher ticks every 15 minutes. For time-critical events
 * (magnitude-5 news, attention-85 clusters, regime inversions) waiting up to
 * ~7 minutes for the next tick is too slow. Callers invoke
 *   fireWatcherImmediate(supabase, { source, reason, priority })
 * which does the following, in order:
 *
 *   1. Check kill switch — if engaged, log audit row and skip.
 *   2. Per-source debounce — if another event-driven invocation from THIS
 *      source fired within its window (90s urgent / 3min high), log and skip.
 *      Debounce is PER SOURCE: a news event does not block a cluster event.
 *   3. Insert audit row into ct_watcher_event_triggers with trigger_fired=true.
 *   4. Fire-and-forget POST to ct-watcher with
 *        { trigger: reason, triggered_by: source, reason, priority }
 *
 * The helper is fire-and-forget: the caller awaits the decision (fire/skip)
 * but not the downstream watcher cycle. Any failure is logged to console.warn
 * and swallowed — we never want a best-effort event dispatch to break the
 * producer function.
 *
 * IMPORTANT: Never fire from thesis_invalidation alerts — those originate
 * inside the watcher and would recurse.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isKillSwitchActive } from './killSwitch.ts';

export type WatcherTriggerPriority = 'high' | 'urgent';

export type WatcherTriggerSource =
  | 'news_event'
  | 'sweep_cluster'
  | 'dp_cluster'
  | 'regime_inversion';

export interface FireWatcherInput {
  source: WatcherTriggerSource | string;
  reason: string;
  priority: WatcherTriggerPriority;
}

export interface FireWatcherResult {
  fired: boolean;
  skip_reason?: 'kill_switch' | 'debounced' | 'insert_failed' | 'no_env';
  trigger_id?: string;
  ticks_since_last_trigger?: number;
}

// Debounce windows, in seconds. Per-source.
const DEBOUNCE_URGENT_SEC = 90;
const DEBOUNCE_HIGH_SEC = 180;

function debounceWindowSec(priority: WatcherTriggerPriority): number {
  return priority === 'urgent' ? DEBOUNCE_URGENT_SEC : DEBOUNCE_HIGH_SEC;
}

/**
 * Check if another event-driven invocation from the same source fired within
 * the debounce window. Returns { debounced, ticks_since } where ticks_since
 * is the count of prior event triggers from this source in the last hour
 * (used for audit / observability).
 */
async function checkDebounce(
  supabase: SupabaseClient,
  source: string,
  priority: WatcherTriggerPriority,
): Promise<{ debounced: boolean; ticks_since: number }> {
  const windowSec = debounceWindowSec(priority);
  const cutoffIso = new Date(Date.now() - windowSec * 1000).toISOString();
  const hourAgoIso = new Date(Date.now() - 3600 * 1000).toISOString();

  const [recent, hourly] = await Promise.all([
    supabase
      .from('ct_watcher_event_triggers')
      .select('id', { count: 'exact', head: true })
      .eq('source', source)
      .eq('trigger_fired', true)
      .gte('created_at', cutoffIso),
    supabase
      .from('ct_watcher_event_triggers')
      .select('id', { count: 'exact', head: true })
      .eq('source', source)
      .eq('trigger_fired', true)
      .gte('created_at', hourAgoIso),
  ]);

  const recentCount = recent.count ?? 0;
  const hourlyCount = hourly.count ?? 0;
  return { debounced: recentCount > 0, ticks_since: hourlyCount };
}

/**
 * Insert an audit row into ct_watcher_event_triggers. Soft-fails on error
 * (console.warn) so a flaky DB insert never blocks the watcher fire.
 */
async function logTrigger(
  supabase: SupabaseClient,
  params: {
    source: string;
    reason: string;
    priority: WatcherTriggerPriority;
    trigger_fired: boolean;
    skip_reason: string | null;
    ticks_since_last_trigger: number;
  },
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('ct_watcher_event_triggers')
      .insert({
        source: params.source,
        reason: params.reason.slice(0, 500),
        priority: params.priority,
        trigger_fired: params.trigger_fired,
        skip_reason: params.skip_reason,
        ticks_since_last_trigger: params.ticks_since_last_trigger,
      })
      .select('id')
      .maybeSingle();
    if (error) {
      console.warn('[watcherDispatch] audit insert failed:', error.message);
      return null;
    }
    return (data?.id as string | undefined) ?? null;
  } catch (e) {
    console.warn('[watcherDispatch] audit insert threw:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * Fire-and-forget POST to ct-watcher. Does not await the response body —
 * we log any fetch-level failure and move on.
 */
function postWatcher(input: FireWatcherInput): void {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    console.warn('[watcherDispatch] missing SUPABASE_URL/SERVICE_ROLE_KEY — skipping fire');
    return;
  }
  fetch(`${url}/functions/v1/ct-watcher`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      trigger: input.reason,
      triggered_by: input.source,
      reason: input.reason,
      priority: input.priority,
    }),
  }).catch((e) =>
    console.warn('[watcherDispatch] fire failed:', e instanceof Error ? e.message : String(e)),
  );
}

/**
 * Public API — called from trigger-point functions (news-ingester,
 * sweep-cluster, dp-cluster, regime-watch) after a noteworthy row is
 * committed. Always resolves; never throws.
 */
export async function fireWatcherImmediate(
  supabase: SupabaseClient,
  input: FireWatcherInput,
): Promise<FireWatcherResult> {
  try {
    // 1. Kill switch — skip entirely (still audit-logged so operators see
    //    what would have fired).
    if (await isKillSwitchActive(supabase)) {
      const id = await logTrigger(supabase, {
        source: input.source,
        reason: input.reason,
        priority: input.priority,
        trigger_fired: false,
        skip_reason: 'kill_switch',
        ticks_since_last_trigger: 0,
      });
      return { fired: false, skip_reason: 'kill_switch', trigger_id: id ?? undefined };
    }

    // 2. Per-source debounce.
    const { debounced, ticks_since } = await checkDebounce(supabase, input.source, input.priority);
    if (debounced) {
      const id = await logTrigger(supabase, {
        source: input.source,
        reason: input.reason,
        priority: input.priority,
        trigger_fired: false,
        skip_reason: 'debounced',
        ticks_since_last_trigger: ticks_since,
      });
      return {
        fired: false,
        skip_reason: 'debounced',
        trigger_id: id ?? undefined,
        ticks_since_last_trigger: ticks_since,
      };
    }

    // 3. Env sanity before we log fired=true.
    if (!Deno.env.get('SUPABASE_URL') || !Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
      const id = await logTrigger(supabase, {
        source: input.source,
        reason: input.reason,
        priority: input.priority,
        trigger_fired: false,
        skip_reason: 'no_env',
        ticks_since_last_trigger: ticks_since,
      });
      return { fired: false, skip_reason: 'no_env', trigger_id: id ?? undefined };
    }

    // 4. Audit row + fire.
    const id = await logTrigger(supabase, {
      source: input.source,
      reason: input.reason,
      priority: input.priority,
      trigger_fired: true,
      skip_reason: null,
      ticks_since_last_trigger: ticks_since,
    });
    postWatcher(input);
    console.log(`[watcherDispatch] fired: source=${input.source} priority=${input.priority} reason=${input.reason.slice(0, 120)}`);
    return {
      fired: true,
      trigger_id: id ?? undefined,
      ticks_since_last_trigger: ticks_since,
    };
  } catch (e) {
    console.warn('[watcherDispatch] fireWatcherImmediate threw:', e instanceof Error ? e.message : String(e));
    return { fired: false, skip_reason: 'insert_failed' };
  }
}
