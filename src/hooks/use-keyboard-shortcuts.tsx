import { useEffect, useCallback } from "react";

interface KeyboardShortcutsOptions {
  onOpenSearch?: () => void;
  onFocusInput?: () => void;
  onToggleAssistant?: () => void;
}

export function useKeyboardShortcuts({
  onOpenSearch,
  onFocusInput,
  onToggleAssistant,
}: KeyboardShortcutsOptions) {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const isMod = event.metaKey || event.ctrlKey;

      // Ignore if user is typing in an input/textarea
      const target = event.target as HTMLElement;
      const isInputActive =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      // Cmd/Ctrl + K: Open search (works even in inputs)
      if (isMod && event.key === "k") {
        event.preventDefault();
        onOpenSearch?.();
        return;
      }

      // Skip other shortcuts if typing
      if (isInputActive) return;

      // Cmd/Ctrl + N: Focus dump input
      if (isMod && event.key === "n") {
        event.preventDefault();
        onFocusInput?.();
        return;
      }

      // Cmd/Ctrl + /: Toggle assistant
      if (isMod && event.key === "/") {
        event.preventDefault();
        onToggleAssistant?.();
        return;
      }
    },
    [onOpenSearch, onFocusInput, onToggleAssistant]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}
