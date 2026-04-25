/**
 * detectorRegistry — single read surface for the ct_detectors table.
 *
 * Every detector function (signature watcher, cluster loop, future Whale /
 * Unusual OI / cross-ticker pair detectors) calls into this module to
 * discover its own active config without a code change. Per tenet 25:
 * adding a detector is a database INSERT, not a deploy.
 *
 * The registry intentionally has no caching layer yet — Wave 1 ships
 * foundation, not optimization. If a watcher hot-loop ever shows the per-
 * sweep RPC as a meaningful share of latency, add a 60s TTL here.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

export type DetectorStatus = 'shadow' | 'trial' | 'live' | 'decay' | 'retired';

export interface Detector {
  id: string;
  name: string;
  status: DetectorStatus;
  config: Record<string, unknown>;
}

// "Active" = anything that should fire today. retired/decay are excluded.
const ACTIVE_STATUSES: DetectorStatus[] = ['shadow', 'trial', 'live'];

/**
 * Loads all active detectors. Optional `prefix` filters by id prefix
 * (e.g. 'cluster_' returns every cluster variant — used by the watcher's
 * multi-config cluster loop).
 */
export async function loadActiveDetectors(
  supabase: SupabaseClient,
  prefix?: string,
): Promise<Detector[]> {
  let query = supabase
    .from('ct_detectors')
    .select('id, name, status, config')
    .in('status', ACTIVE_STATUSES);
  if (prefix) query = query.like('id', `${prefix}%`);
  const { data, error } = await query;
  if (error || !data) return [];
  return (data as Array<{ id: string; name: string; status: string; config: unknown }>)
    .filter((r) => ACTIVE_STATUSES.includes(r.status as DetectorStatus))
    .map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status as DetectorStatus,
      config: (r.config && typeof r.config === 'object') ? r.config as Record<string, unknown> : {},
    }));
}

/**
 * Loads one detector by id. Returns null if missing OR retired — callers
 * should not stamp detector_id with an inactive row.
 */
export async function loadDetector(
  supabase: SupabaseClient,
  id: string,
): Promise<Detector | null> {
  const { data, error } = await supabase
    .from('ct_detectors')
    .select('id, name, status, config')
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return null;
  const status = data.status as DetectorStatus;
  if (status === 'retired') return null;
  return {
    id: data.id,
    name: data.name,
    status,
    config: (data.config && typeof data.config === 'object') ? data.config as Record<string, unknown> : {},
  };
}
