import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Brain, Zap, Search, List, Code, Lightbulb, ArrowRight } from 'lucide-react';

const Landing = () => {
  const navigate = useNavigate();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        navigate('/dashboard');
      }
    });
  }, [navigate]);

  return (
    <div className="min-h-screen bg-gradient-bg">
      {/* Header */}
      <header className="border-b border-border/50 px-4 sm:px-6 py-4 bg-background/80 backdrop-blur-xl">
        <div className="max-w-5xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 bg-primary/10 rounded-lg flex items-center justify-center">
              <Brain className="w-5 h-5 text-primary" />
            </div>
            <span className="text-lg font-bold">Brain Dump</span>
          </div>
          <Button onClick={() => navigate('/auth')} variant="outline">
            Sign In
          </Button>
        </div>
      </header>

      {/* Hero Section */}
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-16 sm:py-24">
        <div className="text-center mb-16">
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight mb-6">
            Stop organizing.
            <br />
            <span className="text-primary">Start dumping.</span>
          </h1>
          <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-8">
            One input. Dump anything. AI organizes automatically.
            <br className="hidden sm:block" />
            Your second brain that actually works.
          </p>
          <Button
            size="lg"
            onClick={() => navigate('/auth')}
            className="text-lg px-8 py-6 h-auto"
          >
            Get Started Free
            <ArrowRight className="ml-2 w-5 h-5" />
          </Button>
        </div>

        {/* How It Works */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16">
          <Card className="p-6 text-center">
            <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mx-auto mb-4">
              <Zap className="w-6 h-6 text-primary" />
            </div>
            <h3 className="font-semibold text-lg mb-2">1. Dump Anything</h3>
            <p className="text-sm text-muted-foreground">
              Code, ideas, lists, links, notes - paste anything into one simple input.
            </p>
          </Card>

          <Card className="p-6 text-center">
            <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mx-auto mb-4">
              <Brain className="w-6 h-6 text-primary" />
            </div>
            <h3 className="font-semibold text-lg mb-2">2. AI Organizes</h3>
            <p className="text-sm text-muted-foreground">
              Automatic classification, tagging, and importance scoring. No folders. No questions.
            </p>
          </Card>

          <Card className="p-6 text-center">
            <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mx-auto mb-4">
              <Search className="w-6 h-6 text-primary" />
            </div>
            <h3 className="font-semibold text-lg mb-2">3. Ask & Find</h3>
            <p className="text-sm text-muted-foreground">
              Your AI assistant knows everything you've dumped. Just ask.
            </p>
          </Card>
        </div>

        {/* What You Can Dump */}
        <div className="mb-16">
          <h2 className="text-2xl font-bold text-center mb-8">Dump Anything</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Card className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/10">
                <Code className="w-5 h-5 text-purple-500" />
              </div>
              <span className="font-medium">Code</span>
            </Card>
            <Card className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <List className="w-5 h-5 text-blue-500" />
              </div>
              <span className="font-medium">Lists</span>
            </Card>
            <Card className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-yellow-500/10">
                <Lightbulb className="w-5 h-5 text-yellow-500" />
              </div>
              <span className="font-medium">Ideas</span>
            </Card>
            <Card className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/10">
                <Brain className="w-5 h-5 text-green-500" />
              </div>
              <span className="font-medium">Notes</span>
            </Card>
          </div>
        </div>

        {/* Demo Input */}
        <Card className="p-8 text-center bg-muted/30 border-dashed">
          <p className="text-muted-foreground mb-4">
            No databases. No templates. No organizing.
            <br />
            Just dump and let AI handle the rest.
          </p>
          <Button
            size="lg"
            onClick={() => navigate('/auth')}
          >
            Try It Now
            <ArrowRight className="ml-2 w-4 h-4" />
          </Button>
        </Card>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/50 py-8 px-4">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4 text-sm text-muted-foreground">
          <p>© 2026 Brain Dump. All rights reserved.</p>
          <div className="flex gap-6">
            <button onClick={() => navigate('/terms')} className="hover:text-foreground transition-colors">Terms</button>
            <button onClick={() => navigate('/privacy')} className="hover:text-foreground transition-colors">Privacy</button>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Landing;
