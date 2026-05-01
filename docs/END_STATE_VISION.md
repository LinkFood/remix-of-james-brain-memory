# The End State — Captain Into The Storm

This is the human-onboarding companion to the governing-image section in `CLAUDE.md`. The CLAUDE.md version is the load-bearing reference every build decision evaluates against. This document develops the metaphor and pins specific architectural commitments to it. Future sessions and humans new to the project read this when "what is the system actually trying to be" is the question.

For runtime, the synthesis layer's `buildClaudeContext` preamble carries the operational frame. For **build judgment**, this document plus the CLAUDE.md section is the frame.

---

## The captain

A normal trader walks into Monday somewhat cold. Catches up on weekend news while the bell rings. Reads the tape as it happens.

The captain walks into Monday already knowing the week's storm shape. FOMC Wednesday at 2 PM ET. AAPL reports Tuesday close. MSFT Wednesday post. GOOGL Thursday post. Pulse is steady-positive into a high-IV catalyst week. The heatmap shows call-side premium stacking on QQQ at next-Friday's expiry. The NVDA specialist has been raising conviction since Friday. The news watcher caught a Bloomberg whisper on iPhone demand Sunday night. The last three FOMC weeks in this Pulse regime resolved with a specific pattern. The Warden confirms all crons green and the brain organs firing.

When the bell rings at 9:30 AM ET Monday, the captain is not reacting to flow. The captain is **reading flow through prior knowledge of what's coming.** Same data hits the screen as everyone else; it lands with a different signal-to-noise ratio because it lands on prepared ground.

That's the operational vision. Co-Trader is the apparatus that prepares the ground.

---

## Structural multiplication, not additive context

The commercial pitch for "AI in trading" is usually additive: more dashboards, more news feeds, more chat windows, more Discord alerts. Stack enough and you'll be informed. The promise is that signal scales linearly with sources.

It doesn't. Signal scales **multiplicatively** with structural layering.

- **Layer 1 — Tape alone.** The raw print stream. Anyone with a UW subscription has this. It's noise unless filtered.
- **Layer 2 — Tape × regime.** Now every print is interpreted through "what kind of market is this." A $5M call sweep means one thing in trending-positive Pulse, a different thing in oscillation regime, a third thing in vol-crush. The same print, three reads. Pulse turns the tape from raw flow into regime-conditional flow.
- **Layer 3 — Tape × regime × historical analog.** Now the read includes "the last three sessions where Pulse looked like this and a similar print landed, the resolution pattern was X." Recall converts pattern recognition into base rates the captain can weight. The print is no longer just "interesting" — it's "interesting in a way that historically resolves Y% of the time."

Each layer multiplies signal-to-noise on the layer below by filtering through a previously absorbed structure. Three layers stacked is the asymmetry institutional desks pay quants to manufacture. Citadel, Two Sigma, Renaissance — that's what they build at scale, with PhDs and proprietary feeds.

Co-Trader manufactures it for one trader, on consumer APIs, with the captain steering — never riding.

The non-negotiable: **complexity that doesn't multiply doesn't ship.** Adding a tenth dashboard widget to /tape that doesn't filter through prior layers is additive complexity. Adding an organ that converts the tape into regime-conditional output is multiplicative. The first is forbidden; the second is the work.

---

## The architecture as captain's instruments

Each piece of the codebase maps to part of the captain's reading apparatus. The mapping is not metaphor — it's a structural commitment about what each piece exists to do, and a discipline test for proposed changes ("does this make the named instrument better, or does it add a different instrument the captain doesn't need?").

