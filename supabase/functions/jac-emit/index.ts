/**
 * jac-emit — JAC kernel dispatch.
 *
 * Inputs:  { emission_id, targets?: string[] (override jac_emissions.dispatched_targets) }
 * Output:  { emission_id, dispatched: [{target, status, at, note?}] }
 *
 * Reads emission_id from jac_emissions, fetches trigger config (for default
 * targets + per-user channel routing), and dispatches the emission to each
 * target. Phase 1 supports:
 *   - 'slack' → ctSlackPushDirect (Slack mrkdwn + blocks)
 *   - 'feed'  → no-op, logged as 'deferred_phase_2' (site feed lands Phase 2)
 *
 * Updates jac_emissions.dispatched_targets with attempt records (per-target
 * status: sent | failed | skipped | deferred). Idempotent: re-dispatching
 * an already-sent emission is a no-op (skips targets already marked 'sent').
 *
 * Auth: service-role only.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';

interface EmitRequest {
  emission_id: string;
  targets?: string[];
  user_id?: string | null;
}

interface DispatchRecord {
  target: string;
  status: 'sent' | 'failed' | 'skipped' | 'deferred';
  at: string;
  note?: string;
}

interface EmissionRow {
  id: string;
  trigger_id: string | null;
  trigger_name: string;
  application: string;
  severity: string;
  event_payload: Record<string, unknown>;
  event_dedup_key: string;
  headline: string | null;
  take_text: string | null;
  links: Record<string, string> | null;
  source_organs: string[] | null;
  dispatched_targets: DispatchRecord[];
}

interface TriggerRow {
  emission_targets: string[];
}

const SEVERITY_ICONS: Record<string, string> = {
  info: ':information_source:',
  signal: ':zap:',
  alert: ':rotating_light:',
  critical: ':boom:',
};

function buildSlackBlocks(em: EmissionRow): Array<Record<string, unknown>> {
  const icon = SEVERITY_ICONS[em.severity] ?? ':zap:';
  const headline = em.headline ?? `${em.severity.toUpperCase()} emission`;
  const take = em.take_text ?? '(no take composed)';

  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${icon} *${headline}*\n${take}`,
      },
    },
  ];

  // Context line: trigger + severity + dedup key (helps captain attribute).
  const contextEls: Array<Record<string, unknown>> = [
    { type: 'mrkdwn', text: `_trigger: ${em.trigger_name}_` },
    { type: 'mrkdwn', text: `_severity: ${em.severity}_` },
    { type: 'mrkdwn', text: `_key: ${em.event_dedup_key}_` },
  ];
  if (em.source_organs && em.source_organs.length > 0) {
    contextEls.push({ type: 'mrkdwn', text: `_organs: ${em.source_organs.join(', ')}_` });
  }
  blocks.push({ type: 'context', elements: contextEls });

  // Optional links section.
  if (em.links && Object.keys(em.links).length > 0) {
    const linkLines = Object.entries(em.links)
      .filter(([_, v]) => typeof v === 'string' && v.length > 0)
      .map(([k, v]) => `<${v}|${k}>`)
      .join(' · ');
    if (linkLines) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: linkLines }],
      });
    }
  }

  return blocks;
}

function buildSlackText(em: EmissionRow): string {
  const icon = SEVERITY_ICONS[em.severity] ?? '⚡';
  return `${icon} ${em.headline ?? em.trigger_name} — ${em.take_text ?? ''}`.slice(0, 500);
}

async function findUserId(supabase: SupabaseClient): Promise<string | null> {
  // Phase 1: single-user system. Pick the only profile whose user_settings
  // has a slack_channel_id configured. Captures James's profile.
  const { data, error } = await supabase
    .from('user_settings')
    .select('user_id, settings')
    .limit(10);
  if (error || !data) return null;
  for (const row of data) {
    const s = row.settings as Record<string, unknown> | null;
    if (s && typeof s.slack_channel_id === 'string') return row.user_id as string;
  }
  return null;
}

async function dispatchSlack(
  supabase: SupabaseClient,
  em: EmissionRow,
  userId: string,
): Promise<DispatchRecord> {
  const at = new Date().toISOString();
  try {
    const text = buildSlackText(em);
    const blocks = buildSlackBlocks(em);
    await ctSlackPushDirect(
      supabase,
      userId,
      text,
      `jac-emission:${em.trigger_name}`,
      blocks,
    );
    return { target: 'slack', status: 'sent', at };
  } catch (e) {
    return {
      target: 'slack',
      status: 'failed',
      at,
      note: (e instanceof Error ? e.message : String(e)).slice(0, 200),
    };
  }
}

async function dispatchFeed(_em: EmissionRow): Promise<DispatchRecord> {
  return {
    target: 'feed',
    status: 'deferred',
    at: new Date().toISOString(),
    note: 'site_feed_phase_2_pending',
  };
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: EmitRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!body.emission_id) {
    return new Response(JSON.stringify({ error: 'emission_id_required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // 1. Load emission row.
  const { data: em, error: emErr } = await supabase
    .from('jac_emissions')
    .select('id, trigger_id, trigger_name, application, severity, event_payload, event_dedup_key, headline, take_text, links, source_organs, dispatched_targets')
    .eq('id', body.emission_id)
    .single();

  if (emErr || !em) {
    return new Response(
      JSON.stringify({ error: 'emission_not_found', emission_id: body.emission_id }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const emission = em as unknown as EmissionRow;
  const existingDispatches = Array.isArray(emission.dispatched_targets)
    ? emission.dispatched_targets : [];

  // 2. Resolve targets — request override OR trigger config.
  let targets = body.targets;
  if (!targets || targets.length === 0) {
    if (emission.trigger_id) {
      const { data: trig } = await supabase
        .from('jac_emission_triggers')
        .select('emission_targets')
        .eq('id', emission.trigger_id)
        .maybeSingle();
      targets = (trig as TriggerRow | null)?.emission_targets ?? ['slack'];
    } else {
      targets = ['slack'];
    }
  }

  // 3. Resolve user for Slack routing.
  const userId = body.user_id ?? await findUserId(supabase);

  // 4. Dispatch each target.
  const dispatched: DispatchRecord[] = [];
  for (const target of targets) {
    // Idempotency: skip if already sent.
    const prior = existingDispatches.find((d) => d.target === target && d.status === 'sent');
    if (prior) {
      dispatched.push({
        target,
        status: 'skipped',
        at: new Date().toISOString(),
        note: `already_sent_at:${prior.at}`,
      });
      continue;
    }

    if (target === 'slack') {
      if (!userId) {
        dispatched.push({
          target: 'slack',
          status: 'failed',
          at: new Date().toISOString(),
          note: 'no_user_with_slack_channel_configured',
        });
      } else {
        dispatched.push(await dispatchSlack(supabase, emission, userId));
      }
    } else if (target === 'feed') {
      dispatched.push(await dispatchFeed(emission));
    } else {
      dispatched.push({
        target,
        status: 'failed',
        at: new Date().toISOString(),
        note: 'unknown_target',
      });
    }
  }

  // 5. Update jac_emissions.dispatched_targets (append new attempts).
  const merged = [...existingDispatches, ...dispatched];
  const { error: updErr } = await supabase
    .from('jac_emissions')
    .update({ dispatched_targets: merged })
    .eq('id', emission.id);

  if (updErr) {
    console.warn('[jac-emit] failed to update dispatched_targets:', updErr.message);
  }

  return new Response(
    JSON.stringify({ emission_id: emission.id, dispatched }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
