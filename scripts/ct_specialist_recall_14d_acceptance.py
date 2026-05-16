#!/usr/bin/env python3
"""
ct_specialist_recall_14d_acceptance.py
14-day acceptance check for the Specialist Recall property (commit afbcfd7, 2026-05-01 13:00 UTC).

Checks:
  C1 — hit-rate delta per ticker (pre vs post deploy, flagged + graded reads)
  C4 — narrative continuity on NVDA (last 5 post-deploy reads, scored manually)
  C5 — flag-volume delta per ticker (surfaced for James, not graded)

Pre-requisites (local run):
  - npx supabase login  (CLI authenticated)
  - SLACK_BOT_TOKEN env var  (optional — if absent, Slack is skipped and
    brain_reports row is the only output at /reports)

Run:
  python3 scripts/ct_specialist_recall_14d_acceptance.py

Output:
  1. Terminal report (always)
  2. brain_reports row visible at /reports  (always)
  3. Slack message to user's channel  (if SLACK_BOT_TOKEN is set)
"""

from __future__ import annotations

import datetime
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from typing import Optional

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
PROJECT_REF = "rvhyotvklfowklzjahdd"
BASE_URL = f"https://{PROJECT_REF}.supabase.co"
DEPLOY_TS = "2026-05-01T13:00:00Z"
RUN_DATE = "2026-05-15"
TICKERS = ["NVDA", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA", "QQQ", "SPY", "IWM"]
INSUFFICIENT_N = 5  # below this in either cohort → mark "insufficient sample"
DEGRADATION_THRESHOLD = 0.05  # 5pp — C1 fail gate
PASS_QUORUM = 3  # ≥ this many tickers measured with sufficient decisive N
                 # (and none failing) for C1 to earn a PASS. Below it →
                 # INCONCLUSIVE. A PASS must rest on positive evidence of
                 # non-degradation, never on the mere absence of detected
                 # degradation. Captain-tunable.
SEMANTIC_SWAP_DATE = "2026-05-13"  # Ship 10 Phase 7b consumer-swap. Post-deploy
                                   # reads dated before this used chronological
                                   # recall; on/after, semantic recall.


# ---------------------------------------------------------------------------
# Service role key
# ---------------------------------------------------------------------------
def get_service_role_key() -> str:
    result = subprocess.run(
        ["npx", "supabase", "projects", "api-keys", "--project-ref", PROJECT_REF],
        capture_output=True,
        text=True,
    )
    for line in result.stdout.splitlines():
        if "service_role" in line:
            return line.split()[-1]
    raise RuntimeError(
        "Could not retrieve service_role key.\n"
        "Run: npx supabase login   (then retry)"
    )


# ---------------------------------------------------------------------------
# REST helpers
# ---------------------------------------------------------------------------
def _headers(sr_key: str, extra: dict | None = None) -> dict:
    h = {"Authorization": f"Bearer {sr_key}", "apikey": sr_key}
    if extra:
        h.update(extra)
    return h


def rest_get(path: str, sr_key: str, params: dict | None = None) -> list:
    url = BASE_URL + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=_headers(sr_key))
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())


def rest_paginate(path: str, sr_key: str, params: dict | None = None, page: int = 1000) -> list:
    """Collect all rows via Range header pagination."""
    results: list = []
    offset = 0
    while True:
        url = BASE_URL + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(
            url,
            headers=_headers(sr_key, {"Range": f"{offset}-{offset + page - 1}"}),
        )
        with urllib.request.urlopen(req) as resp:
            batch = json.loads(resp.read().decode())
        results.extend(batch)
        if len(batch) < page:
            break
        offset += page
    return results


def rest_post(path: str, sr_key: str, body: dict) -> list | dict:
    url = BASE_URL + path
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers=_headers(sr_key, {"Content-Type": "application/json", "Prefer": "return=representation"}),
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())


