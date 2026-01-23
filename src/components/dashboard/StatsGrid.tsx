import { Clock, Hash, Star, TrendingUp } from "lucide-react";
import StatsCard from "./StatsCard";

interface DashboardStats {
  total: number;
  today: number;
  important: number;
  byType: Record<string, number>;
}

interface StatsGridProps {
  stats: DashboardStats;
  starredCount: number;
}

const StatsGrid = ({ stats, starredCount }: StatsGridProps) => (
  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
    <StatsCard
      icon={<Hash className="w-4 h-4 text-muted-foreground" />}
      value={stats.total}
      label="Total entries"
    />
    <StatsCard
      icon={<Clock className="w-4 h-4 text-blue-500" />}
      value={stats.today}
      label="Today"
    />
    <StatsCard
      icon={<TrendingUp className="w-4 h-4 text-orange-500" />}
      value={stats.important}
      label="Important"
    />
    <StatsCard
      icon={<Star className="w-4 h-4 text-yellow-500" />}
      value={starredCount}
      label="Starred"
    />
  </div>
);

export default StatsGrid;
