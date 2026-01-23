import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Brain, ArrowLeft, Download, Trash2, Database, User } from "lucide-react";
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

const Settings = () => {
  const navigate = useNavigate();
  const [userEmail, setUserEmail] = useState<string>("");
  const [exportFormat, setExportFormat] = useState<string>('json');
  const [exportLoading, setExportLoading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [dataStats, setDataStats] = useState({ entries: 0, dataSizeMB: 0 });

  useEffect(() => {
    checkAuth();
    fetchDataStats();
  }, []);

  const checkAuth = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      navigate("/auth");
      return;
    }
    setUserEmail(user.email || "");
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
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("No active session");

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

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `brain-dump-${new Date().toISOString().split('T')[0]}.${exportFormat}`;
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

      // Delete via function for other data
      const { error } = await supabase.functions.invoke('delete-all-user-data', {
        body: { userId: user.id }
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
    <div className="min-h-screen bg-gradient-bg p-4">
      <div className="max-w-lg mx-auto">
        <Button
          variant="ghost"
          onClick={() => navigate("/dashboard")}
          className="mb-6"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Dashboard
        </Button>

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

          {/* Export Section */}
          <div className="space-y-3 mb-6">
            <Label>Export All Data</Label>
            <p className="text-xs text-muted-foreground">
              Download your entire brain dump. Your data, your control.
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

          {/* Delete Section */}
          <div className="space-y-3">
            <Label className="text-destructive">Danger Zone</Label>
            <p className="text-xs text-muted-foreground">
              Delete all your data permanently. This cannot be undone.
            </p>
            <Button
              variant="destructive"
              onClick={() => setDeleteDialogOpen(true)}
              disabled={deleteLoading || dataStats.entries === 0}
              className="w-full"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete All My Data
            </Button>
          </div>
        </Card>

        {/* Footer */}
        <div className="mt-6 text-center text-xs text-muted-foreground">
          <p>Brain Dump - Your AI-powered second brain</p>
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete All Data?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete all <strong>{dataStats.entries} entries</strong> from your brain dump.
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
    </div>
  );
};

export default Settings;