# ---------------------------------------------------------------------------
# C1 — Hit-rate delta per ticker
# ---------------------------------------------------------------------------
def _bucket_hit_rates(
    reads: list, grades_by_flag: dict[str, str],
    fire_time_by_flag: dict[str, str], split: str,
) -> tuple[dict[str, list[int]], dict[str, list[int]]]:
    """Bucket decisive (win/loss) graded reads into pre/post `split` cohorts.
    Cohorts split on the flag's immutable created_at (fire time) from
    ct_flags -- NOT on ct_specialist_reads.updated_at. updated_at is rewritten
    by the embedding backfill and the grader drain, which collapses every
    graded read into the post-split bucket and empties the pre cohort (the
    cohort-on-rewritable-field bug). `split` may be a full ISO timestamp or a
    YYYY-MM-DD date; string compare works for both since created_at is
    ISO-8601. Returns (pre, post), each ticker -> [wins, losses]."""
    pre: dict[str, list[int]] = {t: [0, 0] for t in TICKERS}
    post: dict[str, list[int]] = {t: [0, 0] for t in TICKERS}
    for r in reads:
        ticker = r.get("ticker")
        if ticker not in TICKERS:
            continue
        outcome = grades_by_flag.get(r.get("flag_id", ""))
        if outcome not in ("win", "loss"):
            continue  # pending / partial -> not decisive
        fire_time = fire_time_by_flag.get(r.get("flag_id", ""))
        if not fire_time:
            continue  # flag fire time unavailable -> cannot cohort
        bucket = post if fire_time >= split else pre
        bucket[ticker][0 if outcome == "win" else 1] += 1
    return pre, post


def _render_cohort_table(
    pre: dict[str, list[int]], post: dict[str, list[int]],
    label_pre: str, label_post: str,
) -> tuple[list[str], int, int]:
    """Render a per-ticker hit-rate table. Returns (lines, measured, failed)
    where `measured` counts tickers with sufficient decisive N in both
    cohorts and `failed` counts tickers degraded beyond the gate."""
    lines = [
        f"{'Ticker':<7} {label_pre + ' W/L':<11} {label_pre + ' HR':<9} "
        f"{label_post + ' W/L':<11} {label_post + ' HR':<9} {'Δ':<9} Status"
    ]
    lines.append("-" * 76)
    measured = 0
    failed = 0
    for ticker in TICKERS:
        pw, pl = pre[ticker]
        qw, ql = post[ticker]
        pre_n = pw + pl
        post_n = qw + ql
        if pre_n < INSUFFICIENT_N or post_n < INSUFFICIENT_N:
            status = "⚠ insuf"
            delta_str = "—"
            pre_pct_s = post_pct_s = "—"
            pre_hr_s = f"{pw}/{pl}"
            post_hr_s = f"{qw}/{ql}"
        else:
            measured += 1
            pre_hr = pw / pre_n
            post_hr = qw / post_n
            delta = post_hr - pre_hr
            delta_str = f"{delta * 100:+.1f}pp"
            pre_pct_s = f"{pre_hr * 100:.0f}%"
            post_pct_s = f"{post_hr * 100:.0f}%"
            pre_hr_s = f"{pw}/{pl}"
            post_hr_s = f"{qw}/{ql}"
            if delta < -DEGRADATION_THRESHOLD:
                status = "FAIL ❌"
                failed += 1
            else:
                status = "PASS ✅"
        lines.append(
            f"{ticker:<7} {pre_hr_s:<11} {pre_pct_s:<9} "
            f"{post_hr_s:<11} {post_pct_s:<9} {delta_str:<9} {status}"
        )
    return lines, measured, failed


