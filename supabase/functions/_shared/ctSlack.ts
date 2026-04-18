/**
 * Co-trader Slack push — minimal, best-effort, never throws.
 *
 * Pulls channel from user_settings.settings.slack_channel_id (same
 * pattern as JAC). Posts via SLACK_BOT_TOKEN. Silent no-op if
 * either is missing.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

export interface CtSlackPayload {
  state: 'FLAG' | 'ALERT' | 'RECAP' | 'DISAGREEMENT';
  instruments: string[];
  glance: string[];
  conviction?: number;
  horizon?: string;
  alert_trigger?: string;
  direction?: string;
  convergence_count?: number;
  event_id?: string;
}

/**
 * Dedupe check: should we push this to Slack, or has a materially-
 * equivalent push gone out recently?
 *
 * RULES:
 *   - Never dedupe thesis_invalidation (direction-change signal is always news)
 *   - Dedupe window: 30min
 *   - Skip if same (direction, alert_trigger) pushed within window UNLESS:
 *       * Direction FLIPPED since last push (bull→bear or vice versa)
 *       * Convergence count UPGRADED (e.g. 3→4 or 3→5)
 *       * No push in last 30min (always push the fresh one)
 */
export async function shouldPushToSlack(
  supabase: SupabaseClient,
  payload: CtSlackPayload & { source: string },
): Promise<{ push: boolean; reason: string }> {
  // Invalidations push ONCE per direction-flip event — not every tick.
  // A true invalidation represents a state change; re-firing it 2min later
  // is just re-describing the same change. Dedupe window: 15min.
  if (payload.alert_trigger === 'thesis_invalidation') {
    const invCutoff = new Date(Date.now() - 15 * 60_000).toISOString();
    const { data: recentInv } = await supabase
      .from('ct_slack_log')
      .select('direction, created_at')
      .eq('pushed', true)
      .eq('alert_trigger', 'thesis_invalidation')
      .gte('created_at', invCutoff)
      .order('created_at', { ascending: false })
      .limit(3);
    // Skip if we already invalidated in same direction within 15min
    const sameDirRecent = (recentInv ?? []).find(r => r.direction === payload.direction);
    if (sameDirRecent) {
      return { push: false, reason: `invalidation_same_direction_${payload.direction}_recent` };
    }
    return { push: true, reason: 'invalidation_new_direction' };
  }

  const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();

  const { data: recent } = await supabase
    .from('ct_slack_log')
    .select('direction, alert_trigger, convergence_cnt, created_at, pushed')
    .eq('pushed', true)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(10);

  if (!recent || recent.length === 0) {
    return { push: true, reason: 'no_recent_push' };
  }

  // Look for a push with same direction + trigger in window
  const sameSignal = recent.find(r =>
    r.direction === payload.direction &&
    r.alert_trigger === payload.alert_trigger
  );

  if (!sameSignal) {
    // Different direction or trigger = new signal = push
    return { push: true, reason: 'new_signal_type' };
  }

  // Convergence upgrade: prior count was 3, this is 4+ → push
  const priorCount = (sameSignal.convergence_cnt as number | null) ?? 0;
  const thisCount = payload.convergence_count ?? 0;
  if (thisCount > priorCount && thisCount >= 4) {
    return { push: true, reason: `convergence_upgrade_${priorCount}_to_${thisCount}` };
  }

  return { push: false, reason: `dedupe_same_signal_${sameSignal.direction}_${sameSignal.alert_trigger}` };
}

async function logSlackAttempt(
  supabase: SupabaseClient,
  source: string,
  payload: CtSlackPayload,
  pushed: boolean,
  skipReason: string | null,
): Promise<void> {
  try {
    await supabase.from('ct_slack_log').insert({
      source,
      state: payload.state,
      instruments: payload.instruments,
      direction: payload.direction ?? null,
      alert_trigger: payload.alert_trigger ?? null,
      conviction: payload.conviction ?? null,
      convergence_cnt: payload.convergence_count ?? null,
      event_id: payload.event_id ?? null,
      summary: (payload.glance[0] ?? '').slice(0, 300),
      pushed,
      skip_reason: skipReason,
    });
  } catch {
    // non-blocking
  }
}

function pickEmoji(state: CtSlackPayload['state']): string {
  switch (state) {
    case 'ALERT':       return ':rotating_light:';
    case 'FLAG':        return ':triangular_flag_on_post:';
    case 'RECAP':       return ':clipboard:';
    case 'DISAGREEMENT':return ':crossed_swords:';
    default:            return ':chart_with_upwards_trend:';
  }
}

export async function ctSlackPush(
  supabase: SupabaseClient,
  userId: string,
  payload: CtSlackPayload
): Promise<void> {
  // Dedupe — skip Slack push if same signal fired recently with no
  // material escalation. Still log the attempt for audit.
  const source = payload.state === 'ALERT' ? 'alert'
    : payload.state === 'FLAG' ? 'flag'
    : payload.state === 'RECAP' ? 'recap' : 'flag';
  const { push, reason } = await shouldPushToSlack(supabase, { ...payload, source });
  if (!push) {
    await logSlackAttempt(supabase, source, payload, false, reason);
    return;
  }

  try {
    const botToken = Deno.env.get('SLACK_BOT_TOKEN');
    if (!botToken) return;

    const { data: settings } = await supabase
      .from('user_settings')
      .select('settings')
      .eq('user_id', userId)
      .maybeSingle();
    const channelId = (settings?.settings as Record<string, unknown> | null)?.slack_channel_id as string | undefined;
    if (!channelId) return;

    const emoji = pickEmoji(payload.state);
    const header = `${emoji} *${payload.state}* · ${payload.instruments.join(', ')}${payload.conviction ? ` · conv ${payload.conviction}` : ''}${payload.horizon ? ` · ${payload.horizon}` : ''}${payload.alert_trigger ? ` · ${payload.alert_trigger}` : ''}`;
    const body = payload.glance.map(g => `• ${g}`).join('\n');
    const text = `${header}\n${body}`;

    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: channelId, text, mrkdwn: true }),
    });

    if (!res.ok) {
      console.warn('[ctSlack] post failed:', res.status);
      return;
    }
    const json = await res.json().catch(() => ({}));
    if (!json.ok) console.warn('[ctSlack] slack ok:false —', json.error);
    await logSlackAttempt(supabase, source, payload, true, null);
  } catch (e) {
    console.warn('[ctSlack] exception (non-blocking):', e instanceof Error ? e.message : e);
    await logSlackAttempt(supabase, source, payload, false, `exception:${e instanceof Error ? e.message.slice(0, 60) : 'unknown'}`);
  }
}

