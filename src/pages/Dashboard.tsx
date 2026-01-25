import { useEffect, useState, useCallback, useRef, lazy, Suspense } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { User } from "@supabase/supabase-js";
import { LogOut, Settings, Menu, RefreshCw, Search, Calendar, Network, CloudOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import DashboardComponent from "@/components/Dashboard";
import OfflineBanner from "@/components/OfflineBanner";
import ThemeToggle from "@/components/ThemeToggle";
import { LinkJacLogo } from "@/components/LinkJacLogo";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { useOfflineQueue } from "@/hooks/useOfflineQueue";
import type { Entry } from "@/components/EntryCard";
import type { DumpInputHandle } from "@/components/DumpInput";

// Lazy load heavy components
const AssistantChat = lazy(() => import("@/components/AssistantChat"));
const EntryView = lazy(() => import("@/components/EntryView"));
const GlobalSearch = lazy(() => import("@/components/GlobalSearch"));
const CalendarView = lazy(() => import("@/components/CalendarView").then(m => ({ default: m.CalendarView })));
const KnowledgeGraph = lazy(() => import("@/components/KnowledgeGraph"));
const OnboardingModal = lazy(() => import("@/components/OnboardingModal"));
const TimelineView = lazy(() => import("@/components/TimelineView"));

// Fallback component for lazy loading
const LazyFallback = () => (
  <div className="p-4">
    <Skeleton className="h-64 w-full rounded-lg" />
  </div>
);

const Dashboard = () => {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<Entry | null>(null);
  const [entryViewOpen, setEntryViewOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const dumpInputRef = useRef<DumpInputHandle>(null);
  const isOnline = useOnlineStatus();
  const { queueLength, flushQueue } = useOfflineQueue();

  // Pre-warm edge functions on mount to reduce cold starts
  useEffect(() => {
    const warmUp = async () => {
      const baseUrl = import.meta.env.VITE_SUPABASE_URL;
      const functions = ["smart-save", "assistant-chat"];
      
      // Fire-and-forget OPTIONS requests to warm up functions
      functions.forEach((fn) => {
        fetch(`${baseUrl}/functions/v1/${fn}`, { method: "OPTIONS" }).catch(() => {});
      });
    };
    
    if (isOnline) {
      warmUp();
    }
  }, [isOnline]);

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onOpenSearch: () => setSearchOpen(true),
    onFocusInput: () => {
      dumpInputRef.current?.focus();
    },
    onToggleAssistant: () => setAssistantOpen((prev) => !prev),
  });

  // Check auth and onboarding status
  useEffect(() => {
    const checkAuthAndOnboarding = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      
      if (!session?.user) {
        navigate("/");
        setLoading(false);
        return;
      }
      
      setUser(session.user);
      
      // Check onboarding status
      const { data: profile } = await supabase
        .from("profiles")
        .select("onboarding_completed")
        .eq("id", session.user.id)
        .single();
      
      if (profile && !profile.onboarding_completed) {
        setShowOnboarding(true);
      }
      
      setLoading(false);
    };
    
    checkAuthAndOnboarding();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (!session?.user) {
        navigate("/");
      }
    });

    return () => subscription.unsubscribe();
  }, [navigate]);

  const handleOnboardingComplete = useCallback(async () => {
    if (!user?.id) return;
    
    // Update profile
    await supabase
      .from("profiles")
      .update({ onboarding_completed: true })
      .eq("id", user.id);
    
    setShowOnboarding(false);
  }, [user?.id]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    toast.success("Signed out successfully");
    navigate("/");
  };

  const handleViewEntry = useCallback((entry: Entry) => {
    setSelectedEntry(entry);
    setEntryViewOpen(true);
  }, []);

  const handleEntryUpdate = useCallback((updatedEntry: Entry) => {
    setSelectedEntry(updatedEntry);
    setRefreshKey((prev) => prev + 1);
  }, []);

  const handleEntryDelete = useCallback((entryId: string) => {
    setRefreshKey((prev) => prev + 1);
    if (selectedEntry?.id === entryId) {
      setSelectedEntry(null);
      setEntryViewOpen(false);
    }
  }, [selectedEntry]);

  const handleEntryCreatedFromAssistant = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  const handleSearchSelect = useCallback((entry: Entry) => {
    setSearchOpen(false);
    handleViewEntry(entry);
  }, [handleViewEntry]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-bg">
        <LinkJacLogo size="lg" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-bg">
      {/* Offline Banner */}
      {!isOnline && <OfflineBanner />}
      
      {/* Pending Sync Banner */}
      {queueLength > 0 && isOnline && (
        <div className="bg-warning/10 border-b border-warning/20 px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-warning text-sm">
            <CloudOff className="w-4 h-4" />
            <span>{queueLength} pending {queueLength === 1 ? 'entry' : 'entries'} to sync</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={flushQueue}
            className="text-warning hover:text-warning/80"
          >
            Sync now
          </Button>
        </div>
      )}
      {/* Header */}
      <header className={`border-b border-border bg-card/50 backdrop-blur-sm sticky ${!isOnline ? 'top-10' : 'top-0'} z-40`}>
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Mobile Menu */}
            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="md:hidden">
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72 bg-card">
                <div className="flex flex-col gap-2 mt-8">
                  <Button
                    variant="ghost"
                    className="justify-start"
                    onClick={() => {
                      setSearchOpen(true);
                      setMobileMenuOpen(false);
                    }}
                  >
                    <Search className="w-4 h-4 mr-2" />
                    Search
                  </Button>
                  <Button
                    variant="ghost"
                    className="justify-start"
                    onClick={() => {
                      setTimelineOpen(true);
                      setMobileMenuOpen(false);
                    }}
                  >
                    <Calendar className="w-4 h-4 mr-2" />
                    Timeline
                  </Button>
                  <Button
                    variant="ghost"
                    className="justify-start"
                    onClick={() => {
                      setCalendarOpen(true);
                      setMobileMenuOpen(false);
                    }}
                  >
                    <Calendar className="w-4 h-4 mr-2" />
                    Calendar
                  </Button>
                  <Button
                    variant="ghost"
                    className="justify-start"
                    onClick={() => {
                      setGraphOpen(true);
                      setMobileMenuOpen(false);
                    }}
                  >
                    <Network className="w-4 h-4 mr-2" />
                    Knowledge Graph
                  </Button>
                  <Button
                    variant="ghost"
                    className="justify-start"
                    onClick={() => {
                      navigate("/settings");
                      setMobileMenuOpen(false);
                    }}
                  >
                    <Settings className="w-4 h-4 mr-2" />
                    Settings
                  </Button>
                  <Button
                    variant="ghost"
                    className="justify-start"
                    onClick={handleSignOut}
                  >
                    <LogOut className="w-4 h-4 mr-2" />
                    Sign Out
                  </Button>
                </div>
              </SheetContent>
            </Sheet>

            <LinkJacLogo size="md" />
          </div>

          <div className="hidden md:flex items-center gap-2">
            <Button
              onClick={() => setSearchOpen(true)}
              variant="outline"
              size="sm"
              className="text-muted-foreground gap-2"
            >
              <Search className="w-4 h-4" />
              <span className="hidden lg:inline">Search</span>
              <kbd className="hidden lg:inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
                ⌘K
              </kbd>
            </Button>
            <Button
              onClick={() => setTimelineOpen(true)}
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground"
              title="Timeline"
            >
              <Calendar className="w-4 h-4" />
            </Button>
            <Button
              onClick={() => setCalendarOpen(true)}
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground"
              title="Calendar"
            >
              <Calendar className="w-4 h-4" />
            </Button>
            <Button
              onClick={() => setGraphOpen(true)}
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground"
              title="Knowledge Graph"
            >
              <Network className="w-4 h-4" />
            </Button>
            <Button
              onClick={() => setRefreshKey((prev) => prev + 1)}
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
            <ThemeToggle />
            <Button
              onClick={() => navigate("/settings")}
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
            >
              <Settings className="w-4 h-4 mr-2" />
              Settings
            </Button>
            <Button
              onClick={handleSignOut}
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
            >
              <LogOut className="w-4 h-4 mr-2" />
              Sign Out
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-6 max-w-4xl">
        <DashboardComponent
          key={refreshKey}
          userId={user?.id ?? ""}
          onViewEntry={handleViewEntry}
          dumpInputRef={dumpInputRef}
        />
      </main>

      {/* Global Search - Lazy loaded */}
      {user?.id && (
        <Suspense fallback={null}>
          <GlobalSearch
            userId={user.id}
            onSelectEntry={handleSearchSelect}
            open={searchOpen}
            onOpenChange={setSearchOpen}
          />
        </Suspense>
      )}

      {/* Entry Detail View - Lazy loaded */}
      <Suspense fallback={<LazyFallback />}>
        <EntryView
          entry={selectedEntry}
          open={entryViewOpen}
          onClose={() => setEntryViewOpen(false)}
          onUpdate={handleEntryUpdate}
          onDelete={handleEntryDelete}
        />
      </Suspense>

      {/* Assistant Chat - Lazy loaded */}
      {user?.id && (
        <Suspense fallback={null}>
          <AssistantChat
            userId={user.id}
            onEntryCreated={handleEntryCreatedFromAssistant}
            externalOpen={assistantOpen}
            onExternalOpenChange={setAssistantOpen}
          />
        </Suspense>
      )}

      {/* Calendar View - Lazy loaded */}
      {user?.id && (
        <Suspense fallback={<LazyFallback />}>
          <CalendarView
            userId={user.id}
            open={calendarOpen}
            onOpenChange={setCalendarOpen}
            onViewEntry={handleViewEntry}
          />
        </Suspense>
      )}

      {/* Timeline View - Lazy loaded */}
      {user?.id && (
        <Suspense fallback={<LazyFallback />}>
          <TimelineView
            userId={user.id}
            open={timelineOpen}
            onOpenChange={setTimelineOpen}
            onViewEntry={handleViewEntry}
          />
        </Suspense>
      )}

      {/* Knowledge Graph - Lazy loaded */}
      {user?.id && graphOpen && (
        <Suspense fallback={<LazyFallback />}>
          <Sheet open={graphOpen} onOpenChange={setGraphOpen}>
            <SheetContent side="right" className="w-full sm:max-w-4xl p-0">
              <KnowledgeGraph userId={user.id} />
            </SheetContent>
          </Sheet>
        </Suspense>
      )}

      {/* Onboarding Modal - Lazy loaded */}
      {user?.id && (
        <Suspense fallback={null}>
          <OnboardingModal
            open={showOnboarding}
            onComplete={handleOnboardingComplete}
          />
        </Suspense>
      )}
    </div>
  );
};

export default Dashboard;
