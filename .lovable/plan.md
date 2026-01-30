

# LinkJac: State of the App Review & Roadmap to Greatness

## Current State Assessment

After reviewing your codebase, I'm impressed by how much you've built! The app has a solid foundation with many features already in place. Here's my analysis:

---

## What's New & Working Well

### Core Features (Solid)
| Feature | Status | Notes |
|---------|--------|-------|
| **DumpInput** | Working | Modular, clean architecture with voice input, file upload, drag-drop |
| **AI Classification** | Working | Titles, tags, types, importance scores auto-generated |
| **Dashboard Sections** | Working | Today, Important, Lists, Code, Ideas - all auto-organized |
| **Entry Management** | Working | Star, archive, delete, bulk selection |
| **Calendar View** | New & Working | Quick add events, coming up preview, date/time editing |
| **Timeline View** | Working | Chronological grouping (Today, Yesterday, etc.) |
| **Knowledge Graph** | Working | 3D interactive visualization with Three.js |
| **Reminder Banner** | New & Working | Shows overdue + today's items |
| **Jac Assistant** | Working | Voice I/O, streaming, source citations, image gallery |
| **Jac Dashboard Query** | New | Pattern detection and visual transformations |
| **Tag Filter** | Improved | Now wraps with "Show more" toggle |
| **PWA/Offline** | Working | Service worker, offline banner, queue sync |
| **Data Export** | Working | JSON, CSV, Markdown options |
| **Subscription System** | Working | Free tier limits, Pro upgrade flow |

### Database Schema (Complete)
All necessary columns exist:
- Core: `id`, `user_id`, `content`, `title`, `content_type`, `tags`, `importance_score`
- Lists: `list_items` (JSONB)
- Media: `image_url`
- Calendar: `event_date`, `event_time`, `is_recurring`, `recurrence_pattern`, `reminder_minutes`
- Search: `embedding` (vector)

---

## Issues Found & Fixes Needed

### 1. Network Error: `assistant-chat` OPTIONS Failing
```
Request: OPTIONS /functions/v1/assistant-chat
Error: Failed to fetch
```
**Impact:** Jac assistant may fail intermittently
**Fix:** Check CORS headers in `assistant-chat/index.ts` - ensure preflight requests return proper headers

### 2. Jac Dashboard Query Edge Function
The function exists but was just deployed. Need to verify it's working end-to-end when clicking suggestions.

### 3. Missing Integration: Entry Schedule Persistence
The `EntryView.tsx` schedule section saves to DB, but the realtime subscription doesn't broadcast these updates to other open tabs.

### 4. Calendar Header Icons Duplicated
The mobile menu shows two Calendar icons (one for Timeline, one for Calendar) which can confuse users.

### 5. Subscription "Manage Subscription" Button
Currently non-functional placeholder for Pro users.

---

## Roadmap to Greatness

### Phase 1: Stability & Polish (Week 1-2)

**Priority: Fix What's Broken**

| Task | Effort | Impact |
|------|--------|--------|
| Fix CORS on `assistant-chat` edge function | Low | High |
| Test Jac dashboard suggestions end-to-end | Low | Medium |
| Add loading states for all async operations | Low | Medium |
| Differentiate Timeline vs Calendar icons | Low | Low |
| Connect "Manage Subscription" to Stripe portal | Medium | Low |

### Phase 2: Core Experience Enhancement (Week 3-4)

**Priority: Make Dumping Magical**

| Feature | Description | Effort |
|---------|-------------|--------|
| **Smarter Titles** | Already improved! Verify AI generates specific titles | Low |
| **Auto-Suggested Tags** | Show 2-3 tag suggestions based on content before saving | Medium |
| **Quick Actions on Dump** | After dumping, show "Add to calendar?" for time-sensitive content | Medium |
| **Entry Enrichment** | "Enrich" button fetches context (code docs, link previews) | Medium |
| **Undo Toast** | "Entry saved. Undo?" with 5-second window | Low |

### Phase 3: Calendar & Reminders (Week 5-6)

