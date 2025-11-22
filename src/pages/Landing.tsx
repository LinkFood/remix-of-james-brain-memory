import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { LandingChat } from '@/components/LandingChat';
import { DashboardPreview } from '@/components/DashboardPreview';
import { Button } from '@/components/ui/button';

const Landing = () => {
  const navigate = useNavigate();
  const [isMinimized, setIsMinimized] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        navigate('/dashboard');
      }
    });
  }, [navigate]);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <header className="border-b border-border px-6 py-4">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <h1 className="text-xl font-bold tracking-tight">JAMESBRAIN</h1>
          <button
            onClick={() => navigate('/auth')}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Login
          </button>
        </div>
      </header>

      <div className="flex-1 flex flex-col overflow-hidden">
        {!isMinimized ? (
          <div className="flex-1 flex flex-col max-w-7xl mx-auto w-full">
            <div className="text-center py-6 px-6">
              <h2 className="text-2xl font-bold mb-3">
                You own your data with your API
              </h2>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl mx-auto">
                Bring your OpenAI, Claude, or Google API key. We store every conversation.
                You own it. Context compounds. Your AI remembers.
              </p>
            </div>

            <div className="flex-1 min-h-0">
              <LandingChat onMinimize={() => setIsMinimized(true)} />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Dashboard Preview - 60% */}
            <div className="h-[60%] overflow-hidden border-b border-border relative">
              <DashboardPreview />
              <div className="absolute inset-0 backdrop-blur-sm bg-background/40 flex items-center justify-center">
                <div className="text-center space-y-4">
                  <div className="text-lg font-semibold tracking-tight">
                    Sign up to unlock full interface
                  </div>
                  <Button 
                    onClick={() => navigate('/auth')}
                    size="lg"
                  >
                    Sign Up
                  </Button>
                </div>
              </div>
            </div>

            {/* Minimized Chat - 40% */}
            <div className="h-[40%] overflow-hidden">
              <LandingChat />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Landing;
