import { Card } from "@/components/ui/card";

interface StatsCardProps {
  icon: React.ReactNode;
  value: number;
  label: string;
}

const StatsCard = ({ icon, value, label }: StatsCardProps) => (
  <Card className="p-3">
    <div className="flex items-center gap-2">
      {icon}
      <div>
        <p className="text-2xl font-bold">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  </Card>
);

export default StatsCard;
