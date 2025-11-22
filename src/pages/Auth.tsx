import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Brain, Database, Shield, Download, CheckCircle2 } from "lucide-react";

const Auth = () => {
  const navigate = useNavigate();
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [agreedToTracking, setAgreedToTracking] = useState(false);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!isLogin && !agreedToTracking) {
      toast.error("Please acknowledge that we track your data to build your AI memory");
      return;
    }
    
    setLoading(true);

    try {
      if (isLogin) {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        toast.success("Logged in successfully");
        navigate("/");
      } else {
        const redirectUrl = `${window.location.origin}/`;
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: redirectUrl,
          },
        });
        if (error) throw error;
        
        // Insert sample data for the new user
        if (data.user) {
          try {
            const { error: sampleDataError } = await supabase.functions.invoke('insert-sample-data');
            if (sampleDataError) {
              console.error('Failed to insert sample data:', sampleDataError);
            } else {
              toast.success("Account created with sample conversations!");
            }
          } catch (err) {
            console.error('Error calling insert-sample-data:', err);
            toast.success("Account created! You can now log in.");
          }
        } else {
          toast.success("Account created! You can now log in.");
        }
        
        setIsLogin(true);
      }
    } catch (error: any) {
      toast.error(error.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-bg p-4">
      <div className="w-full max-w-4xl grid md:grid-cols-2 gap-6 animate-fade-in">
        {/* Auth Form */}
        <Card className="p-8 bg-card border-border shadow-glow">
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mb-4 shadow-intense">
              <Brain className="w-10 h-10 text-primary animate-pulse-glow" />
            </div>
            <h1 className="text-3xl font-bold text-foreground">James Brain OS</h1>
            <p className="text-muted-foreground mt-2">Universal AI Memory Shell</p>
          </div>

          <form onSubmit={handleAuth} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="bg-input border-border focus:ring-primary"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="bg-input border-border focus:ring-primary"
            />
          </div>

          {!isLogin && (
            <div className="flex items-start space-x-3 p-4 bg-primary/5 border border-primary/20 rounded-lg">
              <Checkbox
                id="tracking-consent"
                checked={agreedToTracking}
                onCheckedChange={(checked) => setAgreedToTracking(checked as boolean)}
                className="mt-1"
              />
              <label
                htmlFor="tracking-consent"
                className="text-sm text-foreground leading-relaxed cursor-pointer"
              >
                I understand that James Brain OS stores my conversations to build my personal AI memory. I have full control to export or delete my data anytime.
              </label>
            </div>
          )}

          <Button
            type="submit"
            className="w-full bg-primary hover:bg-primary-glow text-primary-foreground font-semibold shadow-glow transition-all"
            disabled={loading}
          >
            {loading ? "Processing..." : isLogin ? "Sign In" : "Create Account"}
          </Button>

          <button
            type="button"
            onClick={() => setIsLogin(!isLogin)}
            className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {isLogin ? "Need an account? Sign up" : "Already have an account? Sign in"}
          </button>
        </form>
        </Card>

        {/* Social Contract Card */}
        <Card className="p-8 bg-card border-border shadow-glow flex flex-col">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center">
              <Database className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-foreground">Yes, We Track Your Data</h2>
              <p className="text-sm text-muted-foreground">Here's why that's good</p>
            </div>
          </div>

          <div className="space-y-4 flex-1">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="font-semibold text-foreground mb-1">Store Every Conversation</h3>
                <p className="text-sm text-muted-foreground">Build a searchable memory across ALL AI providers—ChatGPT, Claude, Gemini, and more.</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="font-semibold text-foreground mb-1">Smarter Conversations</h3>
                <p className="text-sm text-muted-foreground">Future chats inject relevant context automatically. Your AI remembers what matters.</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Shield className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="font-semibold text-foreground mb-1">You Own Everything</h3>
                <p className="text-sm text-muted-foreground">Export to JSON, CSV, Excel, or Markdown. Delete permanently with one click.</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Download className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="font-semibold text-foreground mb-1">Import from Anywhere</h3>
                <p className="text-sm text-muted-foreground">Bring conversations from other platforms. Your data, unified in one place.</p>
              </div>
            </div>
          </div>

          <div className="mt-6 p-4 bg-primary/5 border border-primary/20 rounded-lg">
            <p className="text-sm text-foreground font-medium mb-2">The Difference</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Big AI companies promise "we don't store your data." We promise "we <span className="text-primary font-semibold">DO</span> store your data... <span className="text-primary font-semibold">for YOU</span>." That's our competitive advantage—and your second brain.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default Auth;
