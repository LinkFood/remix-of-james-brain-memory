import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { User } from "@supabase/supabase-js";
import { Brain, LogOut, MessageSquare, Database, TrendingUp, Clock, FileText, Network, Settings, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ChatInterface from "@/components/ChatInterface";
import MemoryVault from "@/components/MemoryVault";
import GlobalSearch from "@/components/GlobalSearch";
import UsageAnalytics from "@/components/UsageAnalytics";
import BackfillEmbeddings from "@/components/BackfillEmbeddings";
import TimelineView from "@/components/TimelineView";
import BrainReports from "@/components/BrainReports";
import BrainInsightsDashboard from "@/components/BrainInsightsDashboard";
import ScoreExistingMessages from "@/components/ScoreExistingMessages";
import KnowledgeGraph from "@/components/KnowledgeGraph";
import Onboarding from "@/components/Onboarding";
import MobileBottomNav from "@/components/MobileBottomNav";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

const Dashboard = () => {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("chat");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (!session?.user) {
        navigate("/auth");
        setLoading(false);
        return;
      }

      const { data: apiKey } = await supabase
        .from('user_api_keys')
        .select('id')
        .eq('user_id', session.user.id)
        .maybeSingle();

      if (!apiKey) {
        navigate("/settings");
      }
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (!session?.user) {
        navigate("/auth");
      }
    });

    return () => subscription.unsubscribe();
  }, [navigate]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    toast.success("Signed out successfully");
    navigate("/auth");
  };

  const handleMobileTabChange = (tab: string) => {
    if (tab === "settings") {
      navigate("/settings");
    } else {
      setActiveTab(tab);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-bg">
        <Brain className="w-12 h-12 text-primary animate-pulse-glow" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-bg pb-16 md:pb-0">
      <Onboarding userId={user?.id ?? ""} />
      
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="md:hidden">
                  <Menu className="h-6 w-6" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-80 bg-card">
                <div className="flex flex-col gap-2 mt-8">
                  <Button
                    variant={activeTab === "chat" ? "secondary" : "ghost"}
                    className="justify-start"
                    onClick={() => { setActiveTab("chat"); setMobileMenuOpen(false); }}
                  >
                    <MessageSquare className="w-4 h-4 mr-2" />
                    Chat
                  </Button>
                  <Button
                    variant={activeTab === "memory" ? "secondary" : "ghost"}
                    className="justify-start"
                    onClick={() => { setActiveTab("memory"); setMobileMenuOpen(false); }}
                  >
                    <Database className="w-4 h-4 mr-2" />
                    Memory
                  </Button>
                  <Button
                    variant={activeTab === "timeline" ? "secondary" : "ghost"}
                    className="justify-start"
                    onClick={() => { setActiveTab("timeline"); setMobileMenuOpen(false); }}
                  >
                    <Clock className="w-4 h-4 mr-2" />
                    Timeline
                  </Button>
                  <Button
                    variant={activeTab === "reports" ? "secondary" : "ghost"}
                    className="justify-start"
                    onClick={() => { setActiveTab("reports"); setMobileMenuOpen(false); }}
                  >
                    <FileText className="w-4 h-4 mr-2" />
                    Reports
                  </Button>
                  <Button
                    variant={activeTab === "insights" ? "secondary" : "ghost"}
                    className="justify-start"
                    onClick={() => { setActiveTab("insights"); setMobileMenuOpen(false); }}
                  >
                    <Brain className="w-4 h-4 mr-2" />
                    Insights
                  </Button>
                  <Button
                    variant={activeTab === "graph" ? "secondary" : "ghost"}
                    className="justify-start"
                    onClick={() => { setActiveTab("graph"); setMobileMenuOpen(false); }}
                  >
                    <Network className="w-4 h-4 mr-2" />
                    Graph
                  </Button>
                  <Button
                    variant={activeTab === "analytics" ? "secondary" : "ghost"}
                    className="justify-start"
                    onClick={() => { setActiveTab("analytics"); setMobileMenuOpen(false); }}
                  >
                    <TrendingUp className="w-4 h-4 mr-2" />
                    Analytics
                  </Button>
                  <div className="border-t border-border my-4" />
                  <Button
                    variant="ghost"
                    className="justify-start"
                    onClick={() => { navigate("/settings"); setMobileMenuOpen(false); }}
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
            
            <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center shadow-glow">
              <Brain className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">James Brain OS</h1>
              <p className="text-xs text-muted-foreground hidden md:block">Memory Shell v1.0</p>
            </div>
          </div>
          <div className="hidden md:flex items-center gap-2">
            <GlobalSearch userId={user?.id ?? ""} onSelectConversation={setSelectedConversationId} />
            <Button
              onClick={() => navigate("/settings")}
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
            >
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

      <main className="container mx-auto px-4 py-6">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="hidden md:grid w-full max-w-4xl mx-auto grid-cols-7 bg-card border border-border">
            <TabsTrigger value="chat" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <MessageSquare className="w-4 h-4 mr-2" />
              Chat
            </TabsTrigger>
            <TabsTrigger value="memory" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Database className="w-4 h-4 mr-2" />
              Memory
            </TabsTrigger>
            <TabsTrigger value="timeline" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Clock className="w-4 h-4 mr-2" />
              Timeline
            </TabsTrigger>
            <TabsTrigger value="reports" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <FileText className="w-4 h-4 mr-2" />
              Reports
            </TabsTrigger>
            <TabsTrigger value="insights" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Brain className="w-4 h-4 mr-2" />
              Insights
            </TabsTrigger>
            <TabsTrigger value="graph" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Network className="w-4 h-4 mr-2" />
              Graph
            </TabsTrigger>
            <TabsTrigger value="analytics" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <TrendingUp className="w-4 h-4 mr-2" />
              Analytics
            </TabsTrigger>
          </TabsList>

          <TabsContent value="chat" className="mt-6 animate-fade-in">
            <ChatInterface userId={user?.id ?? ""} key={selectedConversationId} initialConversationId={selectedConversationId} />
          </TabsContent>

          <TabsContent value="memory" className="mt-6 animate-fade-in">
            <MemoryVault userId={user?.id ?? ""} />
          </TabsContent>

          <TabsContent value="timeline" className="mt-6 animate-fade-in">
            <TimelineView userId={user?.id ?? ""} />
          </TabsContent>

          <TabsContent value="reports" className="mt-6 animate-fade-in">
            <BrainReports userId={user?.id ?? ""} />
          </TabsContent>

          <TabsContent value="insights" className="mt-6 animate-fade-in">
            <BrainInsightsDashboard userId={user?.id ?? ""} />
          </TabsContent>

          <TabsContent value="graph" className="mt-6 animate-fade-in">
            <KnowledgeGraph userId={user?.id ?? ""} />
          </TabsContent>

          <TabsContent value="analytics" className="mt-6 animate-fade-in">
            <div className="space-y-6">
              <BackfillEmbeddings userId={user?.id ?? ""} />
              <ScoreExistingMessages userId={user?.id ?? ""} />
              <UsageAnalytics userId={user?.id ?? ""} />
            </div>
          </TabsContent>
        </Tabs>
      </main>

      <MobileBottomNav 
        activeTab={activeTab}
        onTabChange={handleMobileTabChange}
        onMenuClick={() => setMobileMenuOpen(true)}
      />
    </div>
  );
};

export default Dashboard;
