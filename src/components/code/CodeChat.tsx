/**
 * CodeChat — Chat input for sending code commands to JAC
 *
 * Textarea with Enter to send, Shift+Enter for newline.
 * Disabled when no project is selected or currently sending.
 */

import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Send, Loader2, Code2 } from 'lucide-react';

interface CodeChatProps {
  onSend: (message: string) => void;
  sending: boolean;
  projectName: string | null;
}

const EXAMPLE_COMMANDS = [
  'Fix the login bug',
  'Add dark mode toggle',
  'Refactor auth flow',
];

export function CodeChat({ onSend, sending, projectName }: CodeChatProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const disabled = !projectName || sending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || disabled) return;
    onSend(input.trim());
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="border-t border-border bg-card/30">
      {/* Example commands hint */}
      {projectName && !input && (
        <div className="px-3 pt-2 flex flex-wrap gap-1.5">
          {EXAMPLE_COMMANDS.map((cmd) => (
            <button
              key={cmd}
              onClick={() => !disabled && setInput(cmd)}
              className="text-[10px] px-2 py-0.5 rounded-full border border-border bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
            >
              {cmd}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={handleSubmit} className="p-3">
        <div className="flex gap-2 items-end">
          <div className="relative flex-1">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={projectName ? 'Tell JAC what to code...' : 'Select a project first'}
              disabled={disabled}
              className="min-h-[40px] max-h-[120px] resize-none text-sm pr-8"
              rows={1}
            />
            {projectName && (
              <Code2 className="absolute right-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground/30" />
            )}
          </div>
          <Button
            type="submit"
            size="icon"
            disabled={disabled || !input.trim()}
            className="shrink-0 h-10 w-10"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground/50 mt-1.5 text-center">
          Enter to send · Shift+Enter for new line
        </p>
      </form>
    </div>
  );
}
