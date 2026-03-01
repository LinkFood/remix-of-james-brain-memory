/**
 * JacSidebar — Persistent JAC chat panel across all pages.
 *
 * Desktop: collapsible left panel (~300px expanded, 48px collapsed).
 * Mobile: hidden, accessible via FAB that opens a Sheet.
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { MessageSquare, PanelLeftClose, PanelLeft } from 'lucide-react';
import { JacChat } from '@/components/jac/JacChat';
import { useJacContext } from '@/contexts/JacContext';

interface JacSidebarProps {
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  isMobile: boolean;
}

export function JacSidebar({ isCollapsed, onToggleCollapsed, isMobile }: JacSidebarProps) {
  const { messages, tasks, sending, sendMessage } = useJacContext();
  const [sheetOpen, setSheetOpen] = useState(false);

  // Mobile: FAB + Sheet
  if (isMobile) {
    return (
      <>
        <Button
          className="fixed bottom-12 right-4 z-40 rounded-full h-12 w-12 shadow-lg bg-primary"
          onClick={() => setSheetOpen(true)}
        >
          <MessageSquare className="w-5 h-5" />
        </Button>

        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="left" className="w-[85vw] p-0 flex flex-col">
            <SheetHeader className="px-4 pt-4 pb-0 shrink-0">
              <SheetTitle className="text-sm">JAC</SheetTitle>
            </SheetHeader>
            <div className="flex-1 overflow-hidden">
              <JacChat messages={messages} tasks={tasks} sending={sending} onSend={sendMessage} />
            </div>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  // Desktop: collapsible panel
  if (isCollapsed) {
    return (
      <div className="w-12 border-r border-border bg-card/30 flex flex-col items-center pt-2 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onToggleCollapsed}
          title="Expand JAC"
        >
          <PanelLeft className="w-4 h-4" />
        </Button>
        <div className="mt-2 writing-mode-vertical text-[10px] text-muted-foreground/60 tracking-widest uppercase"
          style={{ writingMode: 'vertical-lr' }}
        >
          JAC
        </div>
      </div>
    );
  }

  return (
    <div className="w-[320px] border-r border-border flex flex-col shrink-0 bg-card/20">
      <div className="flex items-center justify-between px-3 h-8 border-b border-border/50 shrink-0">
        <span className="text-xs font-medium text-muted-foreground">JAC</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onToggleCollapsed}
          title="Collapse JAC"
        >
          <PanelLeftClose className="w-3.5 h-3.5" />
        </Button>
      </div>
      <div className="flex-1 overflow-hidden">
        <JacChat messages={messages} tasks={tasks} sending={sending} onSend={sendMessage} />
      </div>
    </div>
  );
}
