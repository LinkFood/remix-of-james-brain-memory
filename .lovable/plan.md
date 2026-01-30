
# Tag Filter & Entry Context Improvements

## Overview
Two-part fix addressing:
1. **Tag overflow** - Tags wrap to multiple lines with a "Show more" toggle
2. **Better entry titles** - AI generates descriptive, context-rich titles instead of generic ones like "Code snippet"

---

## Part 1: Tag Filter - Wrap & Collapse

### Current Problem
Tags flow off-screen horizontally, making the page wider than it should be.

### Solution
Replace horizontal scroll with a wrapping grid that collapses after 2 rows:

```text
┌─────────────────────────────────────────────────────┐
│ Filter by tags                              [Clear] │
├─────────────────────────────────────────────────────┤
│ [code] [grocery] [react] [shopping] [work] [todo]   │
│ [meeting] [idea] ...                                │
│                                      [▼ Show 8 more]│
└─────────────────────────────────────────────────────┘
```

**When expanded:**
```text
│ [code] [grocery] [react] [shopping] [work] [todo]   │
│ [meeting] [idea] [reminder] [link] [python] [api]   │
│ [database] [auth] [design]                          │
│                                       [▲ Show less] │
```

### Changes to `src/components/TagFilter.tsx`

1. **Replace `ScrollArea` with a flex-wrap container**
2. **Add `isExpanded` state** to control visibility
3. **Calculate visible tags** - Show first 10 tags when collapsed
4. **Add "Show X more" / "Show less" toggle button**
5. **Constrain with `max-w-full` and `overflow-hidden`** on the container

---

## Part 2: Better Entry Titles (The Real Fix)

### Current Problem
When you ask Jac "what codes are saved?", you get entries with titles like:
- "Code snippet"
- "Untitled"
- "List"

These don't tell you WHAT the code does or what the list is FOR.

### Solution
Improve the AI classification prompt to generate **descriptive, specific titles** that answer "What is this thing?"

### Changes to `supabase/functions/classify-content/index.ts`

**Update the system prompt with explicit title guidelines:**

Current behavior:
```
SUGGESTED TITLE: A short, descriptive title (max 60 chars)
```

New behavior:
```
SUGGESTED TITLE: Generate a specific, descriptive title that explains WHAT this is, not just its type.

TITLE RULES:
- BAD: "Code snippet" → GOOD: "React useEffect cleanup hook"
- BAD: "List" → GOOD: "Weekly grocery shopping list"  
- BAD: "Note" → GOOD: "Ideas for redesigning the dashboard"
- BAD: "Link" → GOOD: "Tailwind CSS documentation"
- BAD: "Reminder" → GOOD: "Call mom tomorrow afternoon"

For CODE specifically:
- Describe what the code DOES, not that it's code
- Include the language/framework if identifiable
- Examples: "Python CSV parser function", "SQL query for user stats", "Bash deploy script"

For LISTS:
- Include the list's PURPOSE
- Examples: "Camping trip packing list", "Q3 project tasks", "Books to read 2026"

For IMAGES:
- Describe the KEY subject matter
- Examples: "Receipt from Home Depot", "Screenshot of Stripe dashboard", "Whiteboard brainstorm session"
```

### Why This Fixes Jac's Context Problem

When Jac searches your brain and returns results, it uses `title` in responses like:
> "Found 3 code entries: **React useEffect cleanup hook**, **Python CSV parser**, **SQL user stats query**"

vs the current:
> "Found 3 code entries: **Code snippet**, **Code snippet**, **Code snippet**"

The title becomes the **identity** of each entry.

---

## Technical Implementation

### File: `src/components/TagFilter.tsx`

| Change | Description |
|--------|-------------|
| Replace `ScrollArea` | Use `flex flex-wrap` layout |
| Add `useState<boolean>` | Track expanded/collapsed state |
| Slice visible tags | Show first 10 when collapsed |
| Toggle button | "Show X more" / "Show less" with chevron icon |
| Container constraints | `max-w-full overflow-hidden` |

### File: `supabase/functions/classify-content/index.ts`

| Change | Description |
|--------|-------------|
| Update `systemPrompt` | Add detailed title generation rules with examples |
| Emphasize specificity | "Describe WHAT it is, not THAT it exists" |
| Type-specific guidance | Different rules for code, lists, images, links |

---

## Expected Results

### Before
- **Tags**: Overflow right edge, page becomes scrollable horizontally
- **Titles**: "Code snippet", "List", "Note" - useless for identification

### After
- **Tags**: Wrap cleanly, collapse to 2 rows, "Show 8 more" toggle
- **Titles**: "React hook for auth state", "Weekend grocery list", "API response example" - instantly identifiable

When you ask Jac "what codes are saved?", instead of showing generic "Code snippet" entries, it will show:
- "React useEffect cleanup hook"
- "Python CSV parser function"
- "SQL query for monthly sales"

---

## Files to Modify

| File | Purpose |
|------|---------|
| `src/components/TagFilter.tsx` | Wrap & collapse tag layout |
| `supabase/functions/classify-content/index.ts` | Better title generation prompts |

