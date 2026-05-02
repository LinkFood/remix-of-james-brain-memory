# Detector Documentation Index

One markdown page per row in `ct_detectors`. Each page follows the
template below. Authored Mon-Tue-Wed per the Phase A schedule
([decision: 2026-05-02-phase-a-detector-docs](../decisions/2026-05-02-phase-a-detector-docs.md)).

## Inventory

| id | name | status | source_file | dte_class |
|---|---|---|---|---|
| [`scorer_v1`](./scorer_v1.md) | Scorer (volatility-magnitude) | shadow | `supabase/functions/ct-detector-scorer/index.ts` | all |
| [`signature_v1`](./signature_v1.md) | Signature class match | live | `supabase/functions/ct-signature-watcher/index.ts` | all |
| [`cluster_default`](./cluster_default.md) | Cluster (5min/3prints/2%/80%) | live | `ct-signature-watcher` (config-driven) | all |
| [`cluster_slow_stacker`](./cluster_slow_stacker.md) | Slow Stacker (15min/5prints/3%/75%) | trial | `ct-signature-watcher` (config-driven) | all |
| [`specialist_flag`](./specialist_flag.md) | Specialist direct flag | live | `ct-watcher/index.ts:583` + `docs/specialist-prompts/v2/*.txt` | all |
| [`whale_v1`](./whale_v1.md) | Whale detector | shadow | `ct-detector-whale/index.ts` | all |
| [`unusual_oi_v1`](./unusual_oi_v1.md) | Unusual OI | shadow | `ct-detector-unusual-oi/index.ts` | all |
| [`pair_qqq_iwm_v1`](./pair_qqq_iwm_v1.md) | QQQ-IWM pair divergence | shadow | `ct-detector-pair-qqq-iwm/index.ts` | all |
| [`smart_money_repeat_v1`](./smart_money_repeat_v1.md) | Same-contract repeat cluster | shadow | `ct-detector-smart-money-repeat/index.ts` | non_0dte |
| [`weekly_atm_voi_v1`](./weekly_atm_voi_v1.md) | Weekly ATM with V/OI ≥ 1 | shadow | `ct-detector-weekly-atm-voi/index.ts` | non_0dte |
| [`small_cap_inverted_put_v1`](./small_cap_inverted_put_v1.md) | TSLA/IWM aggressive bid-put → bearish | shadow | `ct-detector-small-cap-inverted-put/index.ts` | all |
| [`zerodte_put_voi_extreme_v1`](./zerodte_put_voi_extreme_v1.md) | 0DTE put V/OI extreme | shadow | `ct-detector-zerodte-put-voi/index.ts` | 0dte |
| [`zerodte_opening_call_v1`](./zerodte_opening_call_v1.md) | 0DTE opening hour ask-call | shadow | `ct-detector-zerodte-opening-call/index.ts` | 0dte |
| [`flow_stack_v1`](./flow_stack_v1.md) | Flow Stack — heatmap concentration | shadow | `ct-detector-flow-stack-v1/index.ts` | all |

(All inventory rows status as of 2026-05-02. Live status is the source of
truth — `SELECT id, status FROM ct_detectors`.)

## Page template

```markdown
# <Detector Name> (`<id>`)

- **Status:** shadow | trial | live | decay | retired
- **Source file:** <path>
- **DTE class:** <dte_class or "any">
- **Live config row:** SELECT * FROM ct_detectors WHERE id = '<id>'

## What it sees

<one paragraph: input signals consumed — flow alerts, price bars, OI,
gamma, snapshots>

## Math

<key thresholds + formulas, with specific config keys (ct_config.*) so
future tuners know where to turn the dials>

## Regime fit

<when the detector works — trending, chop, vol spikes. If unknown, mark
"TBD — needs calibration history.">

## False-positive shapes

<known whip-saw modes — earnings drift, dealer hedging, mid-prints,
RepeatedHits-without-aggressor, etc.>

## Demote criteria

<what would move this from live → trial or trial → decay. Hit rate
floor (composite metric per `2026-05-02-detector-lifecycle-thresholds.md`)?
Sample-size requirement?>

## Calibration history

<commits or memory references where thresholds got tuned. Format:
"commit <hash> 2026-04-XX — bumped X from Y to Z because <reason>".
If no history, "TBD".>
```

## Authoring rules (Phase B Mon-Tue-Wed)

1. **Source-of-truth order** for any number: live `ct_config` row → migration that seeded it → code consumer → this doc page (synthesized).
2. **Don't paste config JSONB verbatim.** Reference the `ct_config` keys; readers query the live values.
3. **Calibration history requires git archeology.** Use `git log --all --oneline -- supabase/functions/<detector_dir>/` and `git log --grep "<detector_id>"` to find tuning commits.
4. **Memory-only context** (e.g., corpus baselines for `smart_money_repeat_v1`) — link the memory file under `~/.claude/projects/-Users-jameschellis/memory/` so future engineers can find the source.
5. **Two pre-Phase-B blockers** flagged in [Phase A](../decisions/2026-05-02-phase-a-detector-docs.md):
   - `zerodte_put_voi_extreme_v1` thesis "≥20" vs config `5.0` — config wins (per [Q3 fire-rate audit](../decisions/2026-05-02-saturday-night-audit-results.md), it's actively firing at 5.0).
   - Directory layout — confirmed: this dir uses `<id>.md` per file. Index is `README.md`.

## Cross-references

- [Phase A scope](../decisions/2026-05-02-phase-a-detector-docs.md)
- [Lifecycle thresholds for hit-rate scoring](../decisions/2026-05-02-detector-lifecycle-thresholds.md)
- `docs/DOMAIN_GLOSSARY.md` — canonical term definitions (universe, math modes, conviction, etc.)
- `docs/specialist-prompts/v2/*.txt` — companion structure for specialist-side detectors
