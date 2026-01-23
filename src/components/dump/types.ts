/**
 * Types for DumpInput components
 */

// Speech Recognition API types for browser compatibility
export interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
}

export interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: Event) => void) | null;
  start: () => void;
  stop: () => void;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

// File preview state
export interface PreviewFile {
  file: File;
  url: string;
  isPdf: boolean;
}

// Optimistic entry for pending state
export interface PendingEntry {
  id: string;
  content: string;
  title: string;
  content_type: string;
  content_subtype: string | null;
  tags: string[];
  importance_score: number | null;
  starred: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
  user_id: string;
  source: string;
  list_items: unknown[];
  extracted_data: Record<string, unknown>;
  image_url: string | null;
  event_date: string | null;
  event_time: string | null;
  embedding: string | null;
  is_recurring: boolean | null;
  recurrence_pattern: string | null;
  _pending: boolean;
}

// DumpInput component props
// Note: onOptimisticEntry uses a generic Record type to allow flexibility 
// for callers to define their own entry shape
export interface DumpInputProps {
  userId: string;
  onSaveSuccess?: (entry: unknown) => void;
  onOptimisticEntry?: (pendingEntry: Record<string, unknown>) => string;
  onOptimisticComplete?: (tempId: string, realEntry: unknown) => void;
  onOptimisticFail?: (tempId: string) => void;
  className?: string;
}

// Handle for imperative methods
export interface DumpInputHandle {
  setValue: (text: string) => void;
  focus: () => void;
}

// File upload constants
export const ALLOWED_FILE_TYPES = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/pdf'
];

export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
