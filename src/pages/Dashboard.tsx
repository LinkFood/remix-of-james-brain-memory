import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { User } from "@supabase/supabase-js";
import { Brain, LogOut, MessageSquare, Database, Settings, Menu, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import ChatInterface from "@/components/ChatInterface";
import MemoryVault from "@/components/MemoryVault";
import GlobalSearch from "@/components/GlobalSearch";
import Onboarding from "@/components/Onboarding";
import { OnboardingWizard } from "@/components/OnboardingWizard";
import { PostSignupOnboarding } from "@/components/PostSignupOnboarding";
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
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [demoConversationId, setDemoConversationId] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (!session?.user) {
        navigate("/");
        setLoading(false);
        return;
      }

      const { data: apiKey } = await supabase
        .from('user_api_keys')
        .select('id')
        .eq('user_id', session.user.id)
        .maybeSingle();

      if (!apiKey) {
        checkIfNewUser(session.user.id);
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

  const checkIfNewUser = async (uid: string) => {
    try {
      const { data, error } = await supabase
        .from('user_api_keys')
        .select('id')
        .eq('user_id', uid)
        .limit(1);

      if (error) throw error;
      
      const { data: conversationData } = await supabase
        .from('conversations')
        .select('id')
        .eq('user_id', uid)
        .limit(1);

      if ((!data || data.length === 0) && (!conversationData || conversationData.length === 0)) {
        setShowOnboarding(true);
      }
    } catch (error) {
      console.error('Error checking user status:', error);
    }
  };

  const enableDemoMode = async () => {
    if (!user?.id) return;
    
    try {
      const { data: sampleConvs, error } = await supabase
        .from('conversations')
        .select('id')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1);

      if (error) throw error;

      if (sampleConvs && sampleConvs.length > 0) {
        setDemoConversationId(sampleConvs[0].id);
        setDemoMode(true);
        setActiveTab("chat");
        toast.success("Demo mode enabled - exploring sample conversation");
      } else {
        const { error: insertError } = await supabase.functions.invoke('insert-sample-data');
        if (insertError) throw insertError;
        
        const { data: newConvs } = await supabase
          .from('conversations')
          .select('id')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(1);
        
        if (newConvs && newConvs.length > 0) {
          setDemoConversationId(newConvs[0].id);
          setDemoMode(true);
          setActiveTab("chat");
          toast.success("Demo mode enabled with sample data");
        }
      }
    } catch (error: any) {
      toast.error("Failed to enable demo mode");
      console.error(error);
    }
  };

  const disableDemoMode = () => {
    setDemoMode(false);
    setDemoConversationId(null);
    toast.success("Demo mode disabled");
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    toast.success("Signed out successfully");
    navigate("/");
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
      {showOnboarding && user?.id && (
        <PostSignupOnboarding
          onComplete={() => setShowOnboarding(false)}
        />
      )}
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
              onClick={demoMode ? disableDemoMode : enableDemoMode}
              variant="outline"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
            >
              <Play className="w-4 h-4 mr-2" />
              {demoMode ? 'Exit Demo' : 'Demo Mode'}
            </Button>
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

      {demoMode && (
        <div className="container mx-auto px-4 pt-4">
          <Alert>
            <AlertDescription>
              Demo Mode: Exploring sample conversations with pre-populated data. Exit demo to start fresh.
            </AlertDescription>
          </Alert>
        </div>
      )}

      <main className="container mx-auto px-4 py-6">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="hidden md:grid w-full max-w-4xl mx-auto grid-cols-2 bg-card border border-border">
            <TabsTrigger value="chat" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <MessageSquare className="w-4 h-4 mr-2" />
              Chat
            </TabsTrigger>
            <TabsTrigger value="memory" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Database className="w-4 h-4 mr-2" />
              Memory
            </TabsTrigger>
          </TabsList>

          <TabsContent value="chat" className="mt-6 animate-fade-in">
            <ChatInterface 
              userId={user?.id ?? ""} 
              key={demoMode ? demoConversationId : selectedConversationId} 
              initialConversationId={demoMode ? demoConversationId : selectedConversationId} 
            />
          </TabsContent>

          <TabsContent value="memory" className="mt-6 animate-fade-in">
            <MemoryVault userId={user?.id ?? ""} />
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
