/**
 * Comprehensive Type Definitions for LinkJac
 *
 * This file contains all shared types used across the application.
 * Import types from here rather than defining them inline in components.
 */

// =============================================================================
// CONTENT TYPES
// =============================================================================

/**
 * All possible content types for entries
 */
export type ContentType =
  | 'code'
  | 'list'
  | 'idea'
  | 'link'
  | 'contact'
  | 'event'
  | 'reminder'
  | 'note'
  | 'image'
  | 'document';

/**
 * Recurrence patterns for recurring events/reminders
 */
export type RecurrencePattern = 'daily' | 'weekly' | 'monthly' | 'yearly';

/**
 * Source of an entry
 */
export type EntrySource = 'manual' | 'assistant' | 'api';

// =============================================================================
// CORE DATA STRUCTURES
// =============================================================================

/**
 * A single item in a list entry
 */
export interface ListItem {
  text: string;
  checked: boolean;
}

/**
 * The main Entry type representing a single LinkJac entry
 */
export interface Entry {
  id: string;
  user_id: string;
  content: string;
  title: string | null;
  content_type: string; // Keep as string for flexibility with DB
  content_subtype: string | null;
  tags: string[];
  extracted_data: Record<string, unknown>;
  importance_score: number | null;
  list_items: ListItem[];
  source: string;
  starred: boolean;
  archived: boolean;
  image_url?: string | null;
  event_date?: string | null;
  event_time?: string | null;
  is_recurring?: boolean | null;
  recurrence_pattern?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Entry with pending flag for optimistic updates
 */
export interface PendingEntry extends Entry {
  _pending?: boolean;
}

/**
 * Search result extends Entry with optional similarity score
 */
export interface SearchResult extends Entry {
  similarity?: number;
}

// =============================================================================
// CLASSIFICATION & AI TYPES
// =============================================================================

/**
 * Result from the classify-content edge function
 */
export interface ClassificationResult {
  type: ContentType;
  subtype: string | null;
  title: string;
  tags: string[];
  extractedData: Record<string, unknown> | null;
  listItems: ListItem[] | null;
  eventDate: string | null;
  eventTime: string | null;
  isRecurring: boolean;
  recurrencePattern: RecurrencePattern | null;
  appendTo: string | null;
  imageDescription: string | null;
  documentText: string | null;
}

/**
 * Source reference in assistant chat responses
 */
export interface Source {
  id: string;
  title: string | null;
  content_type: string;
  similarity?: number;
}

/**
 * Chat message in assistant chat
 */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
}

// =============================================================================
// BRAIN REPORTS
// =============================================================================

/**
 * A theme identified in brain reports
 */
export interface ThemeItem {
  theme: string;
  description: string;
  count: number;
}

/**
 * A decision tracked in brain reports
 */
export interface DecisionItem {
  decision: string;
  context: string;
  date: string;
}

/**
 * An insight from brain reports
 */
export interface InsightItem {
  insight: string;
  category: string;
}

/**
 * Statistics about conversation/entry patterns
 */
export interface ConversationStats {
  totalMessages: number;
  averagePerDay: number;
  topTypes: Array<{ type: ContentType; count: number }>;
}

/**
 * A generated brain report
 */
export interface BrainReport {
  id: string;
  user_id: string;
  report_type: 'daily' | 'weekly' | 'monthly';
  start_date: string;
  end_date: string;
  summary: string;
  key_themes: ThemeItem[];
  decisions: DecisionItem[];
  insights: InsightItem[];
  conversation_stats: ConversationStats;
  created_at: string;
}

// =============================================================================
// DASHBOARD TYPES
// =============================================================================

/**
 * Statistics displayed on the dashboard
 */
export interface DashboardStats {
  total: number;
  today: number;
  important: number;
  byType: Record<string, number>;
}

// =============================================================================
// API RESPONSE TYPES
// =============================================================================

/**
 * Generic API response wrapper
 */
export interface ApiResponse<T> {
  data: T | null;
  error: string | null;
}

