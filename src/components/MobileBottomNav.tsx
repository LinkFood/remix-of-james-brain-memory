import { MessageSquare, Database, TrendingUp, Settings, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface MobileBottomNavProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  onMenuClick: () => void;
}

const MobileBottomNav = ({ activeTab, onTabChange, onMenuClick }: MobileBottomNavProps) => {
  const navItems = [
    { id: "chat", icon: MessageSquare, label: "Chat" },
    { id: "memory", icon: Database, label: "Memory" },
    { id: "analytics", icon: TrendingUp, label: "Analytics" },
    { id: "settings", icon: Settings, label: "Settings" },
  ];

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-card border-t border-border z-50 safe-area-inset-bottom">
      <div className="flex items-center justify-around h-16">
        <Button
          onClick={onMenuClick}
          variant="ghost"
          className="flex flex-col items-center gap-1 h-full flex-1 rounded-none touch-target"
        >
          <Menu className="h-5 w-5" />
          <span className="text-xs">Menu</span>
        </Button>
        
        {navItems.map((item) => (
          <Button
            key={item.id}
            onClick={() => onTabChange(item.id)}
            variant="ghost"
            className={cn(
              "flex flex-col items-center gap-1 h-full flex-1 rounded-none touch-target",
              activeTab === item.id && "text-primary bg-primary/10"
            )}
          >
            <item.icon className="h-5 w-5" />
            <span className="text-xs">{item.label}</span>
          </Button>
        ))}
      </div>
    </nav>
  );
};

export default MobileBottomNav;
