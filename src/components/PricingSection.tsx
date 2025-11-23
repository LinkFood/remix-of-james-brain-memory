import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';

export const PricingSection = () => {
  const navigate = useNavigate();

  const tiers = [
    {
      name: 'Free',
      price: '$0',
      period: 'forever',
      description: 'Try the system. See if it works for you.',
      features: [
        '100 messages/month',
        '1 API key connection',
        'Basic memory injection',
        'Export your data anytime',
        'Email support',
      ],
      cta: 'Start Free',
      highlighted: false,
    },
    {
      name: 'Pro',
      price: '$20',
      period: 'per month',
      description: 'For power users who chat daily.',
      features: [
        'Unlimited messages',
        'Multiple API keys',
        'Advanced semantic search',
        'Priority memory injection',
        'Brain reports & insights',
        'Knowledge graph',
        'Priority support',
        'Export unlimited data',
      ],
      cta: 'Start Pro Trial',
      highlighted: true,
    },
    {
      name: 'Enterprise',
      price: 'Custom',
      period: 'contact sales',
      description: 'For teams who need control.',
      features: [
        'Everything in Pro',
        'Team collaboration',
        'SSO & advanced security',
        'Custom memory policies',
        'Dedicated support',
        'SLA guarantees',
        'On-premise option',
      ],
      cta: 'Contact Sales',
      highlighted: false,
    },
  ];

  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-16">
      <div className="text-center mb-12">
        <h3 className="text-3xl font-bold mb-3">Simple, Transparent Pricing</h3>
        <p className="text-muted-foreground">
          Pay for what you use. No hidden fees. Cancel anytime.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {tiers.map((tier, idx) => (
          <div
            key={tier.name}
            className={`relative flex flex-col p-8 border rounded-xl transition-all duration-300 animate-in fade-in slide-in-from-bottom-4 ${
              tier.highlighted
                ? 'border-primary shadow-lg shadow-primary/20 scale-105 bg-primary/5'
                : 'border-border hover:border-primary/50 bg-background'
            }`}
            style={{ animationDelay: `${idx * 100}ms`, animationFillMode: 'backwards' }}
          >
            {tier.highlighted && (
              <div className="absolute -top-4 left-1/2 -translate-x-1/2 px-4 py-1 bg-primary text-primary-foreground text-xs font-semibold rounded-full">
                Most Popular
              </div>
            )}

            <div className="mb-6">
              <h4 className="text-xl font-bold mb-2">{tier.name}</h4>
              <div className="flex items-baseline gap-1 mb-2">
                <span className="text-4xl font-bold">{tier.price}</span>
                {tier.period !== 'contact sales' && (
                  <span className="text-sm text-muted-foreground">/{tier.period}</span>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{tier.description}</p>
            </div>

            <div className="flex-1 space-y-3 mb-8">
              {tier.features.map((feature) => (
                <div key={feature} className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                  <span className="text-sm">{feature}</span>
                </div>
              ))}
            </div>

            <Button
              onClick={() => navigate('/auth')}
              variant={tier.highlighted ? 'default' : 'outline'}
              className="w-full"
              size="lg"
            >
              {tier.cta}
            </Button>
          </div>
        ))}
      </div>

      <div className="mt-12 text-center">
        <p className="text-sm text-muted-foreground max-w-2xl mx-auto">
          All plans include full data ownership, export capabilities, and the ability to delete your data anytime. 
          No lock-in. Your memory, your rules.
        </p>
      </div>
    </div>
  );
};
