import type { ListItem } from '@/types';

/**
 * Type guard to check if an object is a valid ListItem
 */
function isListItem(item: unknown): item is ListItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    'text' in item &&
    'checked' in item &&
    typeof (item as ListItem).text === 'string' &&
    typeof (item as ListItem).checked === 'boolean'
  );
}

/**
 * Safely parse list_items from database Json type to typed array.
 * Handles various input formats and ensures type safety.
 *
 * @param items - The raw data from database (could be anything)
 * @returns An array of properly typed ListItem objects
 *
 * @example
 * const items = parseListItems([{ text: 'Buy milk', checked: false }]);
 * // Returns: [{ text: 'Buy milk', checked: false }]
 *
 * @example
 * const items = parseListItems(null);
 * // Returns: []
 */
export function parseListItems(items: unknown): ListItem[] {
  if (!items || !Array.isArray(items)) {
    return [];
  }

  return items.filter(isListItem);
}

/**
 * Parse text content into list items.
 * Supports bullet points (-, *, •), numbered lists, and checkboxes.
 *
 * @param content - Raw text content to parse
 * @returns Array of ListItem objects
 *
 * @example
 * const items = parseTextToListItems('- Item 1\n- [x] Item 2');
 * // Returns: [{ text: 'Item 1', checked: false }, { text: 'Item 2', checked: true }]
 */
export function parseTextToListItems(content: string | null | undefined): ListItem[] {
  if (!content) {
    return [];
  }

  const lines = content.split('\n');
  const items: ListItem[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for checkbox pattern: - [x] or - [ ]
    const checkboxMatch = trimmed.match(/^[-*•]\s*\[([ xX])\]\s*(.+)$/);
    if (checkboxMatch) {
      items.push({
        text: checkboxMatch[2].trim(),
        checked: checkboxMatch[1].toLowerCase() === 'x',
      });
      continue;
    }

    // Check for bullet point: -, *, •
    const bulletMatch = trimmed.match(/^[-*•]\s+(.+)$/);
    if (bulletMatch) {
      items.push({
        text: bulletMatch[1].trim(),
        checked: false,
      });
      continue;
    }

    // Check for numbered list: 1. or 1)
    const numberedMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (numberedMatch) {
      items.push({
        text: numberedMatch[1].trim(),
        checked: false,
      });
    }
  }

  return items;
}
