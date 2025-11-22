import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Brain, Sparkles } from "lucide-react";

const Landing = () => {
  const navigate = useNavigate();
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [agreedToTracking, setAgreedToTracking] = useState(false);
  const [activeExample, setActiveExample] = useState<number>(0);

  const memoryExamples = [
    {
      id: 0,
      title: "First Conversation (No Memory)",
      context: [],
      userMessage: "I'm working on a new project",
      response: "That's great! What kind of project are you working on? I'd be happy to help with any questions or guidance you need.",
      injectedMemories: 0,
    },
    {
      id: 1,
      title: "Second Conversation (Memory Building)",
      context: ["User is working on a React project", "User prefers TypeScript"],
      userMessage: "How should I structure my components?",
      response: "For your React TypeScript project, I recommend a component-per-file structure with clear separation of concerns. Based on our previous discussion, you might want to use...",
      injectedMemories: 2,
    },
    {
      id: 2,
      title: "Third Conversation (Compounding Intelligence)",
      context: [
        "User is working on a React project",
        "User prefers TypeScript",
        "User is building a dashboard with data visualization",
        "User struggles with state management in large apps",
      ],
      userMessage: "The app is getting complex",
      response: "I remember you're building a React TypeScript dashboard with data visualization. Since you mentioned struggling with state management, let's implement Zustand or React Context for your growing app...",
      injectedMemories: 4,
    },
  ];

  const currentExample = memoryExamples[activeExample];

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!isLogin && !agreedToTracking) {
      toast.error("Please acknowledge that we track your data to build your AI memory");
      return;
    }
    
    setLoading(true);

    try {
      if (isLogin) {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        toast.success("Logged in successfully");
        navigate("/dashboard");
      } else {
        const redirectUrl = `${window.location.origin}/`;
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: redirectUrl,
          },
        });
        if (error) throw error;
        
        if (data.user) {
          try {
            const { error: sampleDataError } = await supabase.functions.invoke('insert-sample-data');
            if (sampleDataError) {
              console.error('Failed to insert sample data:', sampleDataError);
            } else {
              toast.success("Account created with sample conversations!");
            }
          } catch (err) {
            console.error('Error calling insert-sample-data:', err);
            toast.success("Account created! You can now log in.");
          }
        } else {
          toast.success("Account created! You can now log in.");
        }
        
        setIsLogin(true);
      }
    } catch (error: any) {
      toast.error(error.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  // Auto-cycle through examples
  useEffect(() => {
    const interval = setInterval(() => {
      setActiveExample((prev) => (prev + 1) % memoryExamples.length);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="h-screen w-screen overflow-hidden bg-background flex flex-col lg:flex-row">
      {/* Left Panel - Auth & Info */}
      <div className="flex-1 flex flex-col justify-between p-8 lg:p-12 overflow-y-auto">
        <div className="flex-1 flex flex-col justify-center max-w-md mx-auto w-full space-y-8">
          {/* Header */}
          <div className="space-y-4 animate-fade-in">
            <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center shadow-glow">
              <Brain className="w-10 h-10 text-primary" />
            </div>
            <h1 className="text-4xl lg:text-5xl font-bold text-foreground">
              Your AI Remembers You
            </h1>
            <p className="text-lg text-muted-foreground leading-relaxed">
              We store your conversations.<br />
              You own your data.<br />
              AI finally remembers.
            </p>
          </div>

          {/* Auth Form */}
          <form onSubmit={handleAuth} className="space-y-4 animate-fade-in">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
              />
            </div>

            {!isLogin && (
              <div className="flex items-start space-x-3 p-3 bg-primary/5 border border-primary/20 rounded-lg">
                <Checkbox
                  id="tracking-consent"
                  checked={agreedToTracking}
                  onCheckedChange={(checked) => setAgreedToTracking(checked as boolean)}
                  className="mt-1"
                />
                <label
                  htmlFor="tracking-consent"
                  className="text-xs text-foreground leading-relaxed cursor-pointer"
                >
                  I understand my data is stored to build my AI memory. I can export or delete anytime.
                </label>
              </div>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={loading}
            >
              {loading ? "Processing..." : isLogin ? "Sign In" : "Create Account"}
            </Button>

            <button
              type="button"
              onClick={() => setIsLogin(!isLogin)}
              className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {isLogin ? "Need an account? Sign up" : "Already have an account? Sign in"}
            </button>
          </form>
        </div>

        {/* Footer */}
        <div className="mt-8 pt-6 border-t border-border space-y-2 animate-fade-in">
          <p className="text-sm font-medium text-foreground">
            Yes, we store your data — FOR YOU
          </p>
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span>🗄️ You own it</span>
            <span>📦 Export anytime</span>
            <span>🗑️ Delete anytime</span>
          </div>
        </div>
      </div>

      {/* Right Panel - Interactive Demo */}
      <div className="flex-1 bg-muted/30 p-8 lg:p-12 overflow-y-auto border-t lg:border-t-0 lg:border-l border-border">
        <div className="max-w-2xl mx-auto h-full flex flex-col justify-center space-y-6">
          {/* Demo Header */}
          <div className="text-center space-y-2 animate-fade-in">
            <h2 className="text-2xl lg:text-3xl font-bold text-foreground">
              Live Memory Demo
            </h2>
            <p className="text-sm text-muted-foreground">
              Watch how your AI gets smarter with every conversation
            </p>
          </div>

          {/* Example Selector */}
          <div className="flex justify-center gap-2">
            {memoryExamples.map((example) => (
              <button
                key={example.id}
                onClick={() => setActiveExample(example.id)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  activeExample === example.id
                    ? "bg-primary text-primary-foreground shadow-glow"
                    : "bg-background text-muted-foreground hover:text-foreground border border-border"
                }`}
              >
                {example.id === 0 ? "No Memory" : example.id === 1 ? "Building" : "High Context"}
              </button>
            ))}
          </div>

          {/* Demo Card */}
          <div
            key={activeExample}
            className="bg-card border border-border rounded-xl p-6 space-y-4 shadow-glow animate-fade-in"
          >
            {/* Memory Injection Badge */}
            {currentExample.context.length > 0 && (
              <div className="flex items-center gap-2 text-sm font-semibold text-primary">
                <Sparkles className="w-4 h-4" />
                {currentExample.injectedMemories} Relevant Memories Injected
              </div>
            )}

            {/* Context Cards */}
            {currentExample.context.length > 0 ? (
              <div className="grid gap-2">
                {currentExample.context.map((memory, idx) => (
                  <div
                    key={idx}
                    className="p-3 bg-primary/5 border border-primary/20 rounded-lg text-sm text-foreground"
                  >
                    💾 {memory}
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-4 bg-muted/50 border border-border rounded-lg text-center">
                <p className="text-muted-foreground text-sm">
                  No previous context available. Starting fresh.
                </p>
              </div>
            )}

            {/* User Message */}
            <div className="space-y-2">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Your Message
              </div>
              <div className="p-4 bg-secondary/50 border border-border rounded-lg">
                <p className="text-foreground text-sm">{currentExample.userMessage}</p>
              </div>
            </div>

            {/* AI Response */}
            <div className="space-y-2">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                AI Response
              </div>
              <div className="p-4 bg-accent/10 border border-accent/20 rounded-lg">
                <p className="text-foreground text-sm">{currentExample.response}</p>
              </div>
            </div>

            {/* Context Meter */}
            <div className="flex items-center justify-between p-4 bg-primary/5 border border-primary/20 rounded-lg">
              <span className="text-sm font-semibold text-foreground">Context Awareness</span>
              <div className="flex items-center gap-2">
                <div className="flex gap-1">
                  {[...Array(3)].map((_, idx) => (
                    <div
                      key={idx}
                      className={`w-2 h-8 rounded-full transition-all ${
                        idx < currentExample.injectedMemories / 2
                          ? "bg-primary"
                          : "bg-border"
                      }`}
                    />
                  ))}
                </div>
                <span className="text-sm text-primary font-bold">
                  {currentExample.injectedMemories === 0
                    ? "None"
                    : currentExample.injectedMemories < 3
                    ? "Building"
                    : "High"}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Landing;
