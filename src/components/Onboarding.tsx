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
      title: "Welcome to Brain Dump",
      description: "Your second brain that actually works. Dump anything — ideas, code, lists, links — and let AI organize it all. No folders. No friction. Just dump.",
    },
    {
      icon: MessageSquare,
      title: "Just Dump It",
      description: "Paste code snippets, shopping lists, random thoughts, or URLs. One input handles everything. The AI figures out what it is and files it away.",
    },
    {
      icon: Database,
      title: "AI Does the Work",
      description: "Every dump is automatically classified, tagged, and scored by importance. No manual organization needed — your brain grows smarter on its own.",
    },
    {
      icon: TrendingUp,
      title: "Ask Your Brain",
      description: "Need something you dumped weeks ago? Just ask. Your AI assistant searches your entire brain and retrieves exactly what you need.",
    },
    {
      icon: Share2,
      title: "You Own Your Data",
      description: "Export everything anytime. Delete it permanently with one click. Your brain, your rules. We store it for you, not for us.",
    },
    {
      icon: Settings,
      title: "Ready to Start?",
      description: "Your first dump is waiting. No API keys needed. No setup required. Just start dumping and watch your second brain come to life.",
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
