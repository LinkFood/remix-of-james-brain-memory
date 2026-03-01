import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Brain, Download, Trash2, Database, User, Tag, AlertTriangle, Bot, Send } from "lucide-react";
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
import TagManager from "@/components/TagManager";
import type { Entry } from "@/components/EntryCard";

const Settings = () => {
  const navigate = useNavigate();
  const [userId, setUserId] = useState<string>("");
  const [userEmail, setUserEmail] = useState<string>("");
  const [exportFormat, setExportFormat] = useState<string>('json');
  const [exportLoading, setExportLoading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [dataStats, setDataStats] = useState({ entries: 0, dataSizeMB: 0 });
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [slackWebhookUrl, setSlackWebhookUrl] = useState("");
  const [slackSaving, setSlackSaving] = useState(false);
  const [slackTesting, setSlackTesting] = useState(false);

  useEffect(() => {
    checkAuth();
    fetchDataStats();
    loadSlackWebhook();
  }, []);

  const checkAuth = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      navigate("/auth");
      return;
    }
    setUserId(user.id);
    setUserEmail(user.email || "");
  };

  const loadSlackWebhook = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from('user_settings')
      .select('settings')
      .eq('user_id', user.id)
      .single();
    const url = (data?.settings as Record<string, unknown>)?.slack_webhook_url;
    if (typeof url === 'string') setSlackWebhookUrl(url);
  };

  const isValidSlackWebhook = (url: string): boolean => {
    if (!url) return true; // empty = clearing the webhook
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && parsed.hostname === 'hooks.slack.com';
    } catch {
      return false;
    }
  };

  const handleSaveSlackWebhook = async () => {
    if (slackWebhookUrl && !isValidSlackWebhook(slackWebhookUrl)) {
      toast.error("Invalid webhook URL. Must be a hooks.slack.com HTTPS URL.");
      return;
    }
    setSlackSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data: existing } = await supabase
        .from('user_settings')
        .select('settings')
        .eq('user_id', user.id)
        .single();

      const currentSettings = (existing?.settings as Record<string, unknown>) || {};
      const updatedSettings = { ...currentSettings, slack_webhook_url: slackWebhookUrl || null };

      if (existing) {
        await supabase
          .from('user_settings')
          .update({ settings: updatedSettings })
          .eq('user_id', user.id);
      } else {
        await supabase
          .from('user_settings')
          .insert({ user_id: user.id, settings: updatedSettings });
      }

      toast.success("Slack webhook saved");
    } catch (err: any) {
      toast.error(err.message || "Failed to save webhook");
    } finally {
      setSlackSaving(false);
    }
  };

  const handleTestSlackWebhook = async () => {
    if (!slackWebhookUrl) {
      toast.error("Enter a webhook URL first");
      return;
    }
    if (!isValidSlackWebhook(slackWebhookUrl)) {
      toast.error("Invalid webhook URL. Must be a hooks.slack.com HTTPS URL.");
      return;
    }
    setSlackTesting(true);
    try {
      const res = await fetch(slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: ':robot_face: *JAC Agent OS* :white_check_mark:\n\nTest notification — your webhook is working!',
              },
            },
          ],
        }),
      });
      if (res.ok) {
        toast.success("Test notification sent!");
      } else {
        toast.error(`Webhook returned ${res.status}`);
      }
    } catch {
      toast.error("Failed to reach webhook URL");
    } finally {
      setSlackTesting(false);
    }
  };

  const fetchEntries = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    
    const { data } = await supabase
      .from('entries')
      .select('*')
      .eq('user_id', user.id)
      .eq('archived', false);
    
    // Map to Entry type - entries only need tags for TagManager
    const mappedEntries = (data || []).map((item) => ({
      ...item,
      tags: item.tags || [],
      extracted_data: (item.extracted_data as Record<string, unknown>) || {},
      list_items: [] as { text: string; checked: boolean }[],
    }));
    
    setEntries(mappedEntries as unknown as Entry[]);
  };

  const fetchDataStats = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { count } = await supabase
        .from('entries')
        .select('id', { count: 'exact' })
        .eq('user_id', user.id);

      const entries = count || 0;

      // Estimate data size (avg 500 bytes per entry)
      const dataSizeBytes = entries * 500;
      const dataSizeMB = parseFloat((dataSizeBytes / (1024 * 1024)).toFixed(2));

      setDataStats({ entries, dataSizeMB });
    } catch (error) {
      console.error('Failed to fetch data stats:', error);
    }
  };

  const handleExport = async () => {
    setExportLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/export-all-data`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ format: exportFormat })
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Export failed');
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `linkjac-export-${new Date().toISOString().split('T')[0]}.${exportFormat}`;
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

      // Delete entries
      const { error: entriesError } = await supabase
        .from('entries')
        .delete()
        .eq('user_id', user.id);

      if (entriesError) throw entriesError;

      // Delete via function for other data (userId extracted from JWT in function)
      const { error } = await supabase.functions.invoke('delete-all-user-data', {
        body: {}
      });

      if (error) throw error;

      toast.success("All data deleted successfully");
      setDeleteDialogOpen(false);
      setDataStats({ entries: 0, dataSizeMB: 0 });

      setTimeout(() => navigate("/dashboard"), 1500);
    } catch (error: any) {
      toast.error(error.message || "Failed to delete data");
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    toast.success("Signed out successfully");
    navigate("/");
  };

  return (
    <div className="h-full overflow-auto p-4">
      <div className="max-w-lg mx-auto">
        <Card className="p-6 bg-card border-border">
          {/* Header */}
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center">
              <Brain className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Settings</h1>
              <p className="text-sm text-muted-foreground">Manage your account</p>
            </div>
          </div>

          {/* Account Info */}
          <div className="space-y-4 mb-6">
            <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
              <User className="w-5 h-5 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{userEmail}</p>
                <p className="text-xs text-muted-foreground">Signed in</p>
              </div>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={handleSignOut}>
                Sign Out
              </Button>
            </div>
          </div>

          <Separator className="my-6" />

          {/* JAC Agent */}
          <div className="space-y-4 mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                <Bot className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">JAC Agent</h2>
                <p className="text-xs text-muted-foreground">Agent notification settings</p>
              </div>
            </div>

            <Card className="p-4 bg-muted/30 border-border space-y-3">
              <div>
                <Label htmlFor="slack-webhook" className="text-sm">Slack Webhook URL</Label>
                <p className="text-xs text-muted-foreground mb-2">
                  Get notified when JAC agents complete tasks.
                </p>
                <Input
                  id="slack-webhook"
                  type="url"
                  value={slackWebhookUrl}
                  onChange={(e) => setSlackWebhookUrl(e.target.value)}
                  placeholder="https://hooks.slack.com/services/..."
                />
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={handleSaveSlackWebhook}
                  disabled={slackSaving}
                  size="sm"
                  className="flex-1"
                >
                  {slackSaving ? "Saving..." : "Save Webhook"}
                </Button>
                <Button
                  onClick={handleTestSlackWebhook}
                  disabled={slackTesting || !slackWebhookUrl}
                  variant="outline"
                  size="sm"
                >
                  <Send className="w-3 h-3 mr-1" />
                  {slackTesting ? "Sending..." : "Test"}
                </Button>
              </div>
            </Card>
          </div>

          <Separator className="my-6" />

          {/* Data Stats */}
          <div className="space-y-4 mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                <Database className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">Your Data</h2>
                <p className="text-xs text-muted-foreground">Everything you've dumped</p>
              </div>
            </div>

            <Card className="p-4 bg-muted/30 border-border">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-2xl font-bold">{dataStats.entries}</p>
                  <p className="text-xs text-muted-foreground">Entries</p>
                </div>
                <div>
                  <p className="text-2xl font-bold">{dataStats.dataSizeMB} MB</p>
                  <p className="text-xs text-muted-foreground">Data size</p>
                </div>
              </div>
            </Card>
          </div>

          <Separator className="my-6" />

          {/* Tag Management */}
          <div className="space-y-3 mb-6">
            <Label>Manage Tags</Label>
            <p className="text-xs text-muted-foreground">
              Rename, merge, or delete tags across all your entries.
            </p>
            <Button
              variant="outline"
              onClick={() => {
                fetchEntries();
                setTagManagerOpen(true);
              }}
              className="w-full"
            >
              <Tag className="w-4 h-4 mr-2" />
              Manage Tags
            </Button>
          </div>

          {/* Export Section */}
          <div className="space-y-3 mb-6">
            <Label>Export All Data</Label>
            <p className="text-xs text-muted-foreground">
              Download all your data from LinkJac. Your data, your control.
            </p>
            <div className="flex gap-2">
              <Select value={exportFormat} onValueChange={setExportFormat}>
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="json">JSON</SelectItem>
                  <SelectItem value="csv">CSV</SelectItem>
                  <SelectItem value="md">Markdown</SelectItem>
                </SelectContent>
              </Select>
              <Button
                onClick={handleExport}
                disabled={exportLoading || dataStats.entries === 0}
                className="flex-1"
              >
                <Download className="w-4 h-4 mr-2" />
                {exportLoading ? "Exporting..." : "Export"}
              </Button>
            </div>
          </div>

          <Separator className="my-6" />

          {/* Danger Zone */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-destructive" />
              <Label className="text-destructive">Danger Zone</Label>
            </div>
            
            {/* Delete Data */}
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Delete all your data permanently. This cannot be undone.
              </p>
              <Button
                variant="outline"
                onClick={() => setDeleteDialogOpen(true)}
                disabled={deleteLoading || dataStats.entries === 0}
                className="w-full border-destructive/50 text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete All My Data
              </Button>
            </div>
          </div>

        </Card>

        {/* Footer */}
        <div className="mt-6 text-center text-xs text-muted-foreground">
          <p>LinkJac - Your AI-powered second brain</p>
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete All Data?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete all <strong>{dataStats.entries} entries</strong> from your LinkJac account.
              <br /><br />
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

      {/* Tag Manager */}
      <TagManager
        open={tagManagerOpen}
        onOpenChange={setTagManagerOpen}
        entries={entries}
        userId={userId}
        onTagsUpdated={() => {
          fetchEntries();
          fetchDataStats();
        }}
      />
    </div>
  );
};

export default Settings;
