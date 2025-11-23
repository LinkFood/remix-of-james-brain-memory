import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DollarSign, TrendingUp, AlertCircle, Clock, Settings } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart, Bar } from "recharts";
import { toast } from "sonner";
import { MemoryUsageStats } from "@/components/MemoryUsageStats";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface UsageAnalyticsProps {
  userId: string;
}

interface ProviderUsage {
  provider: string;
  tokens: number;
  cost: number;
  messages: number;
}

interface DailyUsage {
  date: string;
  openai: number;
  anthropic: number;
  google: number;
  total: number;
}

// Pricing per 1M tokens (approximate average across models)
const PRICING = {
  openai: {
    input: 2.50, // Average of GPT-4 models
    output: 10.00,
  },
  anthropic: {
    input: 3.00, // Claude pricing
    output: 15.00,
  },
  google: {
    input: 0.50, // Gemini pricing
    output: 1.50,
  },
};

const UsageAnalytics = ({ userId }: UsageAnalyticsProps) => {
  const [providerUsage, setProviderUsage] = useState<ProviderUsage[]>([]);
  const [dailyUsage, setDailyUsage] = useState<DailyUsage[]>([]);
  const [totalCost, setTotalCost] = useState(0);
  const [totalTokens, setTotalTokens] = useState(0);
  const [threshold, setThreshold] = useState<number>(10);
  const [editingThreshold, setEditingThreshold] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUsageData();
    loadThreshold();
  }, [userId]);

  const loadThreshold = () => {
    const saved = localStorage.getItem(`spending_threshold_${userId}`);
    if (saved) setThreshold(parseFloat(saved));
  };

  const saveThreshold = () => {
    localStorage.setItem(`spending_threshold_${userId}`, threshold.toString());
    setEditingThreshold(false);
    toast.success("Spending threshold updated");
  };

  const fetchUsageData = async () => {
    try {
      const { data: messages, error } = await supabase
        .from("messages")
        .select("provider, model_used, token_count, created_at, role")
        .eq("user_id", userId)
        .not("provider", "is", null);

      if (error) throw error;

      // Calculate provider usage
      const providerStats: { [key: string]: { tokens: number; messages: number } } = {};
      const dailyStats: { [key: string]: { openai: number; anthropic: number; google: number } } = {};
      
      let totalTokenCount = 0;
      let totalCostCalc = 0;

      messages?.forEach((msg) => {
        const provider = msg.provider || "unknown";
        const tokens = msg.token_count || estimateTokens(msg.role);
        const date = new Date(msg.created_at).toLocaleDateString();

        // Provider stats
        if (!providerStats[provider]) {
          providerStats[provider] = { tokens: 0, messages: 0 };
        }
        providerStats[provider].tokens += tokens;
        providerStats[provider].messages += 1;

        // Daily stats
        if (!dailyStats[date]) {
          dailyStats[date] = { openai: 0, anthropic: 0, google: 0 };
        }
        const cost = calculateCost(provider, tokens, msg.role);
        dailyStats[date][provider as keyof typeof dailyStats[string]] += cost;

        totalTokenCount += tokens;
        totalCostCalc += cost;
      });

      // Convert to arrays
      const providerArray = Object.entries(providerStats).map(([provider, stats]) => ({
        provider,
        tokens: stats.tokens,
        messages: stats.messages,
        cost: calculateProviderCost(provider, stats.tokens),
      }));

      const dailyArray = Object.entries(dailyStats)
        .map(([date, costs]) => ({
          date,
          openai: costs.openai,
          anthropic: costs.anthropic,
          google: costs.google,
          total: costs.openai + costs.anthropic + costs.google,
        }))
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
        .slice(-30); // Last 30 days

      setProviderUsage(providerArray);
      setDailyUsage(dailyArray);
      setTotalCost(totalCostCalc);
      setTotalTokens(totalTokenCount);
    } catch (error) {
      console.error("Failed to fetch usage data:", error);
      toast.error("Failed to load analytics");
    } finally {
      setLoading(false);
    }
  };

  const estimateTokens = (role: string): number => {
    // Rough estimate: user messages ~100 tokens, assistant ~200 tokens
    return role === "user" ? 100 : 200;
  };

  const calculateCost = (provider: string, tokens: number, role: string): number => {
    const pricing = PRICING[provider as keyof typeof PRICING];
    if (!pricing) return 0;
    
    const rate = role === "user" ? pricing.input : pricing.output;
    return (tokens / 1_000_000) * rate;
  };

  const calculateProviderCost = (provider: string, tokens: number): number => {
    // Average cost across input/output
    const pricing = PRICING[provider as keyof typeof PRICING];
    if (!pricing) return 0;
    
    const avgRate = (pricing.input + pricing.output) / 2;
    return (tokens / 1_000_000) * avgRate;
  };

  const getProviderColor = (provider: string) => {
    switch (provider) {
      case "openai": return "hsl(120, 70%, 45%)";
      case "anthropic": return "hsl(280, 70%, 55%)";
      case "google": return "hsl(40, 90%, 55%)";
      default: return "hsl(180, 100%, 50%)";
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <Card key={i} className="p-6 bg-card border-border animate-pulse">
              <div className="h-24 bg-muted rounded" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const isOverThreshold = totalCost > threshold;
  const thresholdPercentage = (totalCost / threshold) * 100;

  return (
    <div className="space-y-6">
      <Tabs defaultValue="costs" className="w-full">
        <TabsList className="grid w-full grid-cols-2 max-w-md">
          <TabsTrigger value="costs">API Costs</TabsTrigger>
          <TabsTrigger value="memory">Memory Stats</TabsTrigger>
        </TabsList>

        <TabsContent value="costs" className="space-y-6 mt-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-6 bg-card border-border hover:border-primary/50 transition-all">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center">
              <DollarSign className="w-6 h-6 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">${totalCost.toFixed(4)}</p>
              <p className="text-sm text-muted-foreground">Total Spent</p>
            </div>
          </div>
        </Card>

        <Card className="p-6 bg-card border-border hover:border-primary/50 transition-all">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-accent/10 rounded-xl flex items-center justify-center">
              <TrendingUp className="w-6 h-6 text-accent" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{(totalTokens / 1000).toFixed(1)}K</p>
              <p className="text-sm text-muted-foreground">Total Tokens</p>
            </div>
          </div>
        </Card>

        <Card className="p-6 bg-card border-border hover:border-primary/50 transition-all">
          <div className="flex items-center gap-4">
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${editingThreshold ? 'bg-primary/10' : 'bg-muted'}`}>
              {editingThreshold ? (
                <Settings className="w-6 h-6 text-primary animate-spin" />
              ) : (
                <Clock className="w-6 h-6 text-muted-foreground" />
              )}
            </div>
            <div className="flex-1">
              {editingThreshold ? (
                <div className="flex gap-2">
                  <Input
                    type="number"
                    value={threshold}
                    onChange={(e) => setThreshold(parseFloat(e.target.value))}
                    className="h-8 text-sm"
                    step="0.01"
                    min="0"
                  />
                  <Button size="sm" onClick={saveThreshold}>Save</Button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <p className="text-2xl font-bold text-foreground">${threshold.toFixed(2)}</p>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      onClick={() => setEditingThreshold(true)}
                      className="h-6 px-2"
                    >
                      Edit
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground">Monthly Threshold</p>
                </>
              )}
            </div>
          </div>
        </Card>
      </div>

      {/* Threshold Alert */}
      {isOverThreshold && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            You've exceeded your spending threshold by ${(totalCost - threshold).toFixed(4)}! 
            ({thresholdPercentage.toFixed(0)}% of limit)
          </AlertDescription>
        </Alert>
      )}

      {thresholdPercentage >= 80 && thresholdPercentage < 100 && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            You're approaching your spending threshold ({thresholdPercentage.toFixed(0)}% used).
          </AlertDescription>
        </Alert>
      )}

      {/* Provider Breakdown */}
      <Card className="p-6 bg-card border-border">
        <h3 className="text-lg font-semibold text-foreground mb-4">Cost by Provider</h3>
        <div className="space-y-4">
          {providerUsage.map((usage) => (
            <div key={usage.provider} className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Badge 
                    style={{ backgroundColor: getProviderColor(usage.provider) + '20', color: getProviderColor(usage.provider) }}
                    className="capitalize font-medium"
                  >
                    {usage.provider}
                  </Badge>
                  <span className="text-sm text-muted-foreground">
                    {usage.messages} messages • {(usage.tokens / 1000).toFixed(1)}K tokens
                  </span>
                </div>
                <span className="text-lg font-bold text-foreground">
                  ${usage.cost.toFixed(4)}
                </span>
              </div>
              <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full transition-all"
                  style={{
                    width: `${(usage.cost / totalCost) * 100}%`,
                    backgroundColor: getProviderColor(usage.provider),
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Spending Trends */}
      {dailyUsage.length > 0 && (
        <Card className="p-6 bg-card border-border">
          <h3 className="text-lg font-semibold text-foreground mb-4">Spending Trends (Last 30 Days)</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={dailyUsage}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 20% 18%)" />
              <XAxis 
                dataKey="date" 
                stroke="hsl(180 30% 60%)"
                style={{ fontSize: '12px' }}
              />
              <YAxis 
                stroke="hsl(180 30% 60%)"
                style={{ fontSize: '12px' }}
                tickFormatter={(value) => `$${value.toFixed(3)}`}
              />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: 'hsl(220 25% 8%)', 
                  border: '1px solid hsl(220 20% 18%)',
                  borderRadius: '8px'
                }}
                formatter={(value: number) => `$${value.toFixed(4)}`}
              />
              <Legend />
              <Line 
                type="monotone" 
                dataKey="openai" 
                stroke="hsl(120, 70%, 45%)" 
                strokeWidth={2}
                name="OpenAI"
              />
              <Line 
                type="monotone" 
                dataKey="anthropic" 
                stroke="hsl(280, 70%, 55%)" 
                strokeWidth={2}
                name="Anthropic"
              />
              <Line 
                type="monotone" 
                dataKey="google" 
                stroke="hsl(40, 90%, 55%)" 
                strokeWidth={2}
                name="Google"
              />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Token Usage Bar Chart */}
      {providerUsage.length > 0 && (
        <Card className="p-6 bg-card border-border">
          <h3 className="text-lg font-semibold text-foreground mb-4">Token Usage by Provider</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={providerUsage}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 20% 18%)" />
              <XAxis 
                dataKey="provider" 
                stroke="hsl(180 30% 60%)"
                style={{ fontSize: '12px' }}
              />
              <YAxis 
                stroke="hsl(180 30% 60%)"
                style={{ fontSize: '12px' }}
                tickFormatter={(value) => `${(value / 1000).toFixed(0)}K`}
              />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: 'hsl(220 25% 8%)', 
                  border: '1px solid hsl(220 20% 18%)',
                  borderRadius: '8px'
                }}
                formatter={(value: number) => `${(value / 1000).toFixed(1)}K tokens`}
              />
              <Bar 
                dataKey="tokens" 
                fill="hsl(180 100% 50%)"
                radius={[8, 8, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Pricing Information */}
      <Card className="p-6 bg-card border-border">
        <h3 className="text-lg font-semibold text-foreground mb-4">Current Pricing (per 1M tokens)</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Badge style={{ backgroundColor: getProviderColor("openai") + '20', color: getProviderColor("openai") }}>
              OpenAI
            </Badge>
            <div className="text-sm text-muted-foreground">
              <p>Input: ${PRICING.openai.input.toFixed(2)}</p>
              <p>Output: ${PRICING.openai.output.toFixed(2)}</p>
            </div>
          </div>
          <div className="space-y-2">
            <Badge style={{ backgroundColor: getProviderColor("anthropic") + '20', color: getProviderColor("anthropic") }}>
              Anthropic
            </Badge>
            <div className="text-sm text-muted-foreground">
              <p>Input: ${PRICING.anthropic.input.toFixed(2)}</p>
              <p>Output: ${PRICING.anthropic.output.toFixed(2)}</p>
            </div>
          </div>
          <div className="space-y-2">
            <Badge style={{ backgroundColor: getProviderColor("google") + '20', color: getProviderColor("google") }}>
              Google
            </Badge>
            <div className="text-sm text-muted-foreground">
              <p>Input: ${PRICING.google.input.toFixed(2)}</p>
              <p>Output: ${PRICING.google.output.toFixed(2)}</p>
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-4">
          * Prices are approximate averages. Actual costs may vary by model.
        </p>
      </Card>
        </TabsContent>

        <TabsContent value="memory" className="space-y-6 mt-6">
          <MemoryUsageStats userId={userId} />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default UsageAnalytics;
