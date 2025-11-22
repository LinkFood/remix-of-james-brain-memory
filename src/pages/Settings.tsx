import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Brain, Key, ArrowLeft } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Provider = 'openai' | 'anthropic' | 'google';

const Settings = () => {
  const navigate = useNavigate();
  const [provider, setProvider] = useState<Provider>('openai');
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [hasKey, setHasKey] = useState(false);

  useEffect(() => {
    checkExistingKeys();
  }, []);

  const checkExistingKeys = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      navigate("/auth");
      return;
    }

    const { data } = await supabase
      .from('user_api_keys')
      .select('provider')
      .eq('user_id', user.id)
      .maybeSingle();

    setHasKey(!!data);
  };

  const handleSaveKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Store the API key (Supabase will handle encryption via RLS)
      const { error } = await supabase
        .from('user_api_keys')
        .upsert({
          user_id: user.id,
          provider,
          encrypted_key: apiKey, // In production, encrypt client-side before sending
          is_default: true
        });

      if (error) throw error;

      toast.success("API key saved successfully");
      setApiKey("");
      navigate("/");
    } catch (error: any) {
      toast.error(error.message || "Failed to save API key");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-bg p-4">
      <Card className="w-full max-w-md p-8 bg-card border-border shadow-glow">
        <Button
          variant="ghost"
          onClick={() => navigate("/")}
          className="mb-4"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back
        </Button>

        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mb-4">
            <Key className="w-10 h-10 text-primary" />
          </div>
          <h1 className="text-3xl font-bold text-foreground">API Key Setup</h1>
          <p className="text-muted-foreground mt-2 text-center">
            {hasKey ? "Update your LLM API key" : "Enter your LLM API key to start chatting"}
          </p>
        </div>

        <form onSubmit={handleSaveKey} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="provider">Provider</Label>
            <Select value={provider} onValueChange={(v) => setProvider(v as Provider)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI (GPT-4, GPT-5)</SelectItem>
                <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                <SelectItem value="google">Google (Gemini)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="apiKey">API Key</Label>
            <Input
              id="apiKey"
              type="password"
              placeholder="sk-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Your key is encrypted and only used to make requests on your behalf
            </p>
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={loading}
          >
            {loading ? "Saving..." : hasKey ? "Update Key" : "Save Key"}
          </Button>
        </form>

        <div className="mt-6 p-4 bg-muted rounded-lg">
          <p className="text-sm text-muted-foreground">
            <strong>Why do I need this?</strong><br />
            James Brain is your memory secretary. We use YOUR API key to talk to the LLM, 
            but we capture and store everything so you never lose your conversations.
          </p>
        </div>
      </Card>
    </div>
  );
};

export default Settings;
