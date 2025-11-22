import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { 
  Brain, Database, Shield, Download, CheckCircle2, 
  Zap, TrendingUp, MessagesSquare, Sparkles 
} from "lucide-react";

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

  return (
    <div className="min-h-screen bg-gradient-bg">
      {/* Hero Section */}
      <section className="container mx-auto px-4 py-16 text-center space-y-6 animate-fade-in">
        <div className="w-20 h-20 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto shadow-glow">
          <Brain className="w-12 h-12 text-primary animate-pulse-glow" />
        </div>
        <h1 className="text-5xl md:text-6xl font-bold text-foreground">
          James Brain OS
        </h1>
        <p className="text-xl md:text-2xl text-muted-foreground max-w-3xl mx-auto">
          Universal AI Memory Shell
        </p>
        <Badge className="bg-primary/10 text-primary border-primary/20 text-lg px-6 py-2">
          Your AI Memory, Across Every Conversation
        </Badge>
      </section>

      {/* The Problem */}
      <section className="container mx-auto px-4 py-16 max-w-6xl">
        <Card className="p-8 bg-card border-border shadow-glow animate-fade-in">
          <div className="flex items-center gap-3 mb-6">
            <MessagesSquare className="w-8 h-8 text-destructive" />
            <h2 className="text-3xl font-bold text-foreground">The Problem: Ephemeral AI</h2>
          </div>
          <div className="space-y-4 text-muted-foreground">
            <p className="text-lg">
              Every time you start a new conversation with ChatGPT, Claude, or Gemini, they forget everything. You repeat yourself endlessly:
            </p>
            <ul className="space-y-2 ml-6 list-disc text-lg">
              <li>"I'm a React developer working on a SaaS dashboard..."</li>
              <li>"Remember, I prefer TypeScript over JavaScript..."</li>
              <li>"As I mentioned before, my app uses Supabase..."</li>
            </ul>
            <p className="text-lg font-semibold text-foreground mt-6">
              Your conversations generate massive value—then vanish. No continuity. No compounding intelligence.
            </p>
          </div>
        </Card>
      </section>

      {/* Interactive Memory Demo */}
      <section className="container mx-auto px-4 py-16 max-w-6xl space-y-6">
        <div className="text-center space-y-2 animate-fade-in">
          <h2 className="text-4xl font-bold text-foreground">See Memory Injection in Action</h2>
          <p className="text-muted-foreground text-lg">
            Watch how your AI gets smarter with every conversation
          </p>
        </div>

        <div className="flex flex-wrap gap-3 justify-center">
          {memoryExamples.map((example) => (
            <Button
              key={example.id}
              variant={activeExample === example.id ? "default" : "outline"}
              onClick={() => setActiveExample(example.id)}
              className="flex items-center gap-2 transition-all hover-scale"
            >
              <Database className="w-4 h-4" />
              {example.title}
            </Button>
          ))}
        </div>

        <Card 
          key={activeExample} 
          className="p-8 bg-card border-border shadow-glow animate-fade-in"
        >
          <div className="space-y-6">
            {currentExample.context.length > 0 && (
              <div className="space-y-3 animate-fade-in">
                <div className="flex items-center gap-2 text-sm font-semibold text-primary animate-scale-in">
                  <Sparkles className="w-4 h-4 animate-pulse" />
                  {currentExample.injectedMemories} Relevant Memories Injected
                </div>
                <div className="grid gap-2">
                  {currentExample.context.map((memory, idx) => (
                    <div
                      key={idx}
                      className="p-3 bg-primary/5 border border-primary/20 rounded-lg text-sm text-foreground hover-scale transition-all opacity-0 animate-fade-in"
                      style={{ 
                        animationDelay: `${idx * 150}ms`,
                        animationFillMode: 'forwards'
                      }}
                    >
                      💾 {memory}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {currentExample.context.length === 0 && (
              <div className="p-4 bg-muted/30 border border-border rounded-lg text-center animate-fade-in">
                <p className="text-muted-foreground text-sm">
                  No previous context available. Starting fresh.
                </p>
              </div>
            )}

            <div className="space-y-2 opacity-0 animate-fade-in" style={{ animationDelay: '200ms', animationFillMode: 'forwards' }}>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Your Message
              </div>
              <div className="p-4 bg-secondary/50 border border-border rounded-lg hover-scale transition-all">
                <p className="text-foreground">{currentExample.userMessage}</p>
              </div>
            </div>

            <div className="space-y-2 opacity-0 animate-fade-in" style={{ animationDelay: '350ms', animationFillMode: 'forwards' }}>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                AI Response
              </div>
              <div className="p-4 bg-accent/10 border border-accent/20 rounded-lg hover-scale transition-all">
                <p className="text-foreground">{currentExample.response}</p>
              </div>
            </div>

            <div className="flex items-center justify-between p-4 bg-primary/5 border border-primary/20 rounded-lg opacity-0 animate-fade-in" style={{ animationDelay: '500ms', animationFillMode: 'forwards' }}>
              <span className="text-sm font-semibold text-foreground">Context Awareness</span>
              <div className="flex items-center gap-2">
                <div className="flex gap-1">
                  {[...Array(3)].map((_, idx) => (
                    <div
                      key={idx}
                      className={`w-2 h-8 rounded-full transition-all duration-500 ${
                        idx < currentExample.injectedMemories / 2
                          ? "bg-primary scale-110"
                          : "bg-border"
                      }`}
                      style={{ 
                        transitionDelay: `${idx * 100}ms`
                      }}
                    />
                  ))}
                </div>
                <span className="text-sm text-primary font-bold animate-scale-in" style={{ animationDelay: '700ms' }}>
                  {currentExample.injectedMemories === 0
                    ? "None"
                    : currentExample.injectedMemories < 3
                    ? "Building"
                    : "High"}
                </span>
              </div>
            </div>
          </div>
        </Card>
      </section>

      {/* Auth + Social Contract Section */}
      <section className="container mx-auto px-4 py-16 max-w-6xl">
        <div className="grid md:grid-cols-2 gap-6">
          {/* Auth Form */}
          <Card className="p-8 bg-card border-border shadow-glow animate-fade-in">
            <div className="flex flex-col items-center mb-8">
              <h2 className="text-3xl font-bold text-foreground">Get Started</h2>
              <p className="text-muted-foreground mt-2">Create your AI memory today</p>
            </div>

            <form onSubmit={handleAuth} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="bg-input border-border focus:ring-primary"
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
                  className="bg-input border-border focus:ring-primary"
                />
              </div>

              {!isLogin && (
                <div className="flex items-start space-x-3 p-4 bg-primary/5 border border-primary/20 rounded-lg">
                  <Checkbox
                    id="tracking-consent"
                    checked={agreedToTracking}
                    onCheckedChange={(checked) => setAgreedToTracking(checked as boolean)}
                    className="mt-1"
                  />
                  <label
                    htmlFor="tracking-consent"
                    className="text-sm text-foreground leading-relaxed cursor-pointer"
                  >
                    I understand that James Brain OS stores my conversations to build my personal AI memory. I have full control to export or delete my data anytime.
                  </label>
                </div>
              )}

              <Button
                type="submit"
                className="w-full bg-primary hover:bg-primary-glow text-primary-foreground font-semibold shadow-glow transition-all"
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
          </Card>

          {/* Social Contract */}
          <Card className="p-8 bg-card border-border shadow-glow flex flex-col animate-fade-in">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center">
                <Database className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h3 className="text-xl font-bold text-foreground">Yes, We Track Your Data</h3>
                <p className="text-sm text-muted-foreground">Here's why that's good</p>
              </div>
            </div>

            <div className="space-y-4 flex-1">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
                <div>
                  <h4 className="font-semibold text-foreground mb-1">Store Every Conversation</h4>
                  <p className="text-sm text-muted-foreground">Build a searchable memory across ALL AI providers—ChatGPT, Claude, Gemini, and more.</p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
                <div>
                  <h4 className="font-semibold text-foreground mb-1">Smarter Conversations</h4>
                  <p className="text-sm text-muted-foreground">Future chats inject relevant context automatically. Your AI remembers what matters.</p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <Shield className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
                <div>
                  <h4 className="font-semibold text-foreground mb-1">You Own Everything</h4>
                  <p className="text-sm text-muted-foreground">Export to JSON, CSV, Excel, or Markdown. Delete permanently with one click.</p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <Download className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
                <div>
                  <h4 className="font-semibold text-foreground mb-1">Import from Anywhere</h4>
                  <p className="text-sm text-muted-foreground">Bring conversations from other platforms. Your data, unified in one place.</p>
                </div>
              </div>
            </div>

            <div className="mt-6 p-4 bg-primary/5 border border-primary/20 rounded-lg">
              <p className="text-sm text-foreground font-medium mb-2">The Difference</p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Big AI companies promise "we don't store your data." We promise "we <span className="text-primary font-semibold">DO</span> store your data... <span className="text-primary font-semibold">for YOU</span>." That's our competitive advantage—and your second brain.
              </p>
            </div>
          </Card>
        </div>
      </section>

      {/* Core Principles */}
      <section className="container mx-auto px-4 py-16 max-w-6xl">
        <div className="text-center mb-12 animate-fade-in">
          <h2 className="text-4xl font-bold text-foreground mb-4">Core Principles</h2>
          <p className="text-muted-foreground text-lg">What makes James Brain OS different</p>
        </div>

        <div className="grid md:grid-cols-2 gap-6 animate-fade-in">
          <Card className="p-6 bg-card border-border shadow-glow hover:shadow-intense transition-all">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center flex-shrink-0">
                <Shield className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-foreground mb-2">User Data Sovereignty</h3>
                <p className="text-muted-foreground text-sm">
                  You own every byte. Export to JSON, CSV, Excel, or Markdown. Delete everything with one click. No lock-in, ever.
                </p>
              </div>
            </div>
          </Card>

          <Card className="p-6 bg-card border-border shadow-glow hover:shadow-intense transition-all">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center flex-shrink-0">
                <Database className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-foreground mb-2">Radical Transparency</h3>
                <p className="text-muted-foreground text-sm">
                  We track everything—and tell you exactly what, when, and why. No hidden algorithms. No surprise data collection.
                </p>
              </div>
            </div>
          </Card>

          <Card className="p-6 bg-card border-border shadow-glow hover:shadow-intense transition-all">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center flex-shrink-0">
                <Zap className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-foreground mb-2">Cross-Platform Memory</h3>
                <p className="text-muted-foreground text-sm">
                  Works with ChatGPT, Claude, Gemini, and any future AI. Your memory layer sits above all providers.
                </p>
              </div>
            </div>
          </Card>

          <Card className="p-6 bg-card border-border shadow-glow hover:shadow-intense transition-all">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center flex-shrink-0">
                <TrendingUp className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-foreground mb-2">Compounding Intelligence</h3>
                <p className="text-muted-foreground text-sm">
                  Every conversation makes the next one smarter. Your AI knowledge base grows more valuable over time.
                </p>
              </div>
            </div>
          </Card>
        </div>
      </section>

      {/* Competitive Moat */}
      <section className="container mx-auto px-4 py-16 max-w-6xl">
        <Card className="p-8 bg-gradient-primary border-primary/20 shadow-intense animate-fade-in">
          <div className="space-y-4">
            <h2 className="text-3xl font-bold text-primary-foreground">Why The Big Players Can't Do This</h2>
            <p className="text-primary-foreground/90 text-lg">
              ChatGPT, Claude, and Gemini promise "we don't store your data" because that's their business model. They can't pivot to storing comprehensive user histories without breaking their privacy promises.
            </p>
            <p className="text-primary-foreground/90 text-lg font-semibold">
              We promise "we DO store your data... for YOU." That's our competitive advantage.
            </p>
            <div className="grid md:grid-cols-2 gap-4 mt-6">
              <div className="p-4 bg-primary-foreground/10 rounded-lg">
                <p className="text-primary-foreground font-semibold mb-2">❌ Big AI Companies</p>
                <p className="text-primary-foreground/80 text-sm">
                  Ephemeral sessions • Start over every time • No cross-platform memory • Privacy as limitation
                </p>
              </div>
              <div className="p-4 bg-primary-foreground/10 rounded-lg">
                <p className="text-primary-foreground font-semibold mb-2">✅ James Brain OS</p>
                <p className="text-primary-foreground/80 text-sm">
                  Persistent memory • Compounding intelligence • Universal compatibility • Privacy as feature
                </p>
              </div>
            </div>
          </div>
        </Card>
      </section>

      {/* Footer */}
      <footer className="border-t border-border bg-card/50 backdrop-blur-sm mt-20">
        <div className="container mx-auto px-4 py-8 text-center text-muted-foreground text-sm">
          <p>James Brain OS - Universal AI Memory Shell</p>
          <p className="mt-2">Your data. Your control. Your brain.</p>
        </div>
      </footer>
    </div>
  );
};

export default Landing;
