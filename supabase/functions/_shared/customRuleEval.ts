/**
 * customRuleEval — pure, dependency-free evaluator for ct_custom_rules.
 *
 * A "state" is a nested object keyed by symbol. Field paths like
 *   "SPY.price" | "SPY.NOPE" | "NVDA.iv_rank" | "VIX.level"
 * are resolved via dotted lookup against the state. The evaluator DOES NOT
 * know how to fetch state — the caller builds { current, prior } objects and
 * passes them in. Keeping this module pure means:
 *
 *   - The edge function can unit-test it without spinning up Supabase.
 *   - The frontend can reuse it for a "Test" button that evaluates a
 *     draft rule against the same state the cron would see.
 *
 * Ops supported:
 *   lt | lte | gt | gte | eq          — compare current value to clause.value
 *   crosses_above                      — prior <= value && current > value
 *   crosses_below                      — prior >= value && current < value
 *   changed                            — prior !== current (any change)
 *
 * Security notes:
 *   - `field` and `op` are validated against allow-lists. Anything else is
 *     rejected with `{ matches: false, reason: 'invalid_field_or_op' }`.
 *   - `value` is always compared as-is; no eval, no string interpolation.
 *     The evaluator NEVER constructs SQL. Condition storage is jsonb; the
 *     cron reads it back via PostgREST which is already safe. The only
 *     user-supplied string that hits a downstream system is `field`, and
 *     we restrict that to a regex `^[A-Z0-9_]+\.[A-Za-z0-9_]+$`.
 */

export type RuleOp =
  | 'lt' | 'lte' | 'gt' | 'gte' | 'eq'
  | 'crosses_above' | 'crosses_below'
  | 'changed';

export interface RuleClause {
  field: string;               // e.g. "SPY.price"
  op: RuleOp;
  value?: number | string;     // required for all ops except 'changed'
  window_min?: number;         // informational — caller decides lookback. Clamped [1, 60].
}

export interface EvalResult {
  matches: boolean;
  matched_clauses: string[];   // human-readable descriptions of clauses that matched
  evaluations: Array<{
    clause: RuleClause;
    matched: boolean;
    current: number | string | null;
    prior: number | string | null;
    reason: string;
  }>;
}

// Safe-field allow-list: must look like `TICKER.metric` where TICKER is
// uppercase alnum+underscore (1-12 chars) and metric is alnum+underscore.
// This blocks prototype-pollution style fields like "__proto__.x".
const FIELD_RE = /^[A-Z][A-Z0-9_]{0,11}\.[A-Za-z][A-Za-z0-9_]{0,31}$/;

const VALID_OPS: ReadonlySet<RuleOp> = new Set([
  'lt', 'lte', 'gt', 'gte', 'eq',
  'crosses_above', 'crosses_below',
  'changed',
]);

