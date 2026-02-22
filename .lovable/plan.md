

# Apply Commit d9c92f3 — User Activity Tracking Table

## What's needed

The frontend code for activity tracking is already in place. The only missing piece is the `user_activity` database table that the tracker writes to.

## Database Migration

Create the `user_activity` table with the following schema:

```sql
CREATE TABLE public.user_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  event text NOT NULL,
  category text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  entry_id uuid,
  session_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_activity ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own activity"
  ON public.user_activity FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own activity"
  ON public.user_activity FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_user_activity_user_date ON public.user_activity (user_id, created_at);
CREATE INDEX idx_user_activity_category ON public.user_activity (user_id, category, created_at);

ALTER PUBLICATION supabase_realtime ADD TABLE public.user_activity;
```

## No other changes needed

- `src/hooks/useActivityTracker.ts` -- already present
- `src/components/ActivityTrackingProvider.tsx` -- already present
- `src/App.tsx` -- already wires `ActivityTrackingProvider` around authenticated routes
- No edge function changes required

## Technical Notes

- The `sendBeacon` call in `useActivityTracker.ts` posts directly to the REST API (`/rest/v1/user_activity`). This requires the anon key header, but `sendBeacon` only sends a Blob body without auth headers. This means unload events may silently fail. This is acceptable -- the 2-second batch flush handles the vast majority of events, and losing the final batch on tab close is a known tradeoff.
- The INSERT RLS policy requires `auth.uid() = user_id`, which is correct for client-side inserts.

