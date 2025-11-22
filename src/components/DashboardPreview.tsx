import { Card } from '@/components/ui/card';
import { Activity, MessageSquare, Network, Star } from 'lucide-react';

export const DashboardPreview = () => {
  return (
    <div className="h-full overflow-hidden relative">
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="p-6">
            <div className="flex items-center gap-3">
              <MessageSquare className="h-5 w-5 text-muted-foreground" />
              <div>
                <div className="text-2xl font-mono font-bold">1,247</div>
                <div className="text-xs text-muted-foreground">Total Messages</div>
              </div>
            </div>
          </Card>
          
          <Card className="p-6">
            <div className="flex items-center gap-3">
              <Activity className="h-5 w-5 text-muted-foreground" />
              <div>
                <div className="text-2xl font-mono font-bold">89</div>
                <div className="text-xs text-muted-foreground">Conversations</div>
              </div>
            </div>
          </Card>
          
          <Card className="p-6">
            <div className="flex items-center gap-3">
              <Star className="h-5 w-5 text-muted-foreground" />
              <div>
                <div className="text-2xl font-mono font-bold">42</div>
                <div className="text-xs text-muted-foreground">Recent Activity</div>
              </div>
            </div>
          </Card>
          
          <Card className="p-6">
            <div className="flex items-center gap-3">
              <Network className="h-5 w-5 text-muted-foreground" />
              <div>
                <div className="text-2xl font-mono font-bold">15</div>
                <div className="text-xs text-muted-foreground">Topics</div>
              </div>
            </div>
          </Card>
        </div>

        {/* Timeline & Graph */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Timeline */}
          <Card className="p-6">
            <h3 className="text-sm font-semibold mb-4">Recent Timeline</h3>
            <div className="space-y-4">
              {[
                { date: '2025-03-15', topic: 'Product Strategy', count: 12 },
                { date: '2025-03-14', topic: 'Team Planning', count: 8 },
                { date: '2025-03-13', topic: 'Technical Discussion', count: 15 },
              ].map((item, i) => (
                <div key={i} className="flex items-center justify-between text-xs border-l-2 border-border pl-3">
                  <div>
                    <div className="font-mono text-muted-foreground">{item.date}</div>
                    <div className="font-medium">{item.topic}</div>
                  </div>
                  <div className="font-mono text-muted-foreground">{item.count} msgs</div>
                </div>
              ))}
            </div>
          </Card>

          {/* Knowledge Graph Preview */}
          <Card className="p-6">
            <h3 className="text-sm font-semibold mb-4">Knowledge Graph</h3>
            <div className="h-[200px] flex items-center justify-center border border-border rounded">
              <div className="text-center">
                <Network className="h-12 w-12 mx-auto text-muted-foreground mb-2" />
                <div className="text-xs text-muted-foreground font-mono">
                  Connected insights & topics
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* Top Topics */}
        <Card className="p-6">
          <h3 className="text-sm font-semibold mb-4">Top Topics</h3>
          <div className="space-y-2">
            {[
              { topic: 'Product Development', pct: 85 },
              { topic: 'Strategic Planning', pct: 72 },
              { topic: 'Technical Architecture', pct: 68 },
              { topic: 'Team Coordination', pct: 45 },
            ].map((item, i) => (
              <div key={i} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">{item.topic}</span>
                  <span className="font-mono text-muted-foreground">{item.pct}%</span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-foreground transition-all" 
                    style={{ width: `${item.pct}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Blur Overlay */}
      <div className="absolute inset-0 backdrop-blur-[2px] bg-background/30 flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="text-sm font-medium tracking-tight">
            Sign up to unlock full interface
          </div>
        </div>
      </div>
    </div>
  );
};
