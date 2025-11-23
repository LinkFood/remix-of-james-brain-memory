import { Key, MessageSquare, Database, Download } from 'lucide-react';

export const HowItWorks = () => {
  const steps = [
    {
      icon: Key,
      title: 'Bring Your API Key',
      description: 'Connect OpenAI, Claude, or Google. We never see your key.',
    },
    {
      icon: MessageSquare,
      title: 'Chat Normally',
      description: 'Use any LLM. Every conversation is captured automatically.',
    },
    {
      icon: Database,
      title: 'Memory Compounds',
      description: 'Semantic search finds relevant context. AI remembers everything.',
    },
    {
      icon: Download,
      title: 'Export Anytime',
      description: 'Your data, your rules. Download or delete whenever you want.',
    },
  ];

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-12">
      <div className="text-center mb-12">
        <h3 className="text-2xl font-bold mb-2">How It Works</h3>
        <p className="text-sm text-muted-foreground">
          Simple infrastructure. No magic. Just memory.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {steps.map((step, idx) => {
          const Icon = step.icon;
          return (
            <div
              key={step.title}
              className="relative group animate-in fade-in slide-in-from-bottom-4"
              style={{ animationDelay: `${idx * 100}ms`, animationFillMode: 'backwards' }}
            >
              <div className="flex flex-col items-center text-center space-y-3 p-6 border border-border rounded-lg hover:border-primary/50 transition-colors">
                <div className="flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 text-primary">
                  <Icon className="w-6 h-6" />
                </div>
                <div className="absolute -top-3 -left-3 w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">
                  {idx + 1}
                </div>
                <h4 className="font-semibold text-sm">{step.title}</h4>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {step.description}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-12 text-center">
        <div className="inline-block p-4 bg-muted/30 border border-primary/20 rounded-lg">
          <p className="text-sm text-muted-foreground max-w-2xl">
            <strong>Not a chatbot.</strong> We're infrastructure. You bring the AI, we bring the memory layer.
          </p>
        </div>
      </div>
    </div>
  );
};