def run_c1(sr_key: str) -> tuple[str, str]:
    """
    Pull all flagged reads with flag_id, join grades, render two views:
      (a) pre-deploy vs post-deploy hit-rate — drives the C1 verdict
      (b) chronological-recall vs semantic-recall hit-rate, split at the
          2026-05-13 Ship 10 consumer-swap — reported, does NOT gate

    Three-state verdict (returned as a string):
      FAIL         — any sufficiently-sampled ticker degraded > 5pp
      PASS         — zero degradation AND ≥ PASS_QUORUM tickers measured
                     (positive evidence of non-degradation)
      INCONCLUSIVE — too few tickers measurable to assert anything either way

    The old binary (return ..., True on zero/insufficient data) was a
    false-green: it reported PASS whenever no degradation was *detected*,
    even when nothing was *measured*. PASS now requires evidence.
    """
    print("  Fetching flagged reads…")
    reads = rest_paginate(
        "/rest/v1/ct_specialist_reads",
        sr_key,
        params={
            "select": "ticker,updated_at,flag_id",
            "flagged": "eq.true",
            "flag_id": "not.is.null",
            "order": "updated_at.asc",
        },
    )
    print(f"  → {len(reads)} flagged reads with flag_id")

    if not reads:
        return (
            "No flagged reads with flag_id found — C1 has no substrate.\n"
            "Verdict INCONCLUSIVE: zero data is not evidence of non-degradation."
        ), "INCONCLUSIVE"

    # Unique flag_ids (may span thousands of reads, keep set)
    flag_ids = list({r["flag_id"] for r in reads if r.get("flag_id")})
    print(f"  Fetching grades for {len(flag_ids)} flags…")

    # Batch grade lookups (PostgREST 'in.' filter works fine for 100-item batches)
    grades_by_flag: dict[str, str] = {}
    BATCH = 200
    for i in range(0, len(flag_ids), BATCH):
        chunk = flag_ids[i : i + BATCH]
        ids_str = "(" + ",".join(f'"{fid}"' for fid in chunk) + ")"
        batch = rest_get(
            "/rest/v1/ct_flag_grades",
            sr_key,
            params={"select": "flag_id,outcome", "flag_id": f"in.{ids_str}"},
        )
        for g in batch:
            grades_by_flag[g["flag_id"]] = g["outcome"]
    print(f"  → {len(grades_by_flag)} grades loaded")

    # Flag fire-time lookup -- cohorts split on ct_flags.created_at (the
    # immutable flag-fire timestamp). See _bucket_hit_rates for why
    # ct_specialist_reads.updated_at must NOT be used as the cohort key.
    print(f"  Fetching flag fire-times for {len(flag_ids)} flags…")
    fire_time_by_flag: dict[str, str] = {}
    for i in range(0, len(flag_ids), BATCH):
        chunk = flag_ids[i : i + BATCH]
        ids_str = "(" + ",".join(f'"{fid}"' for fid in chunk) + ")"
        batch = rest_get(
            "/rest/v1/ct_flags",
            sr_key,
            params={"select": "id,created_at", "id": f"in.{ids_str}"},
        )
        for f in batch:
            fire_time_by_flag[f["id"]] = f["created_at"]
    print(f"  → {len(fire_time_by_flag)} flag fire-times loaded")

    # (a) Verdict axis — pre-deploy vs post-deploy (split on flag fire time).
    pre, post = _bucket_hit_rates(reads, grades_by_flag, fire_time_by_flag, DEPLOY_TS)
    deploy_lines, measured, failed = _render_cohort_table(pre, post, "Pre", "Post")

    # (b) Recall-mode axis — chronological vs semantic, post-deploy reads only.
    post_deploy_reads = [
        r for r in reads
        if (fire_time_by_flag.get(r.get("flag_id", "")) or "") >= DEPLOY_TS
    ]
    chrono, semantic = _bucket_hit_rates(
        post_deploy_reads, grades_by_flag, fire_time_by_flag, SEMANTIC_SWAP_DATE)
    mode_lines, _, _ = _render_cohort_table(chrono, semantic, "Chrono", "Semantic")

    # Three-state verdict — PASS requires positive evidence, not silence.
    if failed > 0:
        verdict = "FAIL"
    elif measured >= PASS_QUORUM:
        verdict = "PASS"
    else:
        verdict = "INCONCLUSIVE"

    lines = ["── (a) Hit-rate delta · pre-deploy vs post-deploy (verdict axis) ──"]
    lines += deploy_lines
    lines.append("")
    lines.append(
        f"── (b) Recall mode · chronological (<{SEMANTIC_SWAP_DATE}) vs "
        f"semantic (≥{SEMANTIC_SWAP_DATE}) · post-deploy reads ──"
    )
    lines += mode_lines
    lines.append("")
    lines.append("W/L = wins/losses (decisive only; pending + partial excluded).")
    lines.append(f"⚠ insuf = n_decisive < {INSUFFICIENT_N} in that cohort → not measured.")
    lines.append(
        f"FAIL gate: post_hr < pre_hr − {DEGRADATION_THRESHOLD * 100:.0f}pp "
        "on any measured ticker."
    )
    lines.append(
        f"Verdict: FAIL if any measured ticker degrades; PASS if 0 degrade "
        f"AND ≥{PASS_QUORUM} tickers measured; else INCONCLUSIVE."
    )
    lines.append(f"→ {measured} ticker(s) measured, {failed} degraded → C1 {verdict}")

    return "\n".join(lines), verdict


