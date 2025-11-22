import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { LandingChat } from '@/components/LandingChat';

const Landing = () => {
  const navigate = useNavigate();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        navigate('/dashboard');
      }
    });
  }, [navigate]);

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
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

      <div className="flex-1 flex flex-col max-w-7xl mx-auto w-full">
        <div className="text-center py-12 px-6">
          <h2 className="text-2xl font-bold mb-3">
            You own your data with your API
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl mx-auto">
            Bring your OpenAI, Claude, or Google API key. We store every conversation.
            You own it. Context compounds. Your AI remembers.
          </p>
        </div>

        <div className="flex-1 min-h-0">
          <LandingChat />
        </div>
      </div>
    </div>
  );
};

export default Landing;
