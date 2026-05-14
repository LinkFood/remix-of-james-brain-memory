/**
 * /settings — Profile shell.
 *
 * Ship 6 (Phase 1 close arc, Bundle 1) — stripped down from the JAC-era
 * settings page. Removed: delete-all-user-data flow (foot-gun), TagManager
 * (JAC entries-coupled), Data Stats (JAC entries count), bulk export.
 * Co-Trader configuration lives on /ct-settings; this surface is
 * intentionally minimal — account identity + sign-out + agent notification
 * webhook only.
 *
 * Preserve gate: email/auth/timezone load-bearing → kept. Anything
 * destructive against user data → removed (no recovery path; foot-gun
 * exposure unjustified for solo-user product).
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Brain, User, Bot, Send } from "lucide-react";
import { Separator } from "@/components/ui/separator";

const Settings = () => {
  const navigate = useNavigate();
  const [userEmail, setUserEmail] = useState<string>("");
  const [slackWebhookUrl, setSlackWebhookUrl] = useState("");
  const [slackSaving, setSlackSaving] = useState(false);
  const [slackTesting, setSlackTesting] = useState(false);

  useEffect(() => {
    checkAuth();
    loadSlackWebhook();
  }, []);

  const checkAuth = async () => {
    // getUser() forces server refresh per CLAUDE.md auth rule — getSession()
    // alone returns stale cached JWTs.
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      navigate("/auth");
      return;
    }
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save webhook";
      toast.error(msg);
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
              <p className="text-sm text-muted-foreground">
                Account profile. Co-Trader configuration lives on <a className="underline" href="/ct-settings">/ct-settings</a>.
              </p>
            </div>
          </div>

          {/* Account Info */}
          <div className="space-y-4 mb-6">
            <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
              <User className="w-5 h-5 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{userEmail || '—'}</p>
                <p className="text-xs text-muted-foreground">Signed in</p>
              </div>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={handleSignOut}>
                Sign Out
              </Button>
            </div>
          </div>

          <Separator className="my-6" />

          {/* JAC Agent notifications — still load-bearing for JAC worker Slack delivery */}
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                <Bot className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">Agent notifications</h2>
                <p className="text-xs text-muted-foreground">Slack webhook for JAC agent task completion + reminders</p>
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
        </Card>

        {/* Footer */}
        <div className="mt-6 text-center text-xs text-muted-foreground">
          <p>JAC Agent OS · Co-Trader</p>
        </div>
      </div>
    </div>
  );
};

export default Settings;