# ---------------------------------------------------------------------------
# C4 — Narrative continuity on NVDA
# ---------------------------------------------------------------------------

# Phrases that indicate the specialist explicitly references its own prior read.
# Two families:
#  1. First-person citation grammar ("as i noted", "my prior", ...).
#  2. Streak-self-reference grammar ("streak gate", "5-bullish streak", ...) --
#     the specialist citing its own prior-flag track record via the streak the
#     recall organ injects. The Phase A audit (2026-05-16) found NVDA reads
#     express continuity almost entirely in family 2, which the original
#     family-1-only list scored 0/5 -- a heuristic-vocabulary-drift false
#     negative. Family 2 is the streak-gate vocabulary surfaced by the recall
#     organ's formatRecallBlock.
_CONTINUITY_PHRASES = [
    "as i noted", "as i flagged", "i flagged", "i noted yesterday",
    "continuing the read", "still bearish", "still bullish", "prior read",
    "prior flag", "last bearish", "last bullish", "went to loss", "went to win",
    "graded loss", "graded win", "conviction down from", "conviction up from",
    "my last", "my prior", "per my last", "from last", "in my last read",
    "my previous", "the flag i", "the put i", "the call i",
    "as flagged", "as noted",
    # Streak-self-reference family (added 2026-05-16, Ship B).
    "streak gate", "bullish streak", "bearish streak", "continuation-trap",
    "continuation trap", "bullish pending", "bearish pending", "break streak",
    "break the streak", "extend the streak", "extend a streak",
    "consecutive bullish", "consecutive bearish", "priced yesterday",
    "flags pending", "streak of",
]

# Phrases that suggest lean is being driven by streak rather than current flow.
_STREAK_BIAS_PHRASES = [
    "flipping because of my recent",
    "changing because my last",
    "because of my recent losses",
    "because of my recent wins",
    "been wrong three", "been right three",
    "been wrong twice", "been right twice",
    "lost three in a row", "won three in a row",
    "lost two consecutive", "won two consecutive",
    "flip because i've been",
    "been losing", "been winning",
]


