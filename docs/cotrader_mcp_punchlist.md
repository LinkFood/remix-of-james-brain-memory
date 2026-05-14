# Cotrader MCP Punchlist

Open + recently-closed structural gaps in the cotrader MCP captain-bridge surface (`mcp/cotrader/tools/*.ts`). Tracking ground for the contract between substrate (`_shared/*Context.ts`, edge-function writers) and trading-Claude-visible projection.

Layered by structural intent. Each entry: surface affected, gap, fix shape if known, resolution status.

---

## 2026-05-14 — Post-Ship-11 contract verification gaps (Ship 13)

Captain ran an end-to-end MCP test in trading-Claude on 5/13 ~20:07 ET after the `/mcp` reconnect that followed Ship 11. Composed NVDA read demonstrated **meta-aware decision support** working as designed: brief LONG LEAN vs specialist NEUTRAL ("continuation-trap" framing) vs pulse `slope5min=-$198K` vs tape dead silent, with Principle #4 + Principle #7 applied at synthesis time, and semantic recall reaching 8 days back to a 5/6 analog at cosine 0.8919. Qualitative validation: **passed.**

Three **structural** contract gaps surfaced post-Ship-11 — substrate had landed at the writer/DB/composer layer but the cotrader MCP projection layer wasn't emitting the new fields. Plus one cosmetic gap (defer) and one separate-spec opportunity.

### Gaps resolved via Ship 13 (this PR)

| ID | Surface | Gap | Fix |
|---|---|---|---|
| **G1** | `mcp/cotrader/tools/get_morning_brief.ts` | `brief_version` selected from DB (Ship 5 race-fence schema) but not in `MorningBriefResponse` interface, not in `mapRow()`, not in `emptyResponse()`. Trading-Claude could see `meta.supersededCount` (envelope, camelCase) but not the brief-level integer. | Added `brief_version: number \| null` to `MorningBriefResponse`. Emitted on both populated + empty paths. **T2.9** in `run_verification.ts` covers regression. |
| **G2** | `mcp/cotrader/tools/get_morning_brief.ts` | `supersedes_id` IS in the SELECT projection (Phase A re-verified — initial scan miscount), and IS in `CtDailyBriefRow` interface, but not in `MorningBriefResponse` or `mapRow()`. Trading-Claude could not trace the supersession chain v1→v2→v3 from a single tool call. | Added `supersedes_id: string \| null` to `MorningBriefResponse`. Emitted on both populated + empty paths. **T2.10** covers regression. |
| **G3** | `_shared/specialistRecallContext.ts` + `_shared/contextHelper.ts` | Ship 10 emitted `unflagged_mode` (snake_case) at `data.unflagged_mode` on `SpecialistRecallResult` — but **not** at `organMetadata.unflagged_mode`. `OrganMetadata` schema had exactly 4 fields (`as_of` / `source` / `window` / `status`); the recall-path marker was structurally absent at the canonical organ-state surface. Trading-Claude reads `organMetadata` first as the contract layer; needing to dive into `data` to find the mode breaks the read pattern. | Added optional `unflagged_mode?: 'semantic' \| 'chronological_fallback' \| 'no_history'` to `OrganMetadata` interface (additive — other organs leave it `undefined`). Specialist recall's `buildOrganMetadata()` now emits it. Empty-result path also passes `'no_history'` for consistency with `data.unflagged_mode`. **T1.6** covers regression (sibling of Ship 11's T1.5 which checks the data-layer field). |

### Casing reconciliation (closed at Phase A — empirical, no code change)

Captain's Ship 10 brief intent used **camelCase** `unflaggedMode`. Shipped reality is **snake_case** `unflagged_mode`. Phase A surveyed the codebase:

- **Data-layer fields (organ output, brief content):** snake_case. Examples: `unflagged_mode`, `direction_lean`, `flag_id`, `flag_label`, `brief_id`, `triggered_by`, `accuracy_score`, `as_of`, `source`, `window`, `status`. Matches Postgres column convention + JSON-from-Postgres natural shape.
- **Envelope / meta fields (telemetry, tool plumbing):** camelCase. Examples: `consumerName`, `tool`, `rowCount`, `supersededCount`, `helperName`, `helperVersion`, `latencyMs`, `generatedAt`.

`organMetadata` lives at the data-output layer per its existing `as_of`/`source`/`window`/`status` siblings → new `unflagged_mode` field is snake_case per canon. **Shipped reality is correct.** Ship 10 brief intent + the Cowork-side canonical entry will be retro-corrected to match shipped (snake_case). Engine-room codified the family lesson: **contract-projection-can-be-correct-at-source-and-lossy-at-projection-or-vice-versa** — sibling to `audit-verification-surface-mismatch` (5/6).

### Deferred (cosmetic)

| ID | Surface | Gap | Defer-reason |
|---|---|---|---|
| **G4** | `mcp/cotrader/tools/get_morning_brief.ts` | `superseded_count` exists at `meta.supersededCount` (camelCase, envelope convention — correct per casing canon). No brief-level mirror. Trading-Claude has to look in the meta envelope to find the count rather than reading it adjacent to `brief_version` on the brief object. | Cosmetic only — the data IS exposed, just at the envelope rather than the brief surface. Mirror is a 1-line addition + 1-line interface entry; deferring keeps Ship 13 PR scope tight to structural gaps. Tracked here; close in a future ship if captain workflow surfaces friction. |

### Separate-spec opportunity (out-of-scope for Ship 13)

| ID | Surface | Opportunity | Why separate |
|---|---|---|---|
| **G5** | `mcp/cotrader/tools/get_morning_brief.ts` | The `date` arg lets trading-Claude fetch a specific session's brief. Combined with Ship 6's `accuracy_score` + `accuracy_notes` projection (Ship 11), this gives forensic MCP access to yesterday's grade + the Property loop's RECALL stage at the bridge surface. Worth a dedicated brief that thinks through whether `date=yesterday` should auto-fetch the bridged accuracy data OR whether a separate `get_prior_brief_summary` tool is the right shape. | Adds new contract surface (param semantics or tool name) — design call worthy of its own scoping pass, not a one-line projection fix. |

---

## Closed earlier (archival)

(No prior entries — this file is being created with Ship 13. Pre-Ship-13 contract work tracked in CLAUDE.md timeline + the Ship 11 entry in the 5/13 session wrap.)
