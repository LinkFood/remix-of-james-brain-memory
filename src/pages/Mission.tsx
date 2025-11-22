import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Brain, ArrowLeft, Zap, Database, Shield, TrendingUp, MessagesSquare, Sparkles } from "lucide-react";

const Mission = () => {
  const navigate = useNavigate();
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

  return (
    <div className="min-h-screen bg-gradient-bg">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <Button
            variant="ghost"
            onClick={() => navigate("/auth")}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center">
              <Brain className="w-6 h-6 text-primary" />
            </div>
            <h1 className="text-xl font-bold text-foreground">James Brain OS</h1>
          </div>
          <div className="w-20" /> {/* Spacer for centering */}
        </div>
      </header>

      <div className="container mx-auto px-4 py-12 max-w-6xl space-y-16">
        {/* Hero Section */}
        <div className="text-center space-y-4 animate-fade-in">
          <Badge className="bg-primary/10 text-primary border-primary/20">Our Mission</Badge>
          <h2 className="text-4xl md:text-5xl font-bold text-foreground">
            Your AI Memory,
            <br />
            <span className="text-primary">Across Every Conversation</span>
          </h2>
          <p className="text-xl text-muted-foreground max-w-3xl mx-auto">
            We're building what the big AI companies can't: a universal memory layer that makes every conversation smarter by learning from all your previous interactions.
          </p>
        </div>

        {/* The Problem */}
        <Card className="p-8 bg-card border-border shadow-glow animate-fade-in">
          <div className="flex items-center gap-3 mb-6">
            <MessagesSquare className="w-8 h-8 text-destructive" />
            <h3 className="text-2xl font-bold text-foreground">The Problem: Ephemeral AI</h3>
          </div>
          <div className="space-y-4 text-muted-foreground">
            <p className="text-lg">
              Every time you start a new conversation with ChatGPT, Claude, or Gemini, they forget everything. You repeat yourself endlessly:
            </p>
            <ul className="space-y-2 ml-6 list-disc">
              <li>"I'm a React developer working on a SaaS dashboard..."</li>
              <li>"Remember, I prefer TypeScript over JavaScript..."</li>
              <li>"As I mentioned before, my app uses Supabase..."</li>
            </ul>
            <p className="text-lg font-semibold text-foreground mt-6">
              Your conversations generate massive value—then vanish. No continuity. No compounding intelligence.
            </p>
          </div>
        </Card>

        {/* Interactive Memory Injection Demo */}
        <div className="space-y-6 animate-fade-in">
          <div className="text-center space-y-2">
            <h3 className="text-3xl font-bold text-foreground">See Memory Injection in Action</h3>
            <p className="text-muted-foreground">
              Watch how your AI gets smarter with every conversation
            </p>
          </div>

          {/* Example Selector */}
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

          {/* Memory Visualization */}
          <Card 
            key={activeExample} 
            className="p-8 bg-card border-border shadow-glow animate-fade-in"
          >
            <div className="space-y-6">
              {/* Context Being Injected */}
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

              {/* User Message */}
              <div className="space-y-2 opacity-0 animate-fade-in" style={{ animationDelay: '200ms', animationFillMode: 'forwards' }}>
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Your Message
                </div>
                <div className="p-4 bg-secondary/50 border border-border rounded-lg hover-scale transition-all">
                  <p className="text-foreground">{currentExample.userMessage}</p>
                </div>
              </div>

              {/* AI Response */}
              <div className="space-y-2 opacity-0 animate-fade-in" style={{ animationDelay: '350ms', animationFillMode: 'forwards' }}>
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  AI Response
                </div>
                <div className="p-4 bg-accent/10 border border-accent/20 rounded-lg hover-scale transition-all">
                  <p className="text-foreground">{currentExample.response}</p>
                </div>
              </div>

              {/* Intelligence Indicator */}
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
        </div>

        {/* Core Principles */}
        <div className="grid md:grid-cols-2 gap-6 animate-fade-in">
          <Card className="p-6 bg-card border-border shadow-glow hover:shadow-intense transition-all">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center flex-shrink-0">
                <Shield className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h4 className="text-lg font-bold text-foreground mb-2">User Data Sovereignty</h4>
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
                <h4 className="text-lg font-bold text-foreground mb-2">Radical Transparency</h4>
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
                <h4 className="text-lg font-bold text-foreground mb-2">Cross-Platform Memory</h4>
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
                <h4 className="text-lg font-bold text-foreground mb-2">Compounding Intelligence</h4>
                <p className="text-muted-foreground text-sm">
                  Every conversation makes the next one smarter. Your AI knowledge base grows more valuable over time.
                </p>
              </div>
            </div>
          </Card>
        </div>

        {/* The Competitive Moat */}
        <Card className="p-8 bg-gradient-primary border-primary/20 shadow-intense animate-fade-in">
          <div className="space-y-4">
            <h3 className="text-2xl font-bold text-primary-foreground">Why The Big Players Can't Do This</h3>
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

        {/* CTA */}
        <div className="text-center space-y-6 animate-fade-in">
          <h3 className="text-3xl font-bold text-foreground">Ready to Own Your AI Memory?</h3>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            Join the revolution in AI data ownership. Start building your personal AI memory that gets smarter with every conversation.
          </p>
          <Button
            size="lg"
            onClick={() => navigate("/auth")}
            className="bg-primary hover:bg-primary-glow text-primary-foreground font-semibold shadow-glow"
          >
            Create Your Account
          </Button>
        </div>
      </div>

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

export default Mission;
