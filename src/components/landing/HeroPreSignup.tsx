import { Button } from "@/components/ui/button";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Card } from "@/components/ui/card";

interface HeroPreSignupProps {
  onContinue: () => void;
  onBack: () => void;
}

export const HeroPreSignup = ({ onContinue, onBack }: HeroPreSignupProps) => {
  return (
    <div className="h-full flex flex-col items-center justify-center p-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="absolute top-4 left-4"
      >
        <ArrowLeft className="h-4 w-4 mr-2" />
        Back
      </Button>

      <div className="max-w-lg w-full space-y-6">
        <div className="text-center space-y-2">
          <h2 className="text-3xl font-bold">Before You Sign Up</h2>
          <p className="text-muted-foreground">
            Here's what you need to know about James Brain
          </p>
        </div>

        <Card className="p-6 space-y-4">
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <span className="text-2xl">🔑</span>
              <div>
                <h3 className="font-semibold mb-1">James Brain uses YOUR API keys</h3>
                <p className="text-sm text-muted-foreground">
                  You maintain full control. Your conversations stay private and are never used to train models.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <span className="text-2xl">🎁</span>
              <div>
                <h3 className="font-semibold mb-1">Demo mode uses Lovable AI (free)</h3>
                <p className="text-sm text-muted-foreground">
                  What you just experienced was powered by our demo AI. After signup, you'll use your own keys.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <span className="text-2xl">🔌</span>
              <div>
                <h3 className="font-semibold mb-1">Connect OpenAI, Claude, or Google</h3>
                <p className="text-sm text-muted-foreground">
                  After signup, paste your API key from any provider. James Brain works with all of them.
                </p>
              </div>
            </div>
          </div>

          <div className="pt-4 border-t space-y-2">
            <p className="text-sm font-medium">Get your API keys here:</p>
            <div className="flex flex-col gap-2">
              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline flex items-center gap-2"
              >
                OpenAI API Keys <ExternalLink className="h-3 w-3" />
              </a>
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline flex items-center gap-2"
              >
                Anthropic (Claude) API Keys <ExternalLink className="h-3 w-3" />
              </a>
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline flex items-center gap-2"
              >
                Google AI Studio API Keys <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        </Card>

        <Button onClick={onContinue} size="lg" className="w-full">
          Continue to Sign Up
        </Button>
      </div>
    </div>
  );
};
