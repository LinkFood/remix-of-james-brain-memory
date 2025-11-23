import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { LandingChat } from '@/components/LandingChat';
import { LandingFooter } from '@/components/LandingFooter';
import { Button } from '@/components/ui/button';
import { MessageSquare } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { Drawer, DrawerContent, DrawerTrigger } from '@/components/ui/drawer';

const Landing = () => {
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        navigate('/dashboard');
      }
    });
  }, [navigate]);

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="border-b border-border px-6 py-4 sticky top-0 bg-background/80 backdrop-blur-sm z-50">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <h1 className="text-xl font-bold tracking-tight">JAMESBRAIN</h1>
          <Button onClick={() => navigate('/auth')} size="sm" variant="outline">
            Sign In
          </Button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {isMobile ? (
          // Mobile: Scrollable content with bottom drawer for chat
          <div className="flex-1 flex flex-col overflow-y-auto">
            <div className="flex items-center justify-center h-full px-6">
              <div className="text-center space-y-8">
                <h2 className="text-5xl md:text-7xl font-bold tracking-tight">
                  Memory for Every AI.
                </h2>
                <p className="text-xl md:text-2xl">
                  Yours to keep.
                </p>
                <Button onClick={() => navigate('/auth')} size="lg" className="text-base px-8">
                  Start Free
                </Button>
              </div>
            </div>

            <LandingFooter />

            {/* Mobile Chat Drawer */}
            <Drawer>
              <DrawerTrigger asChild>
                <Button 
                  size="lg" 
                  className="fixed bottom-4 right-4 shadow-lg z-40 gap-2"
                >
                  <MessageSquare className="w-5 h-5" />
                  Try Demo Chat
                </Button>
              </DrawerTrigger>
              <DrawerContent className="h-[85vh]">
                <div className="h-full flex flex-col">
                  <LandingChat />
                </div>
              </DrawerContent>
            </Drawer>
          </div>
        ) : (
          // Desktop: Split screen with resizable panels
          <ResizablePanelGroup direction="horizontal" className="flex-1">
            {/* Left Panel: Content */}
            <ResizablePanel defaultSize={60} minSize={40}>
              <div className="h-full flex flex-col">
                <div className="flex-1 flex items-center justify-center px-6">
                  <div className="text-center space-y-8">
                    <h2 className="text-5xl md:text-7xl font-bold tracking-tight">
                      Memory for Every AI.
                    </h2>
                    <p className="text-xl md:text-2xl">
                      Yours to keep.
                    </p>
                    <Button onClick={() => navigate('/auth')} size="lg" className="text-base px-8">
                      Start Free
                    </Button>
                  </div>
                </div>
                <LandingFooter />
              </div>
            </ResizablePanel>

            {/* Resizable Handle */}
            <ResizableHandle withHandle />

            {/* Right Panel: Chat */}
            <ResizablePanel defaultSize={40} minSize={30}>
              <div className="h-full border-l border-border bg-muted/20">
                <LandingChat />
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>
    </div>
  );
};

export default Landing;