**Priority: Make Calendar a Destination**

| Feature | Description | Effort |
|---------|-------------|--------|
| **Email Reminders** | Morning digest of today's events via Resend | High |
| **Recurring Events Display** | Show recurring markers on calendar | Medium |
| **Week View** | Dense week view for busy users | Medium |
| **Drag-to-Reschedule** | Drag entries between dates on calendar | High |
| **Color-Coded Dots** | Different colors for reminders vs events | Low |

### Phase 4: Jac Intelligence (Week 7-8)

**Priority: Make Jac Indispensable**

| Feature | Description | Effort |
|---------|-------------|--------|
| **Proactive Insights** | Jac surfaces forgotten items ("You haven't touched X in 2 weeks") | High |
| **Weekly Brain Report** | Auto-generated summary of activity | Medium |
| **Quick Commands** | "/remind me tomorrow" "/add to groceries" parsing | Medium |
| **Cross-Entry Connections** | "This relates to X from last week" auto-linking | High |
| **Jac Onboarding** | Interactive tour showing Jac's capabilities | Medium |

### Phase 5: Power User Features (Week 9-10)

**Priority: Depth for Heavy Users**

| Feature | Description | Effort |
|---------|-------------|--------|
| **Keyboard Shortcuts Panel** | Show all shortcuts with `?` key | Low |
| **Quick Capture Widget** | Global keyboard shortcut to dump from anywhere (desktop PWA) | Medium |
| **Saved Searches** | Pin frequent searches like "all code tagged python" | Medium |
| **Custom Tags & Colors** | User-defined tag colors | Low |
| **Archived View** | See and restore archived entries | Low |

### Phase 6: Social & Sharing (Week 11-12)

**Priority: Growth & Virality**

| Feature | Description | Effort |
|---------|-------------|--------|
| **Share Entry as Public Link** | Generate shareable read-only link | Medium |
| **Import from Notes Apps** | Import from Apple Notes, Google Keep | High |
| **Browser Extension** | Quick dump from any webpage | High |
| **Mobile App (Capacitor)** | Native iOS/Android for quick capture | High |

---

## Technical Debt to Address

| Issue | Priority | Notes |
|-------|----------|-------|
| Add error boundaries to lazy-loaded components | Medium | Prevent blank screens on chunk errors |
| Add more unit tests (currently only hooks tested) | Medium | Target >70% coverage |
| Optimize Knowledge Graph performance | Low | Runs smoothly now but could lag with 500+ entries |
| Rate limit edge functions properly | Medium | Already have `rateLimit.ts` - ensure all functions use it |
| Add Sentry integration | Low | Already installed, verify it's capturing errors |

---

## Quick Wins (Can Do Today)

1. **Differentiate Timeline/Calendar icons** - Use `Clock` for Timeline, `CalendarDays` for Calendar
2. **Add "Archive" to entry view** - Already exists but verify it works from all entry points
3. **Show keyboard shortcuts hint** - Add `?` key to show shortcuts modal
4. **Add loading skeleton to Jac** - Show skeleton while Jac thinks
5. **Fix dual Calendar icon** - Use different icons in mobile menu

---

## Metrics to Track

| Metric | Target | Why |
|--------|--------|-----|
| Dump completion time | <2 seconds | Core value prop |
| Daily active dumps per user | 5+ | Engagement |
| Jac usage rate | 30%+ of sessions | AI value |
| Calendar usage | 20%+ of users | Feature adoption |
| Export rate | <5% | If high, users are leaving |

---

## Summary

**You've built a lot!** The core brain dump experience is solid. The AI classification works, Jac is useful, the calendar is functional. The main gaps are:

1. **Polish** - Some rough edges on edge functions and loading states
2. **Reminders** - Email/push notifications would complete the calendar
3. **Jac Proactivity** - Make Jac surface insights without being asked
4. **Mobile Capture** - Quick capture from phone is the killer feature

The foundation is strong. Now it's about making the existing features feel magical and adding the "can't live without it" moments.