/**
 * Tilt transition push — fires ONCE when Claude's wrong streak crosses
 * into tilt territory (3+ in a row). Dedupe rule: never push another
 * tilt message in the same 30d window until the streak resets below 3
 * (i.e. a right/partial verdict lands). The caller in ct-grader is
 * responsible for passing the PRIOR wrong-streak count from before the
 * batch so we only fire on a true transition.
 *
 * Payload shape:
 *   { wrongStreak, priorWrongStreak, recoveryRate, recoveryHits,
 *     recoveryN, tickers[] }
 *
 * Copy: "⚠️ 3-wrong streak on {tickers}. Historical next-trade win
 * rate after 3L: X% (Y/Z). Consider pause or tighter setups only."
 *
 * Logs to ct_slack_log with source='tilt' so the cross-function dedupe
 * check below can spot a recent push regardless of who sent it.
 */
export async function ctSlackPushTiltTransition(
  supabase: SupabaseClient,
  userId: string,
  payload: {
    wrongStreak: number;
    priorWrongStreak: number;
    recoveryRate: number | null;
    recoveryHits: number;
    recoveryN: number;
    tickers: string[];
  },
): Promise<void> {
  // Transition guard: only push when we CROSS from <3 to >=3. The caller
  // provides priorWrongStreak — if it was already 3+, we've pushed before.
  if (payload.wrongStreak < 3) return;
  if (payload.priorWrongStreak >= 3) return;

  // Extra dedupe: within 24h, never fire another tilt push even if the
  // state oscillates. `ct_slack_log` is already the shared log table.
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recent } = await supabase
      .from('ct_slack_log')
      .select('created_at')
      .eq('source', 'tilt')
      .eq('pushed', true)
      .gte('created_at', cutoff)
      .limit(1);
    if (recent && recent.length > 0) return;
  } catch {
    // non-fatal — fall through to the push
  }

  const tickerStr = payload.tickers.length > 0
    ? payload.tickers.slice(0, 4).join(', ')
    : 'mixed';

  const rateStr = payload.recoveryRate != null && payload.recoveryHits >= 2
    ? `${Math.round(payload.recoveryRate * 100)}% (${payload.recoveryN} cases)`
    : 'insufficient history';

  const text =
    `:warning: *${payload.wrongStreak}-wrong streak* on ${tickerStr}. ` +
    `Historical recovery win rate after ${payload.wrongStreak}L: ${rateStr}. ` +
    `Consider pause or tighter setups only.`;

  try {
    const botToken = Deno.env.get('SLACK_BOT_TOKEN');
    if (!botToken) return;
    const { data: settings } = await supabase
      .from('user_settings').select('settings').eq('user_id', userId).maybeSingle();
    const channelId = (settings?.settings as Record<string, unknown> | null)?.slack_channel_id as string | undefined;
    if (!channelId) return;

    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: channelId, text, mrkdwn: true }),
    });
    const json = res.ok ? await res.json().catch(() => ({})) : {};
    await supabase.from('ct_slack_log').insert({
      source: 'tilt',
      summary: text.slice(0, 300),
      pushed: res.ok && (json.ok !== false),
      skip_reason: res.ok ? null : `http_${res.status}`,
    });
  } catch (e) {
    console.warn('[ctSlack:tilt] push failed:', e instanceof Error ? e.message : e);
  }
}

/**
 * Direct Slack push with no dedupe — for scheduled digests that MUST go
 * through regardless. Still logs to ct_slack_log.
 *
 * `text` is always sent as the fallback / notification body. If `blocks` is
 * provided, Slack renders the Block Kit layout instead of the plain text
 * (text becomes the push-notification / screenreader summary).
 */
export async function ctSlackPushDirect(
  supabase: SupabaseClient,
  userId: string,
  text: string,
  source: string,
  blocks?: Array<Record<string, unknown>>,
): Promise<void> {
  try {
    const botToken = Deno.env.get('SLACK_BOT_TOKEN');
    if (!botToken) return;
    const { data: settings } = await supabase
      .from('user_settings').select('settings').eq('user_id', userId).maybeSingle();
    const channelId = (settings?.settings as Record<string, unknown> | null)?.slack_channel_id as string | undefined;
    if (!channelId) return;

    const payload: Record<string, unknown> = { channel: channelId, text, mrkdwn: true };
    if (blocks && blocks.length > 0) payload.blocks = blocks;

    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.ok ? await res.json().catch(() => ({})) : {};
    await supabase.from('ct_slack_log').insert({
      source,
      summary: text.slice(0, 300),
      pushed: res.ok && (json.ok !== false),
      skip_reason: res.ok ? null : `http_${res.status}`,
    });
  } catch (e) {
    console.warn('[ctSlack] digest push failed:', e instanceof Error ? e.message : e);
  }
}
