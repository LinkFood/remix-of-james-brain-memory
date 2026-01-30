
# Calendar Upgrade Plan

## Current State Analysis

The calendar right now is **view-only** - it just displays entries that happen to have an `event_date`. There's no way to:
- Manually add events directly to the calendar
- Edit dates on existing entries  
- Set up reminders/notifications
- See what's coming up at a glance
- Create recurring events manually

---

## Proposed Calendar Features

### 1. Manual Event Creation from Calendar

**What**: Click any date → quick-add form appears → create event/reminder directly

```
┌─────────────────────────────────────────┐
│ Calendar                                │
├─────────────────────────────────────────┤
│     January 2026                        │
│  S  M  T  W  T  F  S                    │
│        1  2  3  4  5                    │
│  6  7  8  9  10[11]12  ← Click date     │
│ ...                                     │
├─────────────────────────────────────────┤
│ + Add to Jan 11                         │
│ ┌─────────────────────────────────────┐ │
│ │ What's happening?                   │ │
│ └─────────────────────────────────────┘ │
│ Time: [__:__]  Reminder: [▼ None]       │
│                         [Save]          │
└─────────────────────────────────────────┘
```

### 2. Date/Time Editing in EntryView

**What**: When viewing any entry, add ability to set/change its date and time

- Add "Schedule" section to EntryView edit mode
- Date picker + time picker
- Recurring toggle (daily/weekly/monthly)
- This lets any entry become a calendar event

### 3. "What's Ahead" Upcoming Preview

**What**: Quick glance at next 7 days directly in calendar header

```
┌─────────────────────────────────────────┐
│ 📅 Calendar                             │
├─────────────────────────────────────────┤
│ COMING UP                               │
│ ─────────────────────                   │
│ Tomorrow                                │
│  • Team standup @ 10:00                 │
│  • Call mom                             │
│                                         │
│ Fri, Jan 17                             │
│  • Submit expense report ⏰              │
│                                         │
│ This Weekend                            │
│  • Birthday party @ 3pm                 │
└─────────────────────────────────────────┘
```

### 4. Reminder Notifications

**What**: Get notified before events/reminders

**Options** (from simple to complex):

| Approach | Pros | Cons |
|----------|------|------|
| **Email reminders** | Works everywhere, no browser permissions | Requires email integration, not instant |
| **In-app alerts** | Simple, shows when you open app | Only works if app is open |
| **Push notifications** | True reminders, works even when closed | Requires PWA install + permission, complex backend |

**Recommended approach**: Start with **in-app reminders** + **email for important ones**

- When you open the app, show banner: "⏰ 2 things due today"
- Optional email digest: morning summary of today's events

### 5. Improved Calendar UI

**Current issues**:
- Sheet slides in from right (feels disconnected)
- Calendar is tiny
- No month navigation arrows visible
- Can't quickly jump to today

**Improvements**:
- Better month navigation
- "Today" button to jump back
- Color-coded dots (🟢 event, 🔴 reminder, 🔵 deadline)
- Week view option for dense schedules

---

## Technical Implementation

### Phase 1: Core Calendar Editing

**Files to modify:**

| File | Changes |
|------|---------|
| `src/components/CalendarView.tsx` | Add "Quick Add" form when date is selected, improve navigation |
| `src/components/EntryView.tsx` | Add date/time picker section in edit mode |
| `src/components/ui/calendar.tsx` | May need custom day rendering for color dots |

**New component:**
| File | Purpose |
|------|---------|
| `src/components/calendar/QuickAddEvent.tsx` | Form for adding event directly from calendar |

### Phase 2: Coming Up Section

**Files to modify:**

| File | Changes |
|------|---------|
| `src/components/CalendarView.tsx` | Add "Coming Up" section above calendar grid |

### Phase 3: In-App Reminders

**Files to create:**

| File | Purpose |
|------|---------|
| `src/components/ReminderBanner.tsx` | Shows "X things due today" on dashboard |
| `src/hooks/useUpcomingReminders.ts` | Fetches today's/overdue items |

**Database addition:**
| Column | Purpose |
|--------|---------|
| `entries.reminder_time` | When to remind (e.g., "1h before", "morning of") |

### Phase 4: Email Reminders (Future)

Would require:
- Email service integration (Resend, SendGrid)
- Scheduled cron job to check for due reminders
- User email preferences in settings

---

## User Experience After Upgrade

1. **Open Calendar** → See "Coming Up" section with next 7 days preview
2. **Click a date** → Quick-add form appears, type "Doctor appointment 3pm"
3. **View any entry** → Click edit → Set date/time/reminder
4. **Open app in morning** → Banner: "⏰ 3 things today" with expandable list
5. **Recurring events** → Weekly standup automatically shows up each week

---

## Implementation Priority

| Priority | Feature | Effort |
|----------|---------|--------|
| 🔴 High | Manual event creation from calendar | Medium |
| 🔴 High | Date/time editing in EntryView | Low |
| 🟡 Medium | "Coming Up" preview section | Low |
| 🟡 Medium | In-app reminder banner | Medium |
| 🟢 Low | Color-coded calendar dots | Low |
| 🟢 Low | Email reminders | High |
| 🟢 Low | Push notifications | Very High |

---

## Files Summary

**Modify:**
- `src/components/CalendarView.tsx` - Major overhaul
- `src/components/EntryView.tsx` - Add date/time editing
- `src/components/Dashboard.tsx` - Add reminder banner

**Create:**
- `src/components/calendar/QuickAddEvent.tsx` - Calendar event form
- `src/components/calendar/UpcomingPreview.tsx` - Next 7 days view
- `src/components/ReminderBanner.tsx` - Today's reminders alert
- `src/hooks/useUpcomingReminders.ts` - Fetch upcoming entries

**Database (optional for reminders):**
- Add `reminder_minutes` column to entries table (e.g., 60 = remind 1 hour before)
