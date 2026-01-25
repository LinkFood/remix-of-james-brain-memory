import { Brain } from "lucide-react";
import { cn } from "@/lib/utils";

interface LinkJacLogoProps {
  size?: "sm" | "md" | "lg" | "xl";
  showIcon?: boolean;
  className?: string;
}

const sizeConfig = {
  sm: {
    container: "gap-1.5",
    icon: "w-6 h-6",
    iconBg: "w-7 h-7 rounded-md",
    text: "text-base",
    accent: "text-sm",
  },
  md: {
    container: "gap-2",
    icon: "w-5 h-5",
    iconBg: "w-9 h-9 rounded-lg",
    text: "text-lg",
    accent: "text-base",
  },
  lg: {
    container: "gap-2.5",
    icon: "w-7 h-7",
    iconBg: "w-11 h-11 rounded-xl",
    text: "text-2xl",
    accent: "text-xl",
  },
  xl: {
    container: "gap-3",
    icon: "w-9 h-9",
    iconBg: "w-14 h-14 rounded-2xl",
    text: "text-3xl",
    accent: "text-2xl",
  },
};

export function LinkJacLogo({ 
  size = "md", 
  showIcon = true,
  className 
}: LinkJacLogoProps) {
  const config = sizeConfig[size];

  return (
    <div className={cn("flex items-center", config.container, className)}>
      {showIcon && (
        <div className={cn(
          "bg-primary/10 flex items-center justify-center",
          config.iconBg
        )}>
          <Brain className={cn("text-primary", config.icon)} />
        </div>
      )}
      <span className={cn("font-bold tracking-tight", config.text)}>
        <span className="text-foreground">Link</span>
        <span className="text-primary">Jac</span>
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
      {/* Background circle */}
      <rect
        width="32"
        height="32"
        rx="8"
        fill="currentColor"
        className="text-primary/10"
      />
      {/* Brain icon simplified */}
      <g transform="translate(6, 6)" className="text-primary">
        <path
          d="M10 2C7.5 2 5.5 4 5.5 6.5C5.5 7.5 5.8 8.4 6.3 9.1C4.4 9.6 3 11.3 3 13.3C3 15.5 4.6 17.3 6.7 17.8C6.3 18.4 6 19.1 6 20C6 21.7 7.3 23 9 23H11C12.7 23 14 21.7 14 20C14 19.1 13.7 18.4 13.3 17.8C15.4 17.3 17 15.5 17 13.3C17 11.3 15.6 9.6 13.7 9.1C14.2 8.4 14.5 7.5 14.5 6.5C14.5 4 12.5 2 10 2Z"
          fill="currentColor"
        />
        <circle cx="8" cy="10" r="1.5" fill="hsl(var(--background))" />
        <circle cx="12" cy="10" r="1.5" fill="hsl(var(--background))" />
        <path
          d="M10 12V16"
          stroke="hsl(var(--background))"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}

export default LinkJacLogo;
