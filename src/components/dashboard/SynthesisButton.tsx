import { Brain, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SynthesisButtonProps {
  onSynthesize: () => void;
  loading: boolean;
}

const SynthesisButton = ({ onSynthesize, loading }: SynthesisButtonProps) => (
  <Button
    variant="outline"
    className="w-full gap-2 text-muted-foreground hover:text-foreground"
    onClick={onSynthesize}
    disabled={loading}
  >
    {loading ? (
      <Loader2 className="w-4 h-4 animate-spin" />
    ) : (
      <Brain className="w-4 h-4" />
    )}
    What am I focused on?
  </Button>
);

export default SynthesisButton;
