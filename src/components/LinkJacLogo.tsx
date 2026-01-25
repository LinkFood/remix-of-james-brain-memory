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
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn(className, isThinking && "brain-thinking")}
      aria-label="LinkJac brain"
    >
      {/* Brain outline */}
      <path
        d="M12 4.5C9.5 4.5 7.5 6.5 7.5 9C7.5 9.8 7.7 10.5 8.1 11.1C6.4 11.5 5 13 5 14.8C5 16.8 6.4 18.4 8.3 18.8C8 19.3 7.8 19.9 7.8 20.5C7.8 21.9 9 23 10.4 23H13.6C15 23 16.2 21.9 16.2 20.5C16.2 19.9 16 19.3 15.7 18.8C17.6 18.4 19 16.8 19 14.8C19 13 17.6 11.5 15.9 11.1C16.3 10.5 16.5 9.8 16.5 9C16.5 6.5 14.5 4.5 12 4.5Z"
        fill="currentColor"
        className="text-sky-400"
      />
      
      {/* Neuron dots - these animate */}
      <circle 
        cx="9.5" 
        cy="12" 
        r="1.5" 
        fill="hsl(var(--background))" 
        className="neuron-1"
      />
      <circle 
        cx="14.5" 
        cy="12" 
        r="1.5" 
        fill="hsl(var(--background))" 
        className="neuron-2"
      />
      
      {/* Synapse line - animates */}
      <path
        d="M12 13V17"
        stroke="hsl(var(--background))"
        strokeWidth="1.5"
        strokeLinecap="round"
        className="synapse"
      />
      
      {/* Small connector dots */}
      <circle 
        cx="10.5" 
        cy="15" 
        r="0.8" 
        fill="hsl(var(--background))" 
        className="neuron-1"
      />
      <circle 
        cx="13.5" 
        cy="15" 
        r="0.8" 
        fill="hsl(var(--background))" 
        className="neuron-2"
      />
    </svg>
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
          config.iconBg,
          !isThinking && "group-hover:[&_.neuron-1]:animate-[brain-neuron-pulse_2s_ease-in-out_infinite]",
          !isThinking && "group-hover:[&_.neuron-2]:animate-[brain-neuron-pulse_2s_ease-in-out_infinite_0.4s]",
          !isThinking && "group-hover:[&_.synapse]:animate-[brain-synapse-flow_2.5s_ease-in-out_infinite_0.2s]"
        )}>
          <LinkJacBrainIcon 
            isThinking={isThinking} 
            className={config.icon} 
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
      {/* Brain icon */}
      <g transform="translate(4, 4)">
        <path
          d="M12 4.5C9.5 4.5 7.5 6.5 7.5 9C7.5 9.8 7.7 10.5 8.1 11.1C6.4 11.5 5 13 5 14.8C5 16.8 6.4 18.4 8.3 18.8C8 19.3 7.8 19.9 7.8 20.5C7.8 21.9 9 23 10.4 23H13.6C15 23 16.2 21.9 16.2 20.5C16.2 19.9 16 19.3 15.7 18.8C17.6 18.4 19 16.8 19 14.8C19 13 17.6 11.5 15.9 11.1C16.3 10.5 16.5 9.8 16.5 9C16.5 6.5 14.5 4.5 12 4.5Z"
          fill="#38bdf8"
        />
        <circle cx="9.5" cy="12" r="1.5" fill="white" />
        <circle cx="14.5" cy="12" r="1.5" fill="white" />
        <path d="M12 13V17" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
      </g>
    </svg>
  );
}

export default LinkJacLogo;
