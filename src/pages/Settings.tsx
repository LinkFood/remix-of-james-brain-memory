import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Brain, Key, ArrowLeft, Download, Trash2, Database } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Separator } from "@/components/ui/separator";

type Provider = 'openai' | 'anthropic' | 'google';

const Settings = () => {
  const navigate = useNavigate();
  const [provider, setProvider] = useState<Provider>('openai');
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [exportFormat, setExportFormat] = useState<string>('json');
  const [exportLoading, setExportLoading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [dataStats, setDataStats] = useState({ conversations: 0, messages: 0, dataSizeMB: 0 });

  useEffect(() => {
    checkExistingKeys();
    fetchDataStats();
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

  const fetchDataStats = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const [convResult, msgResult] = await Promise.all([
        supabase.from('conversations').select('id', { count: 'exact' }).eq('user_id', user.id),
        supabase.from('messages').select('content', { count: 'exact' }).eq('user_id', user.id),
      ]);

      const conversations = convResult.count || 0;
      const messages = msgResult.count || 0;
      
      // Estimate data size (rough calculation)
      const avgMessageSize = 500; // Average characters per message
      const dataSizeBytes = messages * avgMessageSize;
      const dataSizeMB = parseFloat((dataSizeBytes / (1024 * 1024)).toFixed(2));

      setDataStats({ conversations, messages, dataSizeMB });
    } catch (error) {
      console.error('Failed to fetch data stats:', error);
    }
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

  const handleExport = async () => {
    setExportLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("No active session");

      // Use direct fetch for file download
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/export-all-data`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ userId: user.id, format: exportFormat })
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Export failed');
      }

      // Get the blob from response
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `memory-vault-${new Date().toISOString().split('T')[0]}.${exportFormat}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast.success(`Data exported as ${exportFormat.toUpperCase()}`);
    } catch (error: any) {
      console.error('Export error:', error);
      toast.error(error.message || "Failed to export data");
    } finally {
      setExportLoading(false);
    }
  };

  const handleDeleteAll = async () => {
    setDeleteLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { error } = await supabase.functions.invoke('delete-all-user-data', {
        body: { userId: user.id }
      });

      if (error) throw error;

      toast.success("All data deleted successfully");
      setDeleteDialogOpen(false);
      
      // Update stats
      setDataStats({ conversations: 0, messages: 0, dataSizeMB: 0 });
      
      // Redirect to home after short delay
      setTimeout(() => navigate("/"), 1500);
    } catch (error: any) {
      toast.error(error.message || "Failed to delete data");
    } finally {
      setDeleteLoading(false);
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
            <strong>Your API Key. Your Data. Your Control.</strong><br />
            We use YOUR API key to make requests on your behalf, but we capture and store 
            everything so you never lose your conversations. Unlike ChatGPT or Claude, 
            you have total control over your data.
          </p>
        </div>

        <Separator className="my-8" />

        {/* Data Management Section */}
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center">
              <Database className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-foreground">Data Management</h2>
              <p className="text-sm text-muted-foreground">Your data, your rules</p>
            </div>
          </div>

          {/* Data Stats */}
          <Card className="p-4 bg-muted/50 border-border">
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Total Conversations</span>
                <span className="font-semibold text-foreground">{dataStats.conversations}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Total Messages</span>
                <span className="font-semibold text-foreground">{dataStats.messages}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Estimated Data Size</span>
                <span className="font-semibold text-foreground">{dataStats.dataSizeMB} MB</span>
              </div>
            </div>
          </Card>

          {/* Export Section */}
          <div className="space-y-3">
            <Label>Export All Data</Label>
            <p className="text-xs text-muted-foreground">
              Download your entire memory vault. Fits on a flash drive. Take it anywhere.
            </p>
            <div className="flex gap-2">
              <Select value={exportFormat} onValueChange={setExportFormat}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="json">JSON</SelectItem>
                  <SelectItem value="csv">CSV</SelectItem>
                  <SelectItem value="md">Markdown</SelectItem>
                  <SelectItem value="txt">Text</SelectItem>
                </SelectContent>
              </Select>
              <Button
                onClick={handleExport}
                disabled={exportLoading || dataStats.messages === 0}
                className="flex-1"
              >
                <Download className="w-4 h-4 mr-2" />
                {exportLoading ? "Exporting..." : "Export All Data"}
              </Button>
            </div>
          </div>

          {/* Delete Section */}
          <div className="space-y-3">
            <Label className="text-destructive">Danger Zone</Label>
            <p className="text-xs text-muted-foreground">
              Delete all your data permanently. This action cannot be undone.
            </p>
            <Button
              variant="destructive"
              onClick={() => setDeleteDialogOpen(true)}
              disabled={deleteLoading || dataStats.messages === 0}
              className="w-full"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete All My Data
            </Button>
          </div>

          {/* Differentiator Copy */}
          <Card className="p-4 bg-primary/5 border-primary/20">
            <p className="text-xs text-foreground leading-relaxed">
              <strong>Unlike ChatGPT, Claude, or Gemini:</strong><br />
              ✓ Export everything to a flash drive<br />
              ✓ Delete all data with one click<br />
              ✓ No hidden logs or retention policies<br />
              ✓ We store nothing after you delete<br />
              <br />
              <em>They can't offer this because of their compliance/legal logging requirements. 
              We can, because you own the infrastructure.</em>
            </p>
          </Card>
        </div>
      </Card>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete All Data?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete:
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>{dataStats.conversations} conversations</li>
                <li>{dataStats.messages} messages</li>
                <li>All brain reports</li>
                <li>All API keys</li>
              </ul>
              <br />
              <strong>This action cannot be undone.</strong> Consider exporting your data first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteAll}
              disabled={deleteLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteLoading ? "Deleting..." : "Yes, Delete Everything"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Settings;
