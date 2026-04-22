#!/usr/bin/env python3
# /// script
# dependencies = ["yfinance", "requests"]
# ///
"""
Backfill ct_price_bars from yfinance.
1m bars for last 7 days, 5m bars for last 60 days.
Upserts via Supabase REST with merge-duplicates on (ticker, ts, timeframe).
"""
import os, sys, time, subprocess, json
import yfinance as yf
import requests
from datetime import datetime, timezone

TICKERS = ["SPY","QQQ","IWM","AAPL","MSFT","NVDA","META","GOOGL","AMZN","TSLA","GLD","USO"]
PROJECT_REF = "rvhyotvklfowklzjahdd"
SUPABASE_URL = f"https://{PROJECT_REF}.supabase.co"

def get_key():
    out = subprocess.check_output(
        ["npx", "supabase", "projects", "api-keys", "--project-ref", PROJECT_REF],
        text=True
    )
    for line in out.splitlines():
        if "service_role" in line:
            return line.split()[-1]
    raise RuntimeError("no service_role key")

KEY = get_key()
HEADERS = {
    "apikey": KEY,
    "Authorization": f"Bearer {KEY}",
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates,return=minimal",
}

def fetch(ticker, period, interval):
    try:
        df = yf.Ticker(ticker).history(period=period, interval=interval, prepost=False, auto_adjust=False)
        if df is None or df.empty:
            return []
    except Exception as e:
        print(f"  fetch error {ticker} {interval}: {e}", file=sys.stderr)
        return []
    rows = []
    for ts, r in df.iterrows():
        # yfinance returns tz-aware index in US/Eastern for intraday; convert to UTC
        dt = ts.to_pydatetime().astimezone(timezone.utc).isoformat()
        rows.append({
            "ticker": ticker,
            "ts": dt,
            "timeframe": interval,
            "open":  round(float(r["Open"]),  4),
            "high":  round(float(r["High"]),  4),
            "low":   round(float(r["Low"]),   4),
            "close": round(float(r["Close"]), 4),
            "volume": int(r["Volume"]) if r["Volume"] == r["Volume"] else None,
            "source": "yfinance",
        })
    return rows

def upload(rows, chunk=500):
    total = 0
    for i in range(0, len(rows), chunk):
        batch = rows[i:i+chunk]
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/ct_price_bars",
            headers=HEADERS,
            data=json.dumps(batch),
            timeout=60,
        )
        if r.status_code >= 300:
            print(f"  upload error {r.status_code}: {r.text[:300]}", file=sys.stderr)
            return total
        total += len(batch)
    return total

def main():
    t0 = time.time()
    grand = 0
    for tf, period in [("1m", "7d"), ("5m", "60d")]:
        print(f"\n== {tf} bars, period={period} ==")
        for t in TICKERS:
            rows = fetch(t, period, tf)
            if not rows:
                print(f"  {t} {tf}: 0 rows")
                continue
            n = upload(rows)
            grand += n
            first = rows[0]["ts"]; last = rows[-1]["ts"]
            print(f"  {t} {tf}: {n} rows  [{first} .. {last}]")
            time.sleep(0.3)  # polite pause between tickers
    print(f"\nTotal rows uploaded: {grand}  elapsed: {time.time()-t0:.1f}s")

if __name__ == "__main__":
    main()
