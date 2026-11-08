# News feed dry test

A one-week test of a free news feed, run apart from the JAC app. Nothing here touches `src/`, `supabase/`, `docs/`,
crons or the database.

## What runs

- `.github/workflows/newsfeed-test.yml` runs every 5 minutes on GitHub's free runners (this repo is public), plus two
  long runs on weekdays that read through the 8:30am and 10:00am New York release windows.
- `collect.mjs` reads the sources in `lib/sources.mjs` (SEC EDGAR current 8-K and 6-K filings, Federal Reserve press
  releases, BLS release feeds, Treasury press releases, Federal Register public inspection, NPR Business, The
  Conversation business), stamps each new item the moment its response arrives, and merges items that are the same
  story. Its state lives in the Actions cache, never in a commit.
- `scorecard.mjs` answers three questions, each count with its denominator: how many seconds late each source is, which
  sources broke, and (with an optional `moves.json`) which price moves had no headline before them.
- The workflow publishes `latest.json`, `health.json` and `scorecard.json` to the `newsfeed-data` branch. The page at
  `public/newsfeed.html` (https://www.linkjac.cloud/newsfeed.html) reads them from raw.githubusercontent.com, so main
  never gets a data commit and the site never redeploys for data. That branch carries its own `vercel.json` that turns
  Vercel's deploys off for it. **Never merge `newsfeed-data`.**

## Rules it keeps

- Only sources whose own terms allow automated reading (terms noted per source in `lib/sources.mjs`).
- Outlet titles (NPR, The Conversation) are never written to any file or log: this repo and its Actions logs are public.
  The page shows outlet items as source, time and a link.
- SEC and BLS ask every automated reader for a name and contact. Set the optional repository secret `NEWSFEED_CONTACT`
  (for example `Name you@example.com`); without it those sources are skipped and the scorecard says so.
- The collector logs counts only, never a secret.

## Run it by hand

```
node newsfeed/test/test.mjs
node newsfeed/collect.mjs --state /tmp/nf --loop 0
node newsfeed/scorecard.mjs --state /tmp/nf
```

## Stop it

Delete `.github/workflows/newsfeed-test.yml` (or disable the workflow in the Actions tab). Delete the `newsfeed-data`
branch to drop its data.