/**
 * Paginated API response
 */
export interface PaginatedResponse<T> {
  data: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

/**
 * Smart-save edge function response
 */
export interface SmartSaveResponse {
  entry: Entry;
  action: 'created' | 'updated' | 'appended';
  summary: string;
  classification?: ClassificationResult;
}

/**
 * Search memory edge function response
 */
export interface SearchMemoryResponse {
  results: SearchResult[];
  total: number;
  query: string;
}

// =============================================================================
// COMPONENT PROP TYPES
// =============================================================================

/**
 * Props for EntryCard component
 */
export interface EntryCardProps {
  entry: Entry;
  compact?: boolean;
  showContent?: boolean;
  onToggleListItem?: (entryId: string, itemIndex: number, checked: boolean) => void;
  onStar?: (entryId: string, starred: boolean) => void;
  onArchive?: (entryId: string) => void;
  onDelete?: (entryId: string) => void;
  onClick?: (entry: Entry) => void;
}

/**
 * Props for DumpInput component
 */
export interface DumpInputProps {
  userId: string;
  onSaveSuccess?: (entry: Entry) => void;
  onOptimisticEntry?: (pendingEntry: PendingEntry) => string;
  onOptimisticComplete?: (tempId: string, realEntry: Entry) => void;
  onOptimisticFail?: (tempId: string) => void;
  className?: string;
}

/**
 * Handle exposed by DumpInput via forwardRef
 */
export interface DumpInputHandle {
  setValue: (text: string) => void;
  focus: () => void;
}

/**
 * Props for Dashboard component
 */
export interface DashboardComponentProps {
  userId: string;
  onViewEntry: (entry: Entry) => void;
  dumpInputRef?: React.RefObject<DumpInputHandle>;
}

/**
 * Props for EntryView component
 */
export interface EntryViewProps {
  entry: Entry | null;
  open: boolean;
  onClose: () => void;
  onUpdate?: (entry: Entry) => void;
  onDelete?: (entryId: string) => void;
}

/**
 * Props for GlobalSearch component
 */
export interface GlobalSearchProps {
  userId: string;
  onSelectEntry: (entry: SearchResult) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Props for CalendarView component
 */
export interface CalendarViewProps {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onViewEntry: (entry: Entry) => void;
}

/**
 * Props for AssistantChat component
 */
export interface AssistantChatProps {
  userId: string;
  onEntryCreated?: (entry: Entry) => void;
  externalOpen?: boolean;
  onExternalOpenChange?: (open: boolean) => void;
}

/**
 * Props for EntrySection component
 */
export interface EntrySectionProps {
  title: string;
  icon: React.ReactNode;
  entries: Entry[];
  section: string;
  expanded: boolean;
  onToggle: (section: string) => void;
  color?: string;
  compact?: boolean;
  limit?: number;
  showLoadMore?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  onToggleListItem?: (entryId: string, itemIndex: number, checked: boolean) => void;
  onStar?: (entryId: string, starred: boolean) => void;
  onArchive?: (entryId: string) => void;
  onDelete?: (entryId: string) => void;
  onViewEntry: (entry: Entry) => void;
}

// =============================================================================
// FILE HANDLING TYPES
// =============================================================================

/**
 * File preview state for DumpInput
 */
export interface FilePreview {
  file: File;
  url: string;
  isPdf: boolean;
}

/**
 * Allowed file types for upload
 */
export const ALLOWED_FILE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
] as const;

export type AllowedFileType = (typeof ALLOWED_FILE_TYPES)[number];

/**
 * Maximum file size for uploads (20MB)
 */
export const MAX_FILE_SIZE = 20 * 1024 * 1024;

// =============================================================================
// UTILITY TYPES
// =============================================================================

/**
 * Make specific properties required
 */
export type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };

/**
 * Make specific properties optional
 */
export type WithOptional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * Extract the type of array elements
 */
export type ArrayElement<T> = T extends readonly (infer U)[] ? U : never;
