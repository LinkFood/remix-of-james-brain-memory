import { ArrowLeft, Zap, Database, Network } from 'lucide-react';

interface HeroHowItWorksProps {
  onBack: () => void;
}

export const HeroHowItWorks = ({ onBack }: HeroHowItWorksProps) => {
  return (
    <div className="max-w-4xl mx-auto px-6 py-8 h-full flex flex-col justify-center animate-fade-in">
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="space-y-6">
        <div>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
            Cross-platform memory,
            <span className="text-primary"> finally unified</span>
          </h2>
          <p className="text-muted-foreground mt-2 text-lg">
            One memory layer across all your AI conversations
          </p>
        </div>

        <div className="grid sm:grid-cols-3 gap-4 pt-4">
          <div className="p-4 rounded-lg border border-border/50 bg-card/50 space-y-3">
            <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
              <Zap className="w-5 h-5 text-primary" />
            </div>
            <h3 className="font-semibold">Bring your own AI</h3>
            <p className="text-sm text-muted-foreground">
              Use your API keys for ChatGPT, Claude, Gemini, or any model. We don't lock you in.
            </p>
          </div>

          <div className="p-4 rounded-lg border border-border/50 bg-card/50 space-y-3">
            <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
              <Database className="w-5 h-5 text-primary" />
            </div>
            <h3 className="font-semibold">Everything is logged</h3>
            <p className="text-sm text-muted-foreground">
              Every message is embedded, scored for importance, and stored. Your full conversation history becomes searchable context.
            </p>
          </div>

          <div className="p-4 rounded-lg border border-border/50 bg-card/50 space-y-3">
            <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
              <Network className="w-5 h-5 text-primary" />
            </div>
            <h3 className="font-semibold">Context travels</h3>
            <p className="text-sm text-muted-foreground">
              Past conversations are injected into new chats. The AI sees your full history, not just the current session.
            </p>
          </div>
        </div>

        <div className="p-4 rounded-lg border border-primary/30 bg-primary/5 text-sm">
          <p className="font-medium">The result?</p>
          <p className="text-muted-foreground mt-1">
            Compounding intelligence. Each conversation makes every future conversation better because the AI has access to everything you've ever discussed across all platforms.
          </p>
        </div>
      </div>
    </div>
  );
};
