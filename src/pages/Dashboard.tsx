import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { MessageSquare } from 'lucide-react';
import { useJacAgent } from '@/hooks/useJacAgent';
import { JacChat } from '@/components/jac/JacChat';
import { useSandboxLayout } from '@/hooks/useSandboxLayout';
import WidgetGrid from '@/components/sandbox/WidgetGrid';
import SandboxHeader from '@/components/sandbox/SandboxHeader';
import CompactDumpInput from '@/components/sandbox/CompactDumpInput';
import WidgetExpandedView from '@/components/sandbox/WidgetExpandedView';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

const Dashboard = () => {
  const navigate = useNavigate();
  const [userId, setUserId] = useState<string>('');
  const [chatOpen, setChatOpen] = useState(false);
  const [expandedWidgetId, setExpandedWidgetId] = useState<string | null>(null);
  const isMobile = useMediaQuery('(max-width: 768px)');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user) {
        navigate('/auth');
        return;
      }
      setUserId(session.user.id);
    });
  }, [navigate]);

  const { messages, tasks, sending, sendMessage } = useJacAgent(userId);
  const { layout, onLayoutChange, addWidget, removeWidget, resetLayout } = useSandboxLayout();

  const activeTypeIds = useMemo(
    () => new Set(Object.values(layout.typeMap)),
    [layout.typeMap]
  );

  if (!userId) return null;

  const header = (
    <SandboxHeader
      activeTypeIds={activeTypeIds}
      onAddWidget={addWidget}
      onResetLayout={resetLayout}
    />
  );

  const grid = (
    <WidgetGrid
      layout={layout}
      onLayoutChange={onLayoutChange}
      onRemoveWidget={removeWidget}
      onExpandWidget={setExpandedWidgetId}
    />
  );

  // Mobile layout — widget grid full width, chat behind FAB + Sheet
  if (isMobile) {
    return (
      <div className="h-[calc(100vh-2rem)] bg-background flex flex-col overflow-hidden">
        {header}
        <CompactDumpInput userId={userId} />
        <div className="flex-1 overflow-auto">
          {grid}
        </div>

        <Button
          className="fixed bottom-12 right-4 z-40 rounded-full h-12 w-12 shadow-lg"
          onClick={() => setChatOpen(true)}
        >
          <MessageSquare className="w-5 h-5" />
        </Button>

        <Sheet open={chatOpen} onOpenChange={setChatOpen}>
          <SheetContent side="left" className="w-[85vw] p-0 flex flex-col">
            <SheetHeader className="px-4 pt-4 pb-0 shrink-0">
              <SheetTitle className="text-sm">JAC</SheetTitle>
            </SheetHeader>
            <div className="flex-1 overflow-hidden">
              <JacChat messages={messages} tasks={tasks} sending={sending} onSend={sendMessage} />
            </div>
          </SheetContent>
        </Sheet>

        <WidgetExpandedView
          widgetId={expandedWidgetId}
          onClose={() => setExpandedWidgetId(null)}
        />
      </div>
    );
  }

  // Desktop layout — resizable split: chat left, grid right
  return (
    <div className="h-[calc(100vh-2rem)] bg-background flex flex-col overflow-hidden">
      {header}
      <CompactDumpInput userId={userId} />
      <div className="flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={25} minSize={15} maxSize={35} collapsible collapsedSize={0}>
            <JacChat messages={messages} tasks={tasks} sending={sending} onSend={sendMessage} />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={75} minSize={50}>
            <div className="h-full overflow-auto">
              {grid}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <WidgetExpandedView
        widgetId={expandedWidgetId}
        onClose={() => setExpandedWidgetId(null)}
      />
    </div>
  );
};

export default Dashboard;
