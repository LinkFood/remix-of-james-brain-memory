/**
 * AlphaPlaceholderSection — surface card with a "shipping iter #N" hint.
 *
 * v2 alpha surface ships iteratively per the audit-while-building shape
 * locked 2026-05-09. Each subsequent iter wires up one of the four alpha
 * surfaces. This component lets iter #1 render the FULL layout shape
 * (so captain validates the architecture immediately) while honestly
 * marking which sections are pending substrate.
 */

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';

interface Props {
  icon: LucideIcon;
  label: string;
  shippingIn: string;
  rationale: string;
  className?: string;
}

export function AlphaPlaceholderSection({ icon: Icon, label, shippingIn, rationale, className }: Props) {
  return (
    <Card className={cn('p-3 border-dashed bg-muted/5 flex flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          <Icon className="w-3 h-3" />
          {label}
        </span>
        <span className="text-[9px] font-mono uppercase tracking-wider text-primary/60">
          ships {shippingIn}
        </span>
      </div>
      <div className="text-[11px] text-muted-foreground/80 leading-snug">
        {rationale}
      </div>
    </Card>
  );
}
