import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { LandingChat } from '@/components/LandingChat';
import { DashboardPreview } from '@/components/DashboardPreview';
import { FeatureComparison } from '@/components/FeatureComparison';
import { HowItWorks } from '@/components/HowItWorks';
import { Button } from '@/components/ui/button';
import { ChevronUp, ChevronDown } from 'lucide-react';

const Landing = () => {
  const navigate = useNavigate();
  const [isMinimized, setIsMinimized] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

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
          <div className="text-sm text-muted-foreground">
            Chat below to get started →
          </div>
        </div>
      </header>

      <div className="flex-1 flex flex-col overflow-hidden">
        {!isMinimized ? (
          <div className="flex-1 flex flex-col overflow-y-auto">
            <div className="max-w-7xl mx-auto w-full">
              <div className="text-center py-8 px-6">
                <h2 className="text-3xl md:text-4xl font-bold mb-4">
                  Try It First. Download Proof. Then Decide.
                </h2>
                <p className="text-base md:text-lg text-muted-foreground leading-relaxed max-w-3xl mx-auto mb-6">
                  Your universal memory layer for AI. Bring your own API keys (OpenAI, Claude, Google). 
                  We log everything. You own it. Export anytime. Context compounds over time.
                </p>
                <div className="flex flex-wrap justify-center gap-3 mb-4">
                  <Button onClick={() => navigate('/auth')} size="lg" className="gap-2">
                    Sign Up - Free
                  </Button>
                  <Button 
                    onClick={() => setShowDetails(!showDetails)} 
                    variant="outline" 
                    size="lg"
                    className="gap-2"
                  >
                    {showDetails ? (
                      <>
                        Hide Details <ChevronUp className="w-4 h-4" />
                      </>
                    ) : (
                      <>
                        Learn More <ChevronDown className="w-4 h-4" />
                      </>
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  💬 Demo chat below - try it before signing up
                </p>
              </div>

              {showDetails && (
                <div className="animate-in fade-in slide-in-from-top-4 duration-500">
                  <HowItWorks />
                  <FeatureComparison />
                </div>
              )}

              <div className="h-[500px] px-4 pb-4">
                <LandingChat onMinimize={() => setIsMinimized(true)} />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Dashboard Preview - 30% */}
            <div className="h-[30%] overflow-hidden border-b border-border relative">
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

            {/* Minimized Chat - 70% */}
            <div className="h-[70%] flex flex-col">
              <div className="border-b border-border px-6 py-2 flex justify-between items-center bg-background/50">
                <span className="text-sm font-medium">Continue Chatting</span>
                <Button
                  onClick={() => setIsMinimized(false)}
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                >
                  <ChevronUp className="w-3 h-3 mr-1.5" />
                  Expand Chat
                </Button>
              </div>
              <LandingChat />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Landing;
