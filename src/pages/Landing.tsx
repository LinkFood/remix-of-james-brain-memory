import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Bot, Zap, Brain, Clock } from "lucide-react";

const Landing = () => {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <div className="mb-6 flex items-center gap-3">
          <Bot className="h-12 w-12 text-primary" />
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight">
            Link<span className="text-primary">Jac</span>
          </h1>
        </div>

        <p className="text-xl md:text-2xl text-muted-foreground max-w-2xl mb-4">
          Your Personal AI Agent Swarm
        </p>
        <p className="text-base text-muted-foreground max-w-lg mb-12">
          Dump your thoughts. Dispatch agents. Get results — 24/7, from anywhere.
        </p>

        {/* Value Props */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-3xl mb-16">
          <div className="flex flex-col items-center gap-3">
            <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <Zap className="h-6 w-6 text-primary" />
            </div>
            <h3 className="font-semibold">Dispatch Agents</h3>
            <p className="text-sm text-muted-foreground">
              Tell JAC what you need. Research, save, search — agents handle it.
            </p>
          </div>
          <div className="flex flex-col items-center gap-3">
            <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <Clock className="h-6 w-6 text-primary" />
            </div>
            <h3 className="font-semibold">24/7 Async</h3>
            <p className="text-sm text-muted-foreground">
              Agents work while you sleep. Come back to results, not waiting.
            </p>
          </div>
          <div className="flex flex-col items-center gap-3">
            <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <Brain className="h-6 w-6 text-primary" />
            </div>
            <h3 className="font-semibold">Brain Memory</h3>
            <p className="text-sm text-muted-foreground">
              Everything saves to your brain. Agents learn from your history.
            </p>
          </div>
        </div>

        <Link to="/auth">
          <Button size="lg" className="text-lg px-8 py-6">
            Get Started
          </Button>
        </Link>
      </main>

      {/* Footer */}
      <footer className="py-6 px-6 flex items-center justify-center gap-6 text-sm text-muted-foreground">
        <Link to="/terms" className="hover:text-foreground transition-colors">Terms</Link>
        <Link to="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
      </footer>
    </div>
  );
};

export default Landing;
