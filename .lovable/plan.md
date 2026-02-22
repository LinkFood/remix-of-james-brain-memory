

# Lock Down LinkJac — Single User Mode

## Overview
Strip the app down to single-user mode. Only you can sign in (via Google OAuth). No signup, no marketing pages, no public access. Edge functions and agents continue running regardless of publish status.

## Changes

### 1. Simplify Auth Page (`src/pages/Auth.tsx`)
- Remove all signup mode, forgot password, reset password flows
- Remove email/password form entirely
- Show only: Logo, tagline, "Sign in with Google" button, back-to-home link
- Remove terms/privacy links from auth page (keep routes for legal compliance)

### 2. Add Auth Guard + Redirect Logic (`src/App.tsx`)
- Create a small `AuthRedirect` component for the `/` route
- If logged in: redirect to `/dashboard`
- If not logged in: redirect to `/auth`
- Remove `/pricing` route (not needed for single-user)
- Keep `/terms` and `/privacy` routes

### 3. Strip Landing Page Redirect
- Replace `Landing` page import with the `AuthRedirect` component on `/`
- No more marketing landing page — straight to business

### 4. Block New User Profiles at Database Level
- Add a database trigger on `profiles` table insert
- Check if the inserting user's email matches your allowed email
- If not, raise an exception (prevents new users from completing signup)
- This is belt-and-suspenders — even if someone hits the Google OAuth somehow, they can't create a profile

### 5. Disable Signup in Auth Config
- Use the configure-auth tool to disable email signups
- Google OAuth remains enabled but only your profile will work due to the trigger

## What Stays the Same
- All edge functions (they run server-side on Lovable Cloud, independent of frontend publishing)
- Dashboard, settings, all dump/assistant functionality
- RLS policies (already per-user)
- Terms and Privacy pages

## Technical Sequence
1. Database migration: add trigger to block non-allowlisted profiles
2. Simplify Auth.tsx to Google-only sign-in
3. Update App.tsx routing (remove pricing, add auth redirect on `/`)
4. Deploy and test on preview URL

## Result
- Visit site -> Google sign-in screen
- Sign in as you -> dashboard
- Anyone else -> blocked at profile creation
- Agents and edge functions keep running 24/7 regardless of browser state

