import { Zap, Crown, Check, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useNavigate } from "react-router-dom";

interface UpgradeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentCount: number;
  limit: number;
}

const proFeatures = [
  "Unlimited dumps per month",
  "Priority AI processing",
  "Advanced analytics",
  "Email weekly digest",
  "Priority support",
];

export function UpgradeModal({ open, onOpenChange, currentCount, limit }: UpgradeModalProps) {
  const navigate = useNavigate();

  const handleUpgrade = () => {
    onOpenChange(false);
    navigate("/pricing");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center justify-center mb-4">
            <div className="w-16 h-16 bg-accent rounded-2xl flex items-center justify-center">
              <Crown className="w-8 h-8 text-accent-foreground" />
            </div>
          </div>
          <DialogTitle className="text-center text-xl">
            You've Hit Your Free Limit
          </DialogTitle>
          <DialogDescription className="text-center">
            You've used all {limit} free dumps this month ({currentCount}/{limit}).
            <br />
            Upgrade to Pro for unlimited dumps!
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Pro features */}
          <div className="bg-muted/50 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Zap className="w-4 h-4 text-primary" />
              Pro includes:
            </div>
            <ul className="space-y-2">
              {proFeatures.map((feature) => (
                <li key={feature} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Check className="w-4 h-4 text-primary flex-shrink-0" />
                  {feature}
                </li>
              ))}
            </ul>
          </div>

          {/* Price */}
          <div className="text-center">
            <span className="text-3xl font-bold">$9</span>
            <span className="text-muted-foreground">/month</span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Button onClick={handleUpgrade} className="w-full">
            Upgrade to Pro
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="w-full">
            Maybe later
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default UpgradeModal;