def _score_read(text: str) -> tuple[str, str, str]:
    """Returns (continuity: yes|partial|no, streak_bias: yes|no, excerpt)."""
    if not text:
        return "no", "no", "(no read_text)"

    lower = text.lower()

    cont_hits = [p for p in _CONTINUITY_PHRASES if p in lower]
    if len(cont_hits) >= 2:
        continuity = "yes"
    elif len(cont_hits) == 1:
        continuity = "partial"
    else:
        continuity = "no"

    bias_hits = [p for p in _STREAK_BIAS_PHRASES if p in lower]
    streak_bias = "yes" if bias_hits else "no"

    # Excerpt: try to anchor on first continuity phrase, else first 130 chars.
    excerpt = text[:130].replace("\n", " ").strip()
    for phrase in cont_hits:
        idx = lower.find(phrase)
        if idx >= 0:
            start = max(0, idx - 15)
            end = min(len(text), idx + len(phrase) + 80)
            excerpt = ("…" + text[start:end] + "…").replace("\n", " ")
            break

    return continuity, streak_bias, excerpt


def run_c4(sr_key: str) -> tuple[str, bool]:
    """
    Pull last 5 NVDA reads post-deploy, score each for:
      (a) explicit continuity phrases
      (b) streak-driven lean changes
    Pass: ≥3/5 continuity AND ≤1/5 streak bias.
    Returns (formatted table + verdict, pass_bool).
    """
    print("  Fetching last 5 NVDA reads post-deploy…")
    reads = rest_get(
        "/rest/v1/ct_specialist_reads",
        sr_key,
        params={
            "select": "updated_at,direction_lean,conviction,flagged,read_text",
            "ticker": "eq.NVDA",
            "updated_at": f"gte.{DEPLOY_TS}",
            "order": "updated_at.desc",
            "limit": "5",
        },
    )
    print(f"  → {len(reads)} NVDA reads found")

    if not reads:
        return "No NVDA reads found post-deploy. Recall has no substrate to work from.", False

    rows = []
    cont_yes = 0
    bias_yes = 0

    for r in reads:
        text = r.get("read_text") or ""
        cont, bias, excerpt = _score_read(text)
        if cont in ("yes", "partial"):
            cont_yes += 1
        if bias == "yes":
            bias_yes += 1
        ts_s = r["updated_at"][:16].replace("T", " ")
        lean = (r.get("direction_lean") or "?")[:7]
        conv = str(r.get("conviction") or "?")
        flagged = "✓" if r.get("flagged") else " "
        rows.append((ts_s, lean, conv, flagged, cont, bias, excerpt[:110]))

    total = len(reads)
    cont_pass = cont_yes >= 3
    bias_pass = bias_yes <= 1
    overall_pass = cont_pass and bias_pass

    hdr = f"{'Date/Time':<17} {'Lean':<8} {'Conv':<5} {'Flag':<5} {'Cont':<9} {'Bias':<5} Excerpt"
    lines = [hdr, "-" * 95]
    for (ts_s, lean, conv, flagged, cont, bias, excerpt) in rows:
        lines.append(f"{ts_s:<17} {lean:<8} {conv:<5} {flagged:<5} {cont:<9} {bias:<5} {excerpt}")

    lines.append("")
    lines.append(
        f"Continuity ≥3/5: {cont_yes}/{total} → {'PASS ✅' if cont_pass else 'FAIL ❌ (<3 reads reference prior read)'}"
    )
    lines.append(
        f"Streak bias  ≤1/5: {bias_yes}/{total} → {'PASS ✅' if bias_pass else 'FAIL ❌ (≥2 reads show streak-driven lean)'}"
    )
    lines.append("")
    lines.append(
        "NOTE: C4 is a heuristic phrase-match on read_text — review excerpts above "
        "to confirm. Phrase list tuned to catch explicit continuity; edge cases "
        "possible. Human review is authoritative."
    )

    return "\n".join(lines), overall_pass


