import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Brain, MessageSquare, Database, TrendingUp, Share2, Settings } from "lucide-react";
import { Card } from "@/components/ui/card";

interface OnboardingProps {
  userId: string;
}

const Onboarding = ({ userId }: OnboardingProps) => {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    const hasSeenOnboarding = localStorage.getItem(`onboarding-seen-${userId}`);
    if (!hasSeenOnboarding) {
      setOpen(true);
    }
  }, [userId]);

  const handleComplete = () => {
    localStorage.setItem(`onboarding-seen-${userId}`, "true");
    setOpen(false);
  };

  const steps = [
    {
      icon: Brain,
      title: "Welcome to Your AI Memory Vault",
      description: "Store and retrieve your conversations with AI assistants. Every interaction is automatically saved, scored, and made searchable.",
    },
    {
      icon: MessageSquare,
      title: "Chat & Remember",
      description: "Start conversations with multiple AI providers (OpenAI, Anthropic, Google). The AI remembers context from your past conversations automatically.",
    },
    {
      icon: Database,
      title: "Memory Vault",
      description: "Browse all your saved messages, search by content or topic, filter by importance, and export your data anytime. You own your memories.",
    },
    {
      icon: TrendingUp,
      title: "Analytics & Insights",
      description: "Track your AI usage, token consumption, and costs. Generate brain reports to see themes, decisions, and patterns over time.",
    },
    {
      icon: Share2,
      title: "Batch Operations",
      description: "Select multiple conversations to delete or export at once. Manage your data efficiently with bulk actions.",
    },
    {
      icon: Settings,
      title: "Get Started",
      description: "First, add your API keys in Settings. Then start chatting! Sample data is already loaded for you to explore.",
    },
  ];

  const currentStep = steps[step];
  const Icon = currentStep.icon;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="w-6 h-6 text-primary" />
            {currentStep.title}
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4">
          <Card className="p-4 bg-secondary/50 border-primary/20">
            <DialogDescription className="text-base leading-relaxed">
              {currentStep.description}
            </DialogDescription>
          </Card>

          <div className="flex items-center justify-center gap-2">
            {steps.map((_, i) => (
              <div
                key={i}
                className={`h-2 w-2 rounded-full transition-all ${
                  i === step ? "bg-primary w-6" : "bg-muted"
                }`}
              />
            ))}
          </div>

          <div className="flex justify-between gap-2">
            <Button
              variant="outline"
              onClick={() => setStep(Math.max(0, step - 1))}
              disabled={step === 0}
            >
              Previous
            </Button>
            
            {step < steps.length - 1 ? (
              <Button onClick={() => setStep(step + 1)}>
                Next
              </Button>
            ) : (
              <Button onClick={handleComplete} className="bg-primary hover:bg-primary-glow">
                Get Started
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default Onboarding;
