

# Lock Down LinkJac — Single User Mode

## Overview
Strip the app to single-user mode. Only you (jayhillendalepress@gmail.com) can sign in via Google OAuth. No signup, no marketing pages, no public access. Edge functions and agents keep running 24/7 regardless.

## Step 1: Database Trigger — Block Non-Owner Signups
Modify the existing `handle_new_user()` function to reject any signup where the email is not `jayhillendalepress@gmail.com`. This is the safety net — even if someone reaches the Google OAuth flow, they can't create a profile.

```sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.email != 'jayhillendalepress@gmail.com' THEN
    RAISE EXCEPTION 'Signup is not allowed for this application';
  END IF;

  INSERT INTO public.profiles (id, username)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'username', split_part(NEW.email, '@', 1))
  );
  RETURN NEW;
END;
$$;
```

## Step 2: Simplify Auth Page (`src/pages/Auth.tsx`)
Replace the entire auth page with a minimal version:
- LinkJac logo + "Your AI-powered second brain" tagline
- Single "Sign in with Google" button
- "Back to home" link
- Remove: signup form, email/password, forgot password, reset password, terms/privacy links

## Step 3: Update Routing (`src/App.tsx`)
- Replace Landing page on `/` with an `AuthRedirect` component:
  - Logged in -> redirect to `/dashboard`
  - Not logged in -> redirect to `/auth`
- Remove `/pricing` route
- Keep `/terms` and `/privacy` routes

## Step 4: Disable Email Signups
- Use auth configuration to disable email signup method
- Google OAuth stays enabled (but only your profile works due to the trigger)

## What Stays the Same
- All edge functions and agents (run on Lovable Cloud servers, independent of browser)
- Dashboard, dump input, assistant chat, settings
- All RLS policies (already per-user)
- Terms and Privacy pages

## Result
- Visit site -> Google sign-in screen
- Sign in as you -> dashboard
- Anyone else -> blocked at profile creation
- Agents keep running 24/7

