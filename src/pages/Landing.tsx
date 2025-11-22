import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";

const Landing = () => {
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
        navigate("/dashboard");
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
    <div className="h-screen w-screen overflow-hidden bg-background flex flex-col lg:flex-row">
      {/* Left Panel - Auth & Info */}
      <div className="flex-1 flex flex-col justify-between p-8 lg:p-12 overflow-y-auto">
        <div className="flex-1 flex flex-col justify-center max-w-md mx-auto w-full space-y-8">
          {/* Header */}
          <div className="space-y-12 animate-fade-in">
            <div className="space-y-6">
              <h1 className="text-5xl font-bold text-foreground tracking-tight">
                Stop Starting Over
              </h1>
              <p className="text-lg text-muted-foreground leading-relaxed max-w-md">
                Every AI conversation is lost when you close the tab. We store it. You own it. Your AI remembers.
              </p>
            </div>
          </div>

          {/* Auth Form */}
          <form onSubmit={handleAuth} className="space-y-4 animate-fade-in">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
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
              />
            </div>

            {!isLogin && (
              <div className="flex items-start space-x-3 p-3 bg-primary/5 border border-primary/20 rounded-lg">
                <Checkbox
                  id="tracking-consent"
                  checked={agreedToTracking}
                  onCheckedChange={(checked) => setAgreedToTracking(checked as boolean)}
                  className="mt-1"
                />
                <label
                  htmlFor="tracking-consent"
                  className="text-xs text-foreground leading-relaxed cursor-pointer"
                >
                  I understand my data is stored to build my AI memory. I can export or delete anytime.
                </label>
              </div>
            )}

            <Button
              type="submit"
              className="w-full"
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
        </div>

        {/* Footer */}
        <div className="mt-12 pt-8 border-t border-border/20 animate-fade-in">
          <p className="text-xs text-muted-foreground tracking-wide">
            You own it. Export anytime. Delete anytime.
          </p>
        </div>
      </div>

      {/* Right Panel - Data Visualization */}
      <div className="flex-1 bg-card/30 backdrop-blur-sm border-t lg:border-t-0 lg:border-l border-border/20 p-8 lg:p-12 flex items-center justify-center overflow-y-auto">
        <div className="max-w-2xl w-full space-y-12">
          {/* Header */}
          <div className="space-y-2">
            <h2 className="text-sm font-mono text-muted-foreground uppercase tracking-widest">
              Context Accumulation
            </h2>
          </div>

          {/* Data Visualization */}
          <div className="space-y-8">
            {/* Conversation 1 */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm text-muted-foreground">Conversation 1</span>
                <span className="font-mono text-xs text-muted-foreground">0 memories</span>
              </div>
              <div className="h-2 bg-border/20 rounded-full overflow-hidden">
                <div className="h-full bg-foreground/40 rounded-full transition-all duration-1000" style={{ width: '40%' }} />
              </div>
              <p className="text-sm text-muted-foreground pl-2 border-l-2 border-border/30">
                "I'm working on a new project"
              </p>
            </div>

            {/* Conversation 2 */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm text-muted-foreground">Conversation 2</span>
                <span className="font-mono text-xs text-foreground">2 memories injected</span>
              </div>
              <div className="h-2 bg-border/20 rounded-full overflow-hidden">
                <div className="h-full bg-foreground/60 rounded-full transition-all duration-1000" style={{ width: '70%' }} />
              </div>
              <p className="text-sm text-muted-foreground pl-2 border-l-2 border-border/30">
                "How should I structure components?"
              </p>
            </div>

            {/* Conversation 3 */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm text-muted-foreground">Conversation 3</span>
                <span className="font-mono text-xs text-foreground">4 memories injected</span>
              </div>
              <div className="h-2 bg-border/20 rounded-full overflow-hidden">
                <div className="h-full bg-foreground rounded-full transition-all duration-1000" style={{ width: '100%' }} />
              </div>
              <p className="text-sm text-muted-foreground pl-2 border-l-2 border-border/30">
                "The app is getting complex"
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="pt-8 border-t border-border/20">
            <p className="text-sm text-muted-foreground tracking-wide">
              Your API. Our memory layer. Compounding context.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Landing;
