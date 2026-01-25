import { useState } from "react";
import { Brain, Zap, Search, Shield, ArrowRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";

interface OnboardingModalProps {
  open: boolean;
  onComplete: () => void;
}

const steps = [
  {
    icon: Brain,
    title: "Welcome to Brain Dump",
    description: "Your AI-powered second brain that organizes itself. No folders, no structure, no friction.",
  },
  {
    icon: Zap,
    title: "Just Dump Anything",
    description: "Paste code, ideas, lists, links — literally anything. One input, zero decisions.",
  },
  {
    icon: Search,
    title: "AI Does the Work",
    description: "Automatic classification, tagging, and importance scoring. Ask the assistant anything about your brain.",
  },
  {
    icon: Shield,
    title: "Your Data, Your Control",
    description: "Export anytime. Delete anytime. We never sell your data. Ever.",
  },
];

export function OnboardingModal({ open, onComplete }: OnboardingModalProps) {
  const [currentStep, setCurrentStep] = useState(0);

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      onComplete();
    }
  };

  const handleSkip = () => {
    onComplete();
  };

  const step = steps[currentStep];
  const Icon = step.icon;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onComplete()}>
      <DialogContent className="sm:max-w-md p-0 gap-0 overflow-hidden">
        <div className="relative">
          {/* Skip button */}
          <Button
            variant="ghost"
            size="sm"
            className="absolute top-4 right-4 text-muted-foreground hover:text-foreground z-10"
            onClick={handleSkip}
          >
            <X className="w-4 h-4" />
          </Button>

          {/* Content */}
          <div className="p-8 text-center">
            {/* Icon */}
            <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-6">
              <Icon className="w-8 h-8 text-primary" />
            </div>

            {/* Text */}
            <h2 className="text-xl font-bold mb-3">{step.title}</h2>
            <p className="text-muted-foreground text-sm leading-relaxed mb-8">
              {step.description}
            </p>

            {/* Progress dots */}
            <div className="flex justify-center gap-2 mb-6">
              {steps.map((_, index) => (
                <div
                  key={index}
                  className={`w-2 h-2 rounded-full transition-colors ${
                    index === currentStep ? "bg-primary" : "bg-muted"
                  }`}
                />
              ))}
            </div>

            {/* Action button */}
            <Button onClick={handleNext} className="w-full">
              {currentStep === steps.length - 1 ? (
                "Get Started"
              ) : (
                <>
                  Next
                  <ArrowRight className="w-4 h-4 ml-2" />
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default OnboardingModal;
