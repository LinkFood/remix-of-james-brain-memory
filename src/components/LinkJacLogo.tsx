import { Brain } from "lucide-react";
import { cn } from "@/lib/utils";

interface LinkJacLogoProps {
  size?: "sm" | "md" | "lg" | "xl";
  showIcon?: boolean;
  className?: string;
  isThinking?: boolean;
}

const sizeConfig = {
  sm: {
    container: "gap-1.5",
    icon: "w-6 h-6",
    iconBg: "w-7 h-7 rounded-md",
    text: "text-base",
  },
  md: {
    container: "gap-2",
    icon: "w-5 h-5",
    iconBg: "w-9 h-9 rounded-lg",
    text: "text-lg",
  },
  lg: {
    container: "gap-2.5",
    icon: "w-7 h-7",
    iconBg: "w-11 h-11 rounded-xl",
    text: "text-2xl",
  },
  xl: {
    container: "gap-3",
    icon: "w-9 h-9",
    iconBg: "w-14 h-14 rounded-2xl",
    text: "text-3xl",
  },
};

// Standalone brain icon with thinking animation
export function LinkJacBrainIcon({ 
  isThinking = false, 
  className 
}: { 
  isThinking?: boolean; 
  className?: string;
}) {
  return (
    <Brain 
      className={cn(
        "text-sky-400 transition-all duration-300",
        isThinking && "animate-pulse",
        className
      )} 
    />
  );
}

export function LinkJacLogo({ 
  size = "md", 
  showIcon = true,
  className,
  isThinking = false
}: LinkJacLogoProps) {
  const config = sizeConfig[size];

  return (
    <div className={cn("flex items-center group", config.container, className)}>
      {showIcon && (
        <div className={cn(
          "bg-sky-400/10 flex items-center justify-center transition-all duration-300",
          config.iconBg
        )}>
          <Brain 
            className={cn(
              "text-sky-400 transition-all duration-300",
              config.icon,
              isThinking && "animate-pulse",
              !isThinking && "group-hover:scale-110 group-hover:animate-pulse"
            )} 
          />
        </div>
      )}
      <span className={cn("font-bold tracking-tight", config.text)}>
        <span className="text-foreground">Link</span>
        <span className="text-sky-400">Jac</span>
      </span>
    </div>
  );
}

// Standalone SVG export for favicon/external use
export function LinkJacLogoSVG({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="LinkJac logo"
    >
      {/* Background */}
      <rect
        width="32"
        height="32"
        rx="8"
        fill="#38bdf8"
        fillOpacity="0.1"
      />
      {/* Brain icon (simplified Lucide brain path) */}
      <g transform="translate(4, 4)" fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>
        <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>
        <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>
        <path d="M12 18v4"/>
        <path d="M8 18h8"/>
      </g>
    </svg>
  );
}

export default LinkJacLogo;
