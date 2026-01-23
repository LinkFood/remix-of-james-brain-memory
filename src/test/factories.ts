import type { Entry, BrainReport, ListItem, PendingEntry, SearchResult } from '@/types';

/**
 * Create a mock Entry with sensible defaults
 */
export function createMockEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: crypto.randomUUID(),
    user_id: 'test-user-id',
    content: 'Test content',
    title: 'Test Title',
    content_type: 'note',
    content_subtype: null,
    tags: ['test'],
    importance_score: 5,
    image_url: null,
    list_items: [],
    extracted_data: {},
    event_date: null,
    event_time: null,
    is_recurring: false,
    recurrence_pattern: null,
    source: 'manual',
    starred: false,
    archived: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a mock list entry with items
 */
export function createMockListEntry(
  items: string[] = ['Item 1', 'Item 2'],
  overrides: Partial<Entry> = {}
): Entry {
  const listItems: ListItem[] = items.map((text) => ({ text, checked: false }));
  return createMockEntry({
    content_type: 'list',
    content_subtype: 'todo',
    content: items.join('\n'),
    list_items: listItems,
    ...overrides,
  });
}

/**
 * Create a mock code entry
 */
export function createMockCodeEntry(
  language: string = 'javascript',
  overrides: Partial<Entry> = {}
): Entry {
  return createMockEntry({
    content_type: 'code',
    content_subtype: language,
    content: 'console.log("Hello World");',
    ...overrides,
  });
}

/**
 * Create a mock event entry
 */
export function createMockEventEntry(overrides: Partial<Entry> = {}): Entry {
  return createMockEntry({
    content_type: 'event',
    title: 'Meeting',
    event_date: new Date().toISOString().split('T')[0],
    event_time: '14:00',
    ...overrides,
  });
}

/**
 * Create a mock idea entry
 */
export function createMockIdeaEntry(overrides: Partial<Entry> = {}): Entry {
  return createMockEntry({
    content_type: 'idea',
    title: 'Great Idea',
    content: 'This is a brilliant idea for the future.',
    importance_score: 7,
    ...overrides,
  });
}

/**
 * Create a mock pending entry (for optimistic updates)
 */
export function createMockPendingEntry(overrides: Partial<PendingEntry> = {}): PendingEntry {
  return {
    ...createMockEntry(),
    _pending: true,
    ...overrides,
  };
}

/**
 * Create a mock search result
 */
export function createMockSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    ...createMockEntry(),
    similarity: 0.85,
    ...overrides,
  };
}

/**
 * Create a mock brain report
 */
export function createMockBrainReport(overrides: Partial<BrainReport> = {}): BrainReport {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  return {
    id: crypto.randomUUID(),
    user_id: 'test-user-id',
    report_type: 'weekly',
    start_date: weekAgo.toISOString().split('T')[0],
    end_date: now.toISOString().split('T')[0],
    summary: 'This week you focused on productivity and code organization.',
    key_themes: [
      { theme: 'Productivity', description: 'Focus on getting things done', count: 5 },
      { theme: 'Code', description: 'Technical work and snippets', count: 3 },
    ],
    decisions: [
      {
        decision: 'Use TypeScript strict mode',
        context: 'Code quality improvement',
        date: now.toISOString(),
      },
    ],
    insights: [
      { insight: 'You are most productive in the morning', category: 'productivity' },
      { insight: 'Consider breaking down larger tasks', category: 'workflow' },
    ],
    conversation_stats: {
      totalMessages: 100,
      averagePerDay: 14,
      topTypes: [
        { type: 'note', count: 50 },
        { type: 'code', count: 25 },
        { type: 'list', count: 15 },
      ],
    },
    created_at: now.toISOString(),
    ...overrides,
  };
}

/**
 * Create multiple mock entries
 */
export function createMockEntries(count: number = 5): Entry[] {
  return Array.from({ length: count }, (_, i) =>
    createMockEntry({
      title: `Entry ${i + 1}`,
      content: `Content for entry ${i + 1}`,
      created_at: new Date(Date.now() - i * 1000 * 60 * 60).toISOString(), // 1 hour apart
    })
  );
}