| Instrument | Codebase | Purpose |
|---|---|---|
| **The captain's memory of the last storm** | `specialistRecallContext.ts` + `ct_specialist_reads + ct_flag_grades` | Each specialist sees its own prior reads on this ticker, with the grades attached. Narrative positions persist across days; streaks become visible without driving lean. |
| **Where positioning is staging** | `flowHeatmapContext` + `ct_flow_alerts` | Cross-ticker × expiry-week intensity grid. Reveals where the dealer book is being built, days or weeks before the move that proves it. |
| **Barometer reading** | `eventRecencyContext` + `ct_events` + earnings + central-bank surfaces | What just happened in the last 72h, what's happening today, what's coming in the next 14d. The captain's storm-arrival timeline. |
| **Regime swell** | `pulseContext` + `ct_flow_pulse_ticks` | Real-time net premium + slope + regime tag. The wave the boat is currently sitting on. |
| **The captain's nine sensory inputs** | `buildClaudeContext` orchestrator | Single read API across nine organs, audience-filtered, telemetry-instrumented, fire-and-forget. The captain hears, sees, smells, and remembers in one prompt. |
| **Firewall against confabulating coordinates** | `temporalValidator`, `eventCoherenceValidator`, `tickerCoherenceValidator` | The captain may not invent ports of call. Every output is post-checked against the supplied data and the universe lockdown. CDNS-class fabrications get caught, flagged, and surfaced to the Warden. |
| **The boat's integrity check** | `ct-system-warden` + `ct_invariants` | 12-13 invariants run every 30 min. State-change Slack. Dead crons, stale data, off-universe mentions, budget badges showing wrong numbers — all visible. The captain isn't sailing a boat with hidden leaks. |
| **Discipline rails** | Tenets 1, 3, 4, 13, 15, 25, 26 | Flag-don't-trade. Microscope-not-fund. Class-kill-not-instance-patch. Three-mode architecture (autonomous / UI / analysis). Without these, "captain reading the storm" becomes "captain trading the storm" — and the AI breaks. The captain steers, never rides. |

When a new build proposal arrives, the test is: which instrument does this improve? If the answer is "none — it's a new feature alongside the existing instruments," the proposal is *probably* additive complexity and should be rejected or redesigned until it sharpens an existing instrument or replaces one with a better one.

---

## The discipline boundary

The captain steers — never rides.

This is the bright line that protects the architecture from the failure mode that historically breaks AI-in-trading systems: the model becomes the trader. P&L feedback corrupts the model. Survival pressure makes it conservative or reckless. Risk management eats the signal layer. Position sizing eats the alarm layer. The signal degrades; the AI degrades; the trader's edge degrades.

Co-Trader resists this by structural commitment, not willpower:

- **Flag, don't trade.** The system surfaces signal. James trades. The model is never on the hook for execution outcome — the metric is detection accuracy and trust-per-alarm, not P&L.
- **Microscope, not fund.** Detection sophistication of an institutional desk, deployed for one trader, on retail data. The asymmetry is *seeing*, not *executing*.
- **Structural prevention, not patches.** Every fix asks "does this class of failure become impossible going forward, or am I patching this instance?" If patching, redesign.
- **Autonomy without compromise.** Self-modification gates exist — the code agent opens PRs, replay-on-PR (not yet wired) will gate auto-merge. But James reviews; James decides; the system does not change its own steering inputs without human review.

The captain steers means: when in doubt about whether a feature crosses the line from amplifier to operator, the answer is "amplifier." If a feature requires the system to know the trader's positions, evaluate the trader's decisions, or learn from the trader's P&L — it's an operator feature. Cut it.

The captain steers means: when in doubt about whether a feature serves the captain's reading or the system's autonomy — the answer is "the captain's reading." If a feature is "the system makes a decision the captain didn't ask for" — it's autonomy creep. Cut it.

---

## Build evaluation — the decision-ritual extension

The base decision ritual (Tenet 4): *"Does this class of failure become impossible going forward, or am I patching this instance?"* If patching, stop and redesign.

The End State extends it: *"Does this make the captain better at reading the storm, or does it add complexity that doesn't compound?"* If the latter, stop and redesign.

A build proposal that fails either ritual gets sent back. A build proposal that passes both — by killing a class of failure structurally AND multiplying the captain's reading capacity — that's the kind of work that earns the time it takes.

The synthesis layer was a both-rituals build: it killed the temporal-hallucination class structurally AND multiplied every consumer's reading capacity by giving them all nine sensory inputs at once. The Warden was a both-rituals build: it killed the silent-wrongness class structurally AND made the boat's integrity visible to the captain instead of hidden. The specialist recall property is a both-rituals build: it kills the per-fire amnesia class structurally AND adds memory to the captain's last-storm read.

Builds that fail one or both rituals: a tenth widget that doesn't filter through prior layers, a "smart suggestion" feature that puts the system on the steering wheel, a backwards-compatibility shim, a band-aid validator that catches the latest instance instead of redesigning the class.

The discipline is to know the difference and act on it.

---

## What's "done"

Co-Trader is never "done." The architecture compounds — each loop closure makes the next closure cheaper. The day-180 architecture should look different from the day-30 architecture (Tenet 25). The day-365 should look different from day-180. If the system stops evolving in structure, the work stalled.

The captain stays the captain. The storm changes. The boat keeps getting better.

That's the end state.