/** Dotted-path lookup limited to ONE level of nesting. Matches FIELD_RE. */
function lookup(
  state: Record<string, unknown> | null | undefined,
  field: string,
): number | string | null {
  if (!state || typeof state !== 'object') return null;
  const dot = field.indexOf('.');
  if (dot < 0) return null;
  const head = field.slice(0, dot);
  const tail = field.slice(dot + 1);
  // Avoid prototype walk.
  if (!Object.prototype.hasOwnProperty.call(state, head)) return null;
  const sub = (state as Record<string, unknown>)[head];
  if (!sub || typeof sub !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(sub, tail)) return null;
  const v = (sub as Record<string, unknown>)[tail];
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  // Coerce booleans to number for basic comparisons.
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

/** Evaluate one clause. */
function evalClause(
  clause: RuleClause,
  current: Record<string, unknown>,
  prior: Record<string, unknown>,
): {
  matched: boolean;
  current: number | string | null;
  prior: number | string | null;
  reason: string;
} {
  // Field/op validation (defense in depth — the UI also validates).
  if (typeof clause.field !== 'string' || !FIELD_RE.test(clause.field)) {
    return { matched: false, current: null, prior: null, reason: 'invalid_field' };
  }
  if (!VALID_OPS.has(clause.op)) {
    return { matched: false, current: null, prior: null, reason: 'invalid_op' };
  }

  const cur = lookup(current, clause.field);
  const pri = lookup(prior, clause.field);

  // For all ops except `changed`, a null current means we can't evaluate.
  if (clause.op !== 'changed' && cur === null) {
    return { matched: false, current: null, prior: pri, reason: 'no_current_value' };
  }

  // Numeric ops
  const needsNumericCur = clause.op !== 'changed' && clause.op !== 'eq';
  if (needsNumericCur && typeof cur !== 'number') {
    return { matched: false, current: cur, prior: pri, reason: 'current_not_numeric' };
  }

  // For crosses_*, we need both sides as numbers.
  const isCross = clause.op === 'crosses_above' || clause.op === 'crosses_below';
  if (isCross && typeof pri !== 'number') {
    return { matched: false, current: cur, prior: pri, reason: 'no_prior_value_for_cross' };
  }

  switch (clause.op) {
    case 'lt':
      return {
        matched: typeof clause.value === 'number' && (cur as number) < clause.value,
        current: cur, prior: pri,
        reason: `${cur} < ${clause.value}`,
      };
    case 'lte':
      return {
        matched: typeof clause.value === 'number' && (cur as number) <= clause.value,
        current: cur, prior: pri,
        reason: `${cur} <= ${clause.value}`,
      };
    case 'gt':
      return {
        matched: typeof clause.value === 'number' && (cur as number) > clause.value,
        current: cur, prior: pri,
        reason: `${cur} > ${clause.value}`,
      };
    case 'gte':
      return {
        matched: typeof clause.value === 'number' && (cur as number) >= clause.value,
        current: cur, prior: pri,
        reason: `${cur} >= ${clause.value}`,
      };
    case 'eq':
      return {
        matched: clause.value !== undefined && cur === clause.value,
        current: cur, prior: pri,
        reason: `${cur} == ${clause.value}`,
      };
    case 'crosses_above': {
      const v = clause.value;
      const matched = typeof v === 'number'
        && typeof pri === 'number'
        && typeof cur === 'number'
        && pri <= v && cur > v;
      return {
        matched,
        current: cur, prior: pri,
        reason: `prior=${pri} cur=${cur} threshold=${v}`,
      };
    }
    case 'crosses_below': {
      const v = clause.value;
      const matched = typeof v === 'number'
        && typeof pri === 'number'
        && typeof cur === 'number'
        && pri >= v && cur < v;
      return {
        matched,
        current: cur, prior: pri,
        reason: `prior=${pri} cur=${cur} threshold=${v}`,
      };
    }
    case 'changed':
      return {
        matched: pri !== null && cur !== null && pri !== cur,
        current: cur, prior: pri,
        reason: `prior=${pri} cur=${cur}`,
      };
  }
}

/**
 * Evaluate all clauses against the supplied current + prior state objects.
 *
 * @param clauses     parsed array of RuleClause
 * @param matchLogic  'all' (AND) or 'any' (OR)
 * @param current     nested state object — shape: { "SPY": { price: 711, ... }, "VIX": { level: 14.2 } }
 * @param prior       same shape, from the previous heartbeat (or earlier tick for crosses_*)
 */
export function evaluateConditions(
  clauses: unknown,
  matchLogic: 'all' | 'any',
  current: Record<string, unknown>,
  prior: Record<string, unknown>,
): EvalResult {
  const safe = Array.isArray(clauses) ? (clauses as RuleClause[]) : [];
  if (safe.length === 0) {
    return { matches: false, matched_clauses: [], evaluations: [] };
  }

  const evaluations = safe.map((c) => ({
    clause: c,
    ...evalClause(c, current, prior),
  }));

  const anyMatched = evaluations.some((e) => e.matched);
  const allMatched = evaluations.every((e) => e.matched);
  const matches = matchLogic === 'all' ? allMatched : anyMatched;

  const matched_clauses = evaluations
    .filter((e) => e.matched)
    .map((e) => `${e.clause.field} ${e.clause.op}${e.clause.value !== undefined ? ` ${e.clause.value}` : ''} (cur=${e.current}, prior=${e.prior})`);

  return { matches, matched_clauses, evaluations };
}

/**
 * Shallow validator for a rule body. Returns a list of human-readable
 * errors; empty array = valid. Used by both the edge function (belt + braces)
 * and the frontend form.
 */
export function validateRule(body: {
  name?: unknown;
  conditions?: unknown;
  match_logic?: unknown;
  action?: unknown;
}): string[] {
  const errors: string[] = [];

  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    errors.push('name required');
  } else if (body.name.length > 120) {
    errors.push('name too long (max 120)');
  }

  if (!Array.isArray(body.conditions)) {
    errors.push('conditions must be an array');
  } else {
    if (body.conditions.length === 0) errors.push('at least one condition required');
    if (body.conditions.length > 10) errors.push('too many conditions (max 10)');
    body.conditions.forEach((c: unknown, i: number) => {
      if (!c || typeof c !== 'object') {
        errors.push(`condition[${i}] must be an object`); return;
      }
      const cl = c as Record<string, unknown>;
      if (typeof cl.field !== 'string' || !FIELD_RE.test(cl.field)) {
        errors.push(`condition[${i}].field invalid — expected TICKER.metric`);
      }
      if (typeof cl.op !== 'string' || !VALID_OPS.has(cl.op as RuleOp)) {
        errors.push(`condition[${i}].op invalid`);
      }
      if (cl.op !== 'changed') {
        if (typeof cl.value !== 'number' && typeof cl.value !== 'string') {
          errors.push(`condition[${i}].value required`);
        }
      }
      if (cl.window_min !== undefined) {
        if (typeof cl.window_min !== 'number' || cl.window_min < 1 || cl.window_min > 60) {
          errors.push(`condition[${i}].window_min must be 1-60`);
        }
      }
    });
  }

  if (body.match_logic !== 'all' && body.match_logic !== 'any') {
    errors.push("match_logic must be 'all' or 'any'");
  }
  if (body.action !== 'slack' && body.action !== 'log' && body.action !== 'both') {
    errors.push("action must be 'slack', 'log', or 'both'");
  }

  return errors;
}
