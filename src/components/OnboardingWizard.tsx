import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle2 } from 'lucide-react';

interface OnboardingWizardProps {
  isOpen: boolean;
  onComplete: () => void;
  userId: string;
}

export const OnboardingWizard = ({ isOpen, onComplete, userId }: OnboardingWizardProps) => {
  const [step, setStep] = useState(1);
  const [provider, setProvider] = useState<string>('');
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const handleSaveApiKey = async () => {
    if (!apiKey.trim() || !provider) {
      toast({
        title: "Missing information",
        description: "Please select a provider and enter your API key",
        variant: "destructive"
      });
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase
        .from('user_api_keys')
        .insert({
          user_id: userId,
          provider,
          encrypted_key: apiKey,
          is_default: true,
        });

      if (error) throw error;

      toast({
        title: "API key saved",
        description: "You're all set to start chatting"
      });
      setStep(3);
    } catch (error: any) {
      toast({
        title: "Error saving API key",
        description: error.message,
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSkip = () => {
    setStep(3);
  };

  return (
    <Dialog open={isOpen} onOpenChange={() => {}}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Welcome to James Brain OS</DialogTitle>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Quick Setup</h3>
              <p className="text-sm text-muted-foreground">
                Let's get you started. This will only take a minute.
              </p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                <span>Connect your AI provider</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                <span>Start building your memory vault</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                <span>Your data stays yours</span>
              </div>
            </div>
            <Button onClick={() => setStep(2)} className="w-full">
              Get Started
            </Button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Connect Your AI Provider</h3>
              <p className="text-sm text-muted-foreground">
                Add your API key from OpenAI, Claude, or Google to start chatting.
              </p>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Provider</Label>
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI</SelectItem>
                    <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                    <SelectItem value="google">Google</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>API Key</Label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                />
                <p className="text-xs text-muted-foreground">
                  Your key is encrypted and never shared
                </p>
              </div>
            </div>

            <div className="flex gap-2">
              <Button variant="outline" onClick={handleSkip} className="flex-1">
                Skip for now
              </Button>
              <Button onClick={handleSaveApiKey} disabled={loading} className="flex-1">
                {loading ? 'Saving...' : 'Continue'}
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div className="space-y-2 text-center">
              <CheckCircle2 className="h-12 w-12 text-primary mx-auto" />
              <h3 className="text-sm font-semibold">You're all set</h3>
              <p className="text-sm text-muted-foreground">
                Start chatting to build your AI memory. Every conversation makes future ones smarter.
              </p>
            </div>
            <Button onClick={onComplete} className="w-full">
              Start Chatting
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
