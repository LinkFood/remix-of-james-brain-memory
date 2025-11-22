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
      title: "Your AI Memory. Your Data. Your Control.",
      description: "James Brain OS is the missing layer between you and every AI you talk to. We capture, score, and store your conversations—creating a persistent memory that makes every chat smarter by learning from all your past interactions.",
    },
    {
      icon: MessageSquare,
      title: "Cross-Platform, Compounding Intelligence",
      description: "Chat with OpenAI, Anthropic, Google, or any LLM through one interface. Your context travels with you—switch providers anytime while keeping your memory intact. Every conversation compounds into one unified brain.",
    },
    {
      icon: Database,
      title: "You Own Your Data (For Real)",
      description: "Unlike ChatGPT or Claude, YOU control everything. Export your entire history in any format. Delete it permanently with one click. Import chats from other platforms. It's your data—stored for you, not mined by us.",
    },
    {
      icon: TrendingUp,
      title: "Smart Memory Injection",
      description: "High-importance memories are automatically injected into future conversations. The AI sees relevant context from weeks or months ago, making every response more personalized and accurate over time.",
    },
    {
      icon: Share2,
      title: "Radical Transparency",
      description: "We tell you exactly what we're doing: every message captured, every memory scored, every context injected. No hidden data mining, no selling your conversations, no training proprietary models on your data.",
    },
    {
      icon: Settings,
      title: "Ready to Build Your Brain?",
      description: "Add your API key in Settings to start. Your conversations become a valuable, portable dataset that makes AI work better for YOU. Think of it as a USB drive of years of AI chats—except it actually makes the AI smarter.",
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