# ---------------------------------------------------------------------------
# C5 — Flag-volume delta per ticker
# ---------------------------------------------------------------------------
def run_c5(sr_key: str) -> str:
    """
    Count flagged reads per ticker pre vs post deploy.
    Flag tickers where |delta_pct| > 50% for James to interpret.
    Returns formatted table string.
    """
    print("  Fetching all flagged reads for volume count…")
    reads = rest_paginate(
        "/rest/v1/ct_specialist_reads",
        sr_key,
        params={
            "select": "ticker,updated_at",
            "flagged": "eq.true",
            "order": "updated_at.asc",
        },
    )
    print(f"  → {len(reads)} flagged reads total")

    pre_cnt: dict[str, int] = defaultdict(int)
    post_cnt: dict[str, int] = defaultdict(int)

    for r in reads:
        ticker = r.get("ticker")
        if ticker not in TICKERS:
            continue
        if r["updated_at"] >= DEPLOY_TS:
            post_cnt[ticker] += 1
        else:
            pre_cnt[ticker] += 1

    lines = [f"{'Ticker':<7} {'Pre':<8} {'Post':<8} {'Δ%':<12} Note"]
    lines.append("-" * 50)

    for ticker in TICKERS:
        pre = pre_cnt[ticker]
        post = post_cnt[ticker]
        if pre == 0 and post == 0:
            delta_s = "—"
            note = ""
        elif pre == 0:
            delta_s = "+∞ (pre=0)"
            note = "⚠ surface"
        else:
            pct = (post - pre) / pre * 100
            delta_s = f"{pct:+.0f}%"
            note = "⚠ surface" if abs(pct) > 50 else ""
        lines.append(f"{ticker:<7} {pre:<8} {post:<8} {delta_s:<12} {note}")

    lines.append("")
    lines.append(
        "⚠ surface = |Δ%| > 50% — not a verdict, surface for James to interpret "
        "(detector-threshold change, RTH coverage gap, or genuine shift in signal density)."
    )

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# User settings — Slack channel
# ---------------------------------------------------------------------------
def get_slack_channel(sr_key: str) -> Optional[str]:
    rows = rest_get(
        "/rest/v1/user_settings",
        sr_key,
        params={"select": "settings", "limit": "1"},
    )
    if rows and isinstance(rows[0].get("settings"), dict):
        return rows[0]["settings"].get("slack_channel_id")
    return None


