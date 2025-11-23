import { Play, Zap, Database, Search, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const DemoVideoSection = () => {
  const steps = [
    {
      icon: Zap,
      title: 'Connect API Key',
      description: 'Add your OpenAI, Claude, or Google key. We never see it.',
      time: '0:10',
    },
    {
      icon: Database,
      title: 'Chat Naturally',
      description: 'Every message is captured and scored for importance.',
      time: '0:25',
    },
    {
      icon: Search,
      title: 'Memory Injection',
      description: 'Watch relevant context get injected automatically.',
      time: '0:45',
    },
    {
      icon: Download,
      title: 'Export & Own',
      description: 'Download your entire memory as JSON, CSV, or Markdown.',
      time: '1:00',
    },
  ];

  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-16">
      <div className="text-center mb-12">
        <h3 className="text-3xl font-bold mb-3">See It In Action</h3>
        <p className="text-muted-foreground">
          Watch how memory injection compounds your AI intelligence over time
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
        {/* Video Placeholder */}
        <div className="relative aspect-video bg-gradient-to-br from-primary/10 to-primary/5 border-2 border-primary/20 rounded-xl overflow-hidden group animate-in fade-in slide-in-from-left-8 duration-700">
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="w-20 h-20 rounded-full bg-primary/20 backdrop-blur-sm flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300">
              <Play className="w-10 h-10 text-primary ml-1" />
            </div>
            <p className="text-sm font-semibold">Interactive Demo</p>
            <p className="text-xs text-muted-foreground mt-1">1:30 walkthrough</p>
          </div>
          
          {/* Simulated video progress bar */}
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-background/20">
            <div className="h-full w-1/3 bg-primary animate-pulse" />
          </div>
        </div>

        {/* Timeline Steps */}
        <div className="space-y-4 animate-in fade-in slide-in-from-right-8 duration-700">
          {steps.map((step, idx) => {
            const Icon = step.icon;
            return (
              <div
                key={step.title}
                className="flex gap-4 p-4 border border-border rounded-lg hover:border-primary/50 transition-all duration-300 group cursor-pointer"
              >
                <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 group-hover:bg-primary/20 transition-colors">
                  <Icon className="w-6 h-6 text-primary" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <h4 className="font-semibold text-sm">{step.title}</h4>
                    <span className="text-xs text-muted-foreground font-mono">
                      {step.time}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {step.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-12 text-center">
        <div className="inline-flex items-center gap-3 p-4 bg-muted/30 border border-border rounded-lg">
          <Play className="w-5 h-5 text-primary" />
          <div className="text-left">
            <p className="text-sm font-semibold">Want to try it yourself?</p>
            <p className="text-xs text-muted-foreground">
              Use the live demo chat below - no signup required
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
