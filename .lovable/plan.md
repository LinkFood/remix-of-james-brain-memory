

# Calendar Reminders: Migration + Deploy

## What's already done
All 7 files from commit 6df52c4 are in the codebase and look correct. No code changes needed for the edge functions themselves.

## What needs to happen

### 1. Add `reminder_sent` column (database migration)
The column doesn't exist yet. Run a migration to add it along with the partial index.

```sql
ALTER TABLE public.entries
ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_entries_pending_reminders
ON public.entries(event_date, reminder_minutes)
WHERE event_date IS NOT NULL
  AND reminder_minutes IS NOT NULL
  AND reminder_sent = false;
```

### 2. Enable pg_cron and pg_net extensions
These are required for the scheduled reminder checks. Enable them via migration:

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
```

### 3. Fix and create cron jobs
The current migration uses `current_setting('app.settings.supabase_url')` which won't work in Lovable Cloud. The cron jobs need hardcoded values with the actual project URL and anon key (not service role key, since the edge function validates service role auth internally -- we'll use the service role approach via `net.http_post`).

Three cron jobs:
- **reminder-morning**: 8:00 AM UTC daily -- full check
- **reminder-evening**: 6:00 PM UTC daily -- full check  
- **reminder-timed**: every 15 minutes -- only time-specific events

### 4. Register `calendar-reminder-check` in config.toml
Add `verify_jwt = false` since this function uses service-role auth validation internally.

### 5. Deploy edge functions
Deploy all 6 modified/new functions:
- `jac-dispatcher`
- `jac-research-agent`
- `classify-content`
- `smart-save`
- `calendar-reminder-check`
- `_shared/slack.ts` (deployed as part of functions that import it)

### 6. Update the migration file
Replace the broken `current_setting()` calls with actual project URL and service role key references. Since the cron SQL contains secrets, it will be run via the SQL insert tool (not the migration file) to avoid committing secrets to git.

## Order of operations
1. Run migration: add column + index + enable extensions
2. Run cron job SQL (separate, uses actual URLs/keys)
3. Update config.toml with calendar-reminder-check entry
4. Deploy all 5 edge functions

## Risk notes
- pg_cron may not be available on all Supabase tiers -- if enabling fails, reminders will need an external scheduler as fallback
- The `SLACK_BOT_TOKEN` secret is already configured (verified)