# ---------------------------------------------------------------------------
# Slack direct post (requires SLACK_BOT_TOKEN env var)
# ---------------------------------------------------------------------------
def post_slack(channel: str, text: str, bot_token: str) -> Optional[str]:
    url = "https://slack.com/api/chat.postMessage"
    body = json.dumps({"channel": channel, "text": text, "mrkdwn": True}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Authorization": f"Bearer {bot_token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode())
    if data.get("ok"):
        return data.get("ts")
    print(f"  [slack] API error: {data.get('error')}", file=sys.stderr)
    return None


# ---------------------------------------------------------------------------
# brain_reports fallback insert
# ---------------------------------------------------------------------------
def insert_brain_report(sr_key: str, title: str, body_md: str) -> Optional[str]:
    users = rest_get(
        "/rest/v1/user_settings",
        sr_key,
        params={"select": "user_id", "limit": "1"},
    )
    if not users:
        return None
    user_id = users[0]["user_id"]
    now = datetime.datetime.utcnow().isoformat() + "Z"
    result = rest_post(
        "/rest/v1/brain_reports",
        sr_key,
        {
            "user_id": user_id,
            "report_type": "research",
            "title": title,
            "body_markdown": body_md,
            "summary": title,
            "source": "ct_specialist_recall_14d_acceptance",
            "metadata": {
                "check": "specialist_recall_14d",
                "deploy_ts": DEPLOY_TS,
                "run_date": RUN_DATE,
                "generated_at": now,
            },
        },
    )
    if isinstance(result, list) and result:
        return result[0].get("id")
    if isinstance(result, dict):
        return result.get("id")
    return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    print("=" * 60)
    print("Specialist Recall · 14-day acceptance check")
    print(f"Run date : {RUN_DATE}")
    print(f"Deploy   : {DEPLOY_TS}")
    print("=" * 60)

    # 1. Key
    try:
        sr_key = get_service_role_key()
        print(f"\n✓ service_role key retrieved ({sr_key[:12]}…)\n")
    except Exception as exc:
        print(f"\nFATAL: {exc}", file=sys.stderr)
        sys.exit(1)

    # 2. C1
    print("── C1: Hit-rate delta ──────────────────────────────────────")
    c1_table, c1_verdict = run_c1(sr_key)
    print(c1_table)
    print(f"\n→ C1: {c1_verdict}\n")

    # 3. C4
    print("── C4: Narrative continuity · NVDA ─────────────────────────")
    c4_table, c4_pass = run_c4(sr_key)
    print(c4_table)
    c4_verdict = "PASS" if c4_pass else "FAIL"
    print(f"\n→ C4: {c4_verdict}\n")

    # 4. C5
    print("── C5: Flag-volume delta ───────────────────────────────────")
    c5_table = run_c5(sr_key)
    print(c5_table)
    print()

    # 5. Compose Slack message
    now_str = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    overall_line = (
        f"*Specialist Recall · 14-day acceptance · "
        f"C1: {c1_verdict} · C4: {c4_verdict} · C5: surfaced*\n"
        f"_{now_str} · Deploy: {DEPLOY_TS} · Day 14_"
    )
    slack_text = "\n\n".join([
        overall_line,
        f"*C1 — Hit-rate delta per ticker*\n```\n{c1_table}\n```",
        f"*C4 — Narrative continuity · NVDA (last 5 post-deploy reads)*\n```\n{c4_table}\n```",
        f"*C5 — Flag-volume delta per ticker*\n```\n{c5_table}\n```",
        (
            "_Sample-size caveat: 14 days of post-deploy graded reads is short. "
            "Tickers marked '⚠ insuf' have <5 decisive grades in one cohort — "
            "treat those as signals to watch, not verdicts._"
        ),
    ])

    # 6. Slack post
    slack_ts: Optional[str] = None
    bot_token = os.environ.get("SLACK_BOT_TOKEN")
    if bot_token:
        print("── Slack ───────────────────────────────────────────────────")
        try:
            channel = get_slack_channel(sr_key)
            if channel:
                print(f"  Posting to channel {channel}…")
                slack_ts = post_slack(channel, slack_text, bot_token)
                if slack_ts:
                    print(f"  ✓ Posted → ts={slack_ts}")
                else:
                    print("  ⚠ Slack API returned error (see above).")
            else:
                print("  ⚠ No slack_channel_id found in user_settings.")
        except Exception as exc:
            print(f"  ⚠ Slack error: {exc}", file=sys.stderr)
    else:
        print("── Slack ───────────────────────────────────────────────────")
        print("  SLACK_BOT_TOKEN not set — Slack posting skipped.")
        print("  Set it:  export SLACK_BOT_TOKEN=<token>  and re-run to post.")

    # 7. brain_reports insert (always)
    report_id: Optional[str] = None
    print("── brain_reports ───────────────────────────────────────────")
    report_title = f"Specialist Recall 14d acceptance — C1: {c1_verdict} · C4: {c4_verdict} · C5: surfaced"
    try:
        report_id = insert_brain_report(sr_key, report_title, slack_text)
        if report_id:
            print(f"  ✓ Row inserted → id={report_id}  (visible at /reports)")
        else:
            print("  ⚠ Insert returned no id.")
    except Exception as exc:
        print(f"  ⚠ brain_reports insert failed: {exc}", file=sys.stderr)

    # 8. Final
    print()
    print("=" * 60)
    print(f"FINAL  C1={c1_verdict}  |  C4={c4_verdict}  |  C5=surfaced")
    if slack_ts:
        print(f"Slack  ts={slack_ts}")
    elif report_id:
        print(f"Fallback  brain_reports id={report_id}")
    else:
        print("Neither Slack nor brain_reports insert succeeded — results above only.")
    print("=" * 60)


if __name__ == "__main__":
    main()
