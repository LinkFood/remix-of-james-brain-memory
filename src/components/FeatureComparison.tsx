import { Check, X } from 'lucide-react';

export const FeatureComparison = () => {
  const features = [
    { name: 'Chat with AI', demo: true, full: true },
    { name: 'Download conversation data', demo: true, full: true },
    { name: 'See data in real-time', demo: true, full: true },
    { name: 'Use your own API keys', demo: false, full: true },
    { name: 'Unlimited messages', demo: false, full: true },
    { name: 'Cross-provider memory', demo: false, full: true },
    { name: 'Semantic search', demo: false, full: true },
    { name: 'Importance scoring', demo: false, full: true },
    { name: 'Memory injection', demo: false, full: true },
    { name: 'Full data export (JSON/CSV)', demo: false, full: true },
    { name: 'Brain reports & insights', demo: false, full: true },
  ];

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-8">
      <div className="text-center mb-8">
        <h3 className="text-2xl font-bold mb-2">Demo vs Full Account</h3>
        <p className="text-sm text-muted-foreground">
          Try it first. See the proof. Then decide if you want the full system.
        </p>
      </div>

      <div className="border border-border rounded-lg overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_auto] bg-muted/30">
          <div className="px-4 py-3 font-semibold text-sm">Feature</div>
          <div className="px-6 py-3 font-semibold text-sm text-center border-l border-border">
            Demo Mode
          </div>
          <div className="px-6 py-3 font-semibold text-sm text-center border-l border-border bg-primary/5">
            Full Account
          </div>
        </div>

        {features.map((feature, idx) => (
          <div
            key={feature.name}
            className={`grid grid-cols-[1fr_auto_auto] ${
              idx % 2 === 0 ? 'bg-background' : 'bg-muted/10'
            } border-t border-border`}
          >
            <div className="px-4 py-3 text-sm">{feature.name}</div>
            <div className="px-6 py-3 flex items-center justify-center border-l border-border">
              {feature.demo ? (
                <Check className="w-4 h-4 text-primary" />
              ) : (
                <X className="w-4 h-4 text-muted-foreground" />
              )}
            </div>
            <div className="px-6 py-3 flex items-center justify-center border-l border-border bg-primary/5">
              {feature.full ? (
                <Check className="w-4 h-4 text-primary" />
              ) : (
                <X className="w-4 h-4 text-muted-foreground" />
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 p-4 bg-primary/10 border border-primary/20 rounded-lg text-center">
        <p className="text-sm font-medium">
          🔒 Your data, your control. Export anytime. Delete with one click.
        </p>
      </div>
    </div>
  );
};
