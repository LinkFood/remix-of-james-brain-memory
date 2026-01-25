import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Zap, Search, List, Code, Lightbulb, ArrowRight, Play, Brain } from 'lucide-react';
import { LinkJacLogo } from "@/components/LinkJacLogo";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const faqs = [
  {
    question: "What is LinkJac?",
    answer: "LinkJac is an AI-powered second brain that organizes itself. You paste or type anything — code, ideas, lists, links, notes — and our AI automatically classifies, tags, and scores it by importance. No folders, no manual organization.",
  },
  {
    question: "How does the AI organize my content?",
    answer: "When you dump content, our AI analyzes it to detect the type (code, list, idea, etc.), extract relevant tags, calculate an importance score (1-10), and generate a semantic embedding for smart search. All of this happens in seconds, invisibly.",
  },
  {
    question: "Is my data private and secure?",
    answer: "Absolutely. Your data is encrypted at rest and in transit. We use row-level security so only you can access your content. We never sell your data or use it to train AI models. You own your data, period.",
  },
  {
    question: "Can I export my data?",
    answer: "Yes! You can export your entire brain dump in JSON, CSV, or Markdown format at any time from the Settings page. Your data belongs to you.",
  },
  {
    question: "What file types are supported?",
    answer: "You can paste any text content directly. We also support image uploads which are stored securely. Voice input is available for quick dumps on the go.",
  },
  {
    question: "Is there a mobile app?",
    answer: "LinkJac is a progressive web app (PWA) that works great on mobile browsers. Add it to your home screen for an app-like experience. Native apps are on our roadmap.",
  },
];

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
          <LinkJacLogo size="md" />
          <div className="flex items-center gap-3">
            <Button variant="ghost" onClick={() => navigate('/pricing')} className="hidden sm:inline-flex">
              Pricing
            </Button>
            <Button onClick={() => navigate('/auth')} variant="outline">
              Sign In
            </Button>
          </div>
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
          <div className="flex justify-center">
            <Button
              size="lg"
              onClick={() => navigate('/auth')}
              className="text-lg px-8 py-6 h-auto"
            >
              Get Started Free
              <ArrowRight className="ml-2 w-5 h-5" />
            </Button>
          </div>
        </div>

        {/* How It Works */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-20">
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

        {/* Video Demo Section */}
        <div className="mb-20">
          <div className="text-center mb-8">
            <h2 className="text-2xl font-bold mb-2">See it in action</h2>
            <p className="text-muted-foreground">Watch how LinkJac works in 60 seconds</p>
          </div>
          <Card className="aspect-video max-w-3xl mx-auto overflow-hidden bg-muted/30 border-dashed relative group cursor-pointer">
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-20 h-20 bg-primary rounded-full flex items-center justify-center group-hover:scale-110 transition-transform shadow-lg">
                <Play className="w-8 h-8 text-primary-foreground ml-1" />
              </div>
            </div>
            <div className="absolute bottom-4 left-4 right-4 text-center">
              <p className="text-sm text-muted-foreground">
                Video coming soon — add your YouTube or Loom link here
              </p>
            </div>
          </Card>
        </div>

        {/* What You Can Dump */}
        <div className="mb-20">
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


        {/* FAQ Section */}
        <div className="mb-20 max-w-2xl mx-auto">
          <h2 className="text-2xl font-bold text-center mb-8">Frequently Asked Questions</h2>
          <Accordion type="single" collapsible className="w-full">
            {faqs.map((faq, index) => (
              <AccordionItem key={index} value={`item-${index}`}>
                <AccordionTrigger className="text-left">
                  {faq.question}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  {faq.answer}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>

        {/* CTA */}
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
          <p>© 2026 LinkJac. All rights reserved.</p>
          <div className="flex gap-6">
            <button onClick={() => navigate('/pricing')} className="hover:text-foreground transition-colors">Pricing</button>
            <button onClick={() => navigate('/terms')} className="hover:text-foreground transition-colors">Terms</button>
            <button onClick={() => navigate('/privacy')} className="hover:text-foreground transition-colors">Privacy</button>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Landing;
