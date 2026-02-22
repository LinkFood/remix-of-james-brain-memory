

# Fix: Insert Missing Profile Row

## Problem
The Slack signing secret is now correct and signature verification passes. The actual error is:

**"No user profile found"** — Your auth user exists but has no row in the `profiles` table. The `handle_new_user` trigger was added after your account was created, so a profile was never auto-generated.

## Solution
Run a single database migration to insert the missing profile row:

```sql
INSERT INTO public.profiles (id, username)
VALUES ('ea684316-73d7-4869-bc16-957558a9e9be', 'jayhillendalepress')
ON CONFLICT (id) DO NOTHING;
```

This will also trigger the `on_profile_created_create_subscription` trigger, creating a subscription row automatically.

## What happens after
1. You send a DM to LinkJac in Slack
2. `slack-incoming` receives it, verifies signature (already working), finds your profile
3. Dispatches to `jac-dispatcher` with your userId
4. JAC processes the message and responds in the Slack thread

## Technical Details
- File changed: New migration SQL only (no code changes)
- The `handle_new_user` trigger exists for future signups but missed the existing user
- One migration insert fixes the entire pipeline

