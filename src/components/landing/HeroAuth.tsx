import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft } from 'lucide-react';

interface HeroAuthProps {
  mode: 'signup' | 'login';
  onSuccess: () => void;
  onBack: () => void;
}

export const HeroAuth = ({ mode, onSuccess, onBack }: HeroAuthProps) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [trackingConsent, setTrackingConsent] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        onSuccess();
        navigate('/dashboard');
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/dashboard`,
            data: {
              tracking_consent: trackingConsent,
            },
          },
        });
        if (error) throw error;
        
        toast({
          title: "Account created",
          description: "Check your email to verify your account.",
        });
        onSuccess();
        navigate('/dashboard');
      }
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="max-w-md mx-auto px-6 py-8 h-full flex flex-col justify-center animate-fade-in">
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">
            {mode === 'signup' ? 'Create your account' : 'Welcome back'}
          </h2>
          <p className="text-sm text-muted-foreground mt-2">
            {mode === 'signup' 
              ? 'Start capturing your AI conversations' 
              : 'Sign in to access your unified memory'}
          </p>
        </div>

        <form onSubmit={handleAuth} className="space-y-4">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={isLoading}
              className="mt-1.5"
            />
          </div>

          <div>
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={isLoading}
              minLength={6}
              className="mt-1.5"
            />
          </div>

          {mode === 'signup' && (
            <div className="flex items-center space-x-2">
              <Checkbox
                id="tracking"
                checked={trackingConsent}
                onCheckedChange={(checked) => setTrackingConsent(checked as boolean)}
              />
              <Label
                htmlFor="tracking"
                className="text-sm font-normal text-muted-foreground cursor-pointer"
              >
                I consent to anonymous usage tracking to improve the product
              </Label>
            </div>
          )}

          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? 'Loading...' : mode === 'signup' ? 'Create Account' : 'Sign In'}
          </Button>
        </form>
      </div>
    </div>
  );
};
