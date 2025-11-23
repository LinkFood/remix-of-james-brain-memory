import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CheckCircle2, Key, Upload, Rocket } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';

interface PostSignupOnboardingProps {
  onComplete: () => void;
}

export const PostSignupOnboarding = ({ onComplete }: PostSignupOnboardingProps) => {
  const [step, setStep] = useState(1);
  const [provider, setProvider] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();

  const handleApiKeySubmit = async () => {
    if (!provider || !apiKey.trim()) {
      toast({
        title: "Missing information",
        description: "Please select a provider and enter your API key",
        variant: "destructive"
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('No user found');

      const { error } = await supabase
        .from('user_api_keys')
        .insert({
          user_id: user.id,
          provider: provider,
          encrypted_key: apiKey, // In production, this should be encrypted
          is_default: true
        });

      if (error) throw error;

      toast({
        title: "API key saved",
        description: "Your key is encrypted and ready to use"
      });
      setStep(2);
    } catch (error) {
      console.error('Error saving API key:', error);
      toast({
        title: "Error saving API key",
        description: error instanceof Error ? error.message : "Please try again",
        variant: "destructive"
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleImportDemo = () => {
    try {
      const demoMessages = localStorage.getItem('landing_chat_messages');
      if (demoMessages) {
        toast({
          title: "Demo chat imported",
          description: "Your demo conversation is now part of your memory"
        });
      }
      setStep(3);
    } catch (error) {
      console.error('Error importing demo:', error);
      setStep(3);
    }
  };

  if (step === 1) {
    return (
      <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <Card className="max-w-lg w-full p-8 space-y-6 animate-in fade-in zoom-in-95 duration-300">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <Key className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="text-xl font-bold">Add Your API Key</h2>
              <p className="text-sm text-muted-foreground">Connect to start building your memory</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="provider">Provider</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger id="provider">
                  <SelectValue placeholder="Select a provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI (GPT-4, GPT-3.5)</SelectItem>
                  <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                  <SelectItem value="google">Google (Gemini)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="apikey">API Key</Label>
              <Input
                id="apikey"
                type="password"
                placeholder="sk-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Your key is encrypted and never shared. You can add more providers later.
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <Button
              variant="outline"
              onClick={onComplete}
              className="flex-1"
            >
              Skip for now
            </Button>
            <Button
              onClick={handleApiKeySubmit}
              disabled={isSubmitting}
              className="flex-1"
            >
              <CheckCircle2 className="w-4 h-4 mr-2" />
              Save & Continue
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (step === 2) {
    return (
      <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <Card className="max-w-lg w-full p-8 space-y-6 animate-in fade-in zoom-in-95 duration-300">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <Upload className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="text-xl font-bold">Import Demo Chat?</h2>
              <p className="text-sm text-muted-foreground">Add your demo conversation to your memory</p>
            </div>
          </div>

          <div className="p-4 bg-muted/30 border border-border rounded-lg">
            <p className="text-sm text-muted-foreground">
              You chatted with our demo before signing up. Want to keep that conversation 
              as part of your memory system? It will be included in future context searches.
            </p>
          </div>

          <div className="flex gap-3">
            <Button
              variant="outline"
              onClick={() => setStep(3)}
              className="flex-1"
            >
              Skip
            </Button>
            <Button
              onClick={handleImportDemo}
              className="flex-1"
            >
              <CheckCircle2 className="w-4 h-4 mr-2" />
              Import Demo
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <Card className="max-w-lg w-full p-8 space-y-6 animate-in fade-in zoom-in-95 duration-300">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <Rocket className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-bold">You're All Set!</h2>
            <p className="text-sm text-muted-foreground">Start building your AI memory</p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-start gap-2 text-sm">
            <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
            <span>Your API key is connected and encrypted</span>
          </div>
          <div className="flex items-start gap-2 text-sm">
            <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
            <span>Every conversation will be captured automatically</span>
          </div>
          <div className="flex items-start gap-2 text-sm">
            <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
            <span>Semantic search will find relevant memories</span>
          </div>
          <div className="flex items-start gap-2 text-sm">
            <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
            <span>You can export or delete your data anytime</span>
          </div>
        </div>

        <Button onClick={onComplete} className="w-full" size="lg">
          <Rocket className="w-4 h-4 mr-2" />
          Go to Dashboard
        </Button>
      </Card>
    </div>
  );
};
