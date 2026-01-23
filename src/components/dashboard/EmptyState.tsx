import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Loader2, Sparkles } from "lucide-react";

interface EmptyStateProps {
  onTryExample: (text: string) => void;
  onLoadSampleData: () => Promise<void>;
}

const examples = [
  { label: "Grocery list", text: "Buy milk, eggs, bread, and butter" },
  { label: "Code snippet", text: "const add = (a, b) => a + b;" },
  { label: "App idea", text: "App idea: an alarm that only stops when you solve a puzzle" },
];

const EmptyState = ({ onTryExample, onLoadSampleData }: EmptyStateProps) => {
  const [loading, setLoading] = useState(false);

  const handleLoadSample = async () => {
    setLoading(true);
    await onLoadSampleData();
    setLoading(false);
  };

  return (
    <Card className="p-8 text-center">
      <div className="max-w-md mx-auto">
        <Sparkles className="w-12 h-12 mx-auto text-primary/50 mb-4" />
        <h3 className="text-lg font-medium mb-2">Your brain is empty</h3>
        <p className="text-sm text-muted-foreground mb-6">
          Start dumping anything and watch your second brain grow.
        </p>

        {/* Quick Try Examples */}
        <div className="flex flex-wrap justify-center gap-2 mb-6">
          {examples.map((ex) => (
            <Button
              key={ex.label}
              variant="outline"
              size="sm"
              onClick={() => onTryExample(ex.text)}
              className="text-xs"
            >
              Try: "{ex.label}"
            </Button>
          ))}
        </div>

        {/* Load Sample Data */}
        <Button
          variant="secondary"
          onClick={handleLoadSample}
          disabled={loading}
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Loading...
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4 mr-2" />
              Load Sample Data
            </>
          )}
        </Button>
      </div>
    </Card>
  );
};

export default EmptyState;
