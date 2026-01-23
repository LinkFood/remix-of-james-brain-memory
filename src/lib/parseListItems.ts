/**
 * Safely parse list_items from database Json type to typed array
 */
export const parseListItems = (
  items: unknown
): Array<{ text: string; checked: boolean }> => {
  if (!items || !Array.isArray(items)) return [];
  return items.filter(
    (item): item is { text: string; checked: boolean } =>
      typeof item === "object" &&
      item !== null &&
      "text" in item &&
      "checked" in item &&
      typeof (item as any).text === "string" &&
      typeof (item as any).checked === "boolean"
  );
};
