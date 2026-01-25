import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { Mail, RefreshCw } from 'lucide-react';
import { LinkJacLogo } from "@/components/LinkJacLogo";

type AuthMode = 'login' | 'signup' | 'forgot' | 'reset';

const RESEND_COOLDOWN = 60; // seconds

const Auth = () => {
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [trackingConsent, setTrackingConsent] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [resetEmailSent, setResetEmailSent] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const cooldownRef = useRef<NodeJS.Timeout | null>(null);
  const navigate = useNavigate();
  const { toast } = useToast();

  // Check for password reset callback
  useEffect(() => {
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const accessToken = hashParams.get('access_token');
    const type = hashParams.get('type');
    
    if (accessToken && type === 'recovery') {
      setMode('reset');
    }
  }, [searchParams]);

  // Cleanup cooldown timer
  useEffect(() => {
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    };
  }, []);

  const startCooldown = () => {
    setResendCooldown(RESEND_COOLDOWN);
    cooldownRef.current = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) {
          if (cooldownRef.current) clearInterval(cooldownRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

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
        navigate('/dashboard');
      } else if (mode === 'signup') {
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

  const handleForgotPassword = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!email.trim()) {
      toast({
        title: "Email required",
        description: "Please enter your email address.",
        variant: "destructive",
      });
      return;
    }
    
    setIsLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth`,
      });
      if (error) throw error;
      
      setResetEmailSent(true);
      startCooldown();
      
      toast({
        title: "Reset link sent!",
        description: `We sent a password reset link to ${email}`,
      });
    } catch (error: any) {
      toast({
        title: "Error sending reset email",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      toast({
        title: "Passwords don't match",
        description: "Please make sure your passwords match.",
        variant: "destructive",
      });
      return;
    }
    if (password.length < 8) {
      toast({
        title: "Password too short",
        description: "Password must be at least 8 characters.",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      
      toast({
        title: "Password updated",
        description: "Your password has been reset successfully.",
      });
      navigate('/dashboard');
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

  const getTitle = () => {
    switch (mode) {
      case 'login': return 'Sign in to your account';
      case 'signup': return 'Create your account';
      case 'forgot': return 'Reset your password';
      case 'reset': return 'Set new password';
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-background to-muted/30 p-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center flex flex-col items-center">
          <LinkJacLogo size="lg" className="mb-2" />
          <p className="text-muted-foreground mt-1">
            Your AI-powered second brain
          </p>
          <p className="text-sm text-muted-foreground mt-4">
            {getTitle()}
          </p>
        </div>

        {/* Forgot Password Form */}
        {mode === 'forgot' && (
          <div className="space-y-4">
            {resetEmailSent ? (
              <div className="space-y-4">
                <div className="bg-muted/50 border border-border rounded-lg p-6 text-center space-y-3">
                  <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto">
                    <Mail className="w-6 h-6 text-primary" />
                  </div>
                  <h3 className="font-medium">Check your inbox</h3>
                  <p className="text-sm text-muted-foreground">
                    We sent a password reset link to:
                  </p>
                  <p className="text-sm font-medium">{email}</p>
                  <p className="text-xs text-muted-foreground">
                    Click the link in the email to reset your password. Check your spam folder if you don't see it.
                  </p>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={isLoading || resendCooldown > 0}
                  onClick={() => handleForgotPassword()}
                >
                  {isLoading ? (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      Sending...
                    </>
                  ) : resendCooldown > 0 ? (
                    `Resend in ${resendCooldown}s`
                  ) : (
                    'Resend Reset Link'
                  )}
                </Button>

                <div className="text-center">
                  <button
                    type="button"
                    onClick={() => {
                      setMode('login');
                      setResetEmailSent(false);
                    }}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Back to Sign In
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleForgotPassword} className="space-y-4">
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    disabled={isLoading}
                    placeholder="Enter your email address"
                  />
                </div>

                <Button type="submit" className="w-full" disabled={isLoading}>
                  {isLoading ? 'Sending...' : 'Send Reset Link'}
                </Button>

                <div className="text-center">
                  <button
                    type="button"
                    onClick={() => setMode('login')}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    disabled={isLoading}
                  >
                    Back to Sign In
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        {/* Reset Password Form */}
        {mode === 'reset' && (
          <form onSubmit={handleResetPassword} className="space-y-4">
            <div>
              <Label htmlFor="password">New Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={isLoading}
                minLength={8}
                placeholder="Enter new password"
              />
            </div>

            <div>
              <Label htmlFor="confirmPassword">Confirm Password</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                disabled={isLoading}
                minLength={8}
                placeholder="Confirm new password"
              />
            </div>

            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? 'Updating...' : 'Update Password'}
            </Button>
          </form>
        )}

        {/* Login/Signup Form */}
        {(mode === 'login' || mode === 'signup') && (
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
                minLength={mode === 'signup' ? 8 : undefined}
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
              {isLoading ? 'Loading...' : mode === 'login' ? 'Sign In' : 'Create Account'}
            </Button>

            <div className="text-center">
              <button
                type="button"
                onClick={() => setMode('forgot')}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                disabled={isLoading}
              >
                Forgot your password?
              </button>
            </div>

            <div className="text-center">
              <button
                type="button"
                onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                disabled={isLoading}
              >
                {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
              </button>
            </div>
          </form>
        )}

        <div className="text-center space-y-3">
          <button
            onClick={() => navigate('/')}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Back to home
          </button>
          <div className="flex justify-center gap-4 text-xs text-muted-foreground">
            <button onClick={() => navigate('/terms')} className="hover:text-foreground transition-colors">Terms</button>
            <button onClick={() => navigate('/privacy')} className="hover:text-foreground transition-colors">Privacy</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Auth;
