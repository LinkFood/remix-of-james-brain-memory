import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { User } from "@supabase/supabase-js";
import { Brain, LogOut, Settings, Menu, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import DashboardComponent from "@/components/Dashboard";
import AssistantChat from "@/components/AssistantChat";
import EntryView from "@/components/EntryView";
import GlobalSearch from "@/components/GlobalSearch";
import OfflineBanner from "@/components/OfflineBanner";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useOnlineStatus } from "@/hooks/use-online-status";
import type { Entry } from "@/components/EntryCard";
import type { DumpInputHandle } from "@/components/DumpInput";

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
  const dumpInputRef = useRef<DumpInputHandle>(null);
  const isOnline = useOnlineStatus();

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onOpenSearch: () => setSearchOpen(true),
    onFocusInput: () => {
      dumpInputRef.current?.focus();
    },
    onToggleAssistant: () => setAssistantOpen((prev) => !prev),
  });

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (!session?.user) {
        navigate("/");
      }
      setLoading(false);
    });

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
        <Brain className="w-12 h-12 text-primary animate-pulse" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-bg">
      {/* Offline Banner */}
      {!isOnline && <OfflineBanner />}
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

            <div className="flex items-center gap-2">
              <div className="w-9 h-9 bg-primary/10 rounded-lg flex items-center justify-center">
                <Brain className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-foreground">Brain Dump</h1>
              </div>
            </div>
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
              onClick={() => setRefreshKey((prev) => prev + 1)}
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
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

      {/* Global Search */}
      {user?.id && (
        <GlobalSearch
          userId={user.id}
          onSelectEntry={handleSearchSelect}
          open={searchOpen}
          onOpenChange={setSearchOpen}
        />
      )}

      {/* Entry Detail View */}
      <EntryView
        entry={selectedEntry}
        open={entryViewOpen}
        onClose={() => setEntryViewOpen(false)}
        onUpdate={handleEntryUpdate}
        onDelete={handleEntryDelete}
      />

      {/* Assistant Chat */}
      {user?.id && (
        <AssistantChat
          userId={user.id}
          onEntryCreated={handleEntryCreatedFromAssistant}
          externalOpen={assistantOpen}
          onExternalOpenChange={setAssistantOpen}
        />
      )}
    </div>
  );
};

export default Dashboard;
