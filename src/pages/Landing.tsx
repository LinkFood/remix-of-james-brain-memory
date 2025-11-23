import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { LandingChat } from '@/components/LandingChat';
import { FeatureComparison } from '@/components/FeatureComparison';
import { HowItWorks } from '@/components/HowItWorks';
import { PricingSection } from '@/components/PricingSection';
import { TestimonialsSection } from '@/components/TestimonialsSection';
import { DemoVideoSection } from '@/components/DemoVideoSection';
import { LandingFooter } from '@/components/LandingFooter';
import { Button } from '@/components/ui/button';
import { ChevronDown, MessageSquare } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { Drawer, DrawerContent, DrawerTrigger } from '@/components/ui/drawer';

const Landing = () => {
  const navigate = useNavigate();
  const [showDetails, setShowDetails] = useState(false);
  const isMobile = useIsMobile();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        navigate('/dashboard');
      }
    });
  }, [navigate]);

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="border-b border-border px-6 py-4 sticky top-0 bg-background/80 backdrop-blur-sm z-50">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <h1 className="text-xl font-bold tracking-tight">JAMESBRAIN</h1>
          <div className="flex items-center gap-4">
            <a href="#features" className="text-sm text-muted-foreground hover:text-foreground transition-colors hidden md:block">
              Features
            </a>
            <a href="#pricing" className="text-sm text-muted-foreground hover:text-foreground transition-colors hidden md:block">
              Pricing
            </a>
            <Button onClick={() => navigate('/auth')} size="sm" variant="outline">
              Sign In
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {isMobile ? (
          // Mobile: Scrollable content with bottom drawer for chat
          <div className="flex-1 flex flex-col overflow-y-auto">
            <div className="max-w-7xl mx-auto w-full">
              <div id="hero" className="text-center py-8 px-6">
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
                      <>Hide Details</>
                    ) : (
                      <>
                        Learn More <ChevronDown className="w-4 h-4" />
                      </>
                    )}
                  </Button>
                </div>
              </div>

              {showDetails && (
                <div className="animate-in fade-in slide-in-from-top-4 duration-500">
                  <div id="how-it-works">
                    <HowItWorks />
                  </div>
                  <div id="demo">
                    <DemoVideoSection />
                  </div>
                  <div id="features">
                    <FeatureComparison />
                  </div>
                  <div id="testimonials">
                    <TestimonialsSection />
                  </div>
                  <div id="pricing">
                    <PricingSection />
                  </div>
                </div>
              )}
            </div>

            <LandingFooter />

            {/* Mobile Chat Drawer */}
            <Drawer>
              <DrawerTrigger asChild>
                <Button 
                  size="lg" 
                  className="fixed bottom-4 right-4 shadow-lg z-40 gap-2"
                >
                  <MessageSquare className="w-5 h-5" />
                  Try Demo Chat
                </Button>
              </DrawerTrigger>
              <DrawerContent className="h-[85vh]">
                <div className="h-full flex flex-col">
                  <LandingChat />
                </div>
              </DrawerContent>
            </Drawer>
          </div>
        ) : (
          // Desktop: Split screen with resizable panels
          <ResizablePanelGroup direction="horizontal" className="flex-1">
            {/* Left Panel: Content */}
            <ResizablePanel defaultSize={60} minSize={40}>
              <div className="h-full overflow-y-auto">
                <div className="max-w-4xl mx-auto w-full">
                  <div id="hero" className="text-center py-8 px-6">
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
                          <>Hide Details</>
                        ) : (
                          <>
                            Learn More <ChevronDown className="w-4 h-4" />
                          </>
                        )}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      💬 Demo chat on the right - try it before signing up
                    </p>
                  </div>

                  {showDetails && (
                    <div className="animate-in fade-in slide-in-from-top-4 duration-500">
                      <div id="how-it-works">
                        <HowItWorks />
                      </div>
                      <div id="demo">
                        <DemoVideoSection />
                      </div>
                      <div id="features">
                        <FeatureComparison />
                      </div>
                      <div id="testimonials">
                        <TestimonialsSection />
                      </div>
                      <div id="pricing">
                        <PricingSection />
                      </div>
                    </div>
                  )}
                </div>

                <LandingFooter />
              </div>
            </ResizablePanel>

            {/* Resizable Handle */}
            <ResizableHandle withHandle />

            {/* Right Panel: Chat */}
            <ResizablePanel defaultSize={40} minSize={30}>
              <div className="h-full border-l border-border bg-muted/20">
                <LandingChat />
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>
    </div>
  );
};

export default Landing;
