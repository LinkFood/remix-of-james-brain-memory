import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * Animated loading spinner
 */
export function LoadingSpinner({ size = 'md', className }: LoadingSpinnerProps) {
  const sizeClasses = {
    sm: 'h-4 w-4',
    md: 'h-6 w-6',
    lg: 'h-8 w-8',
  };

  return (
    <Loader2
      className={cn('animate-spin text-muted-foreground', sizeClasses[size], className)}
    />
  );
}

interface LoadingOverlayProps {
  message?: string;
}

/**
 * Full-screen loading overlay with message
 */
export function LoadingOverlay({ message = 'Loading...' }: LoadingOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4">
        <LoadingSpinner size="lg" />
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

interface LoadingCardProps {
  message?: string;
  className?: string;
}

/**
 * Loading indicator styled as a card
 */
export function LoadingCard({ message = 'Loading...', className }: LoadingCardProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-center p-8 rounded-lg border border-border bg-card',
        className
      )}
    >
      <div className="flex flex-col items-center gap-3">
        <LoadingSpinner size="md" />
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

interface SkeletonCardProps {
  count?: number;
  compact?: boolean;
}

/**
 * Skeleton placeholder for entry cards
 */
export function SkeletonCard({ count = 1, compact = false }: SkeletonCardProps) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={cn(
            'rounded-lg border border-border bg-card animate-pulse',
            compact ? 'p-3' : 'p-4'
          )}
        >
          {/* Header skeleton */}
          <div className="flex items-start gap-3 mb-3">
            <div className="h-8 w-8 rounded-md bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-1/3 rounded bg-muted" />
              <div className="h-3 w-1/4 rounded bg-muted" />
            </div>
          </div>

          {/* Content skeleton */}
          {!compact && (
            <div className="space-y-2">
              <div className="h-3 w-full rounded bg-muted" />
              <div className="h-3 w-4/5 rounded bg-muted" />
              <div className="h-3 w-2/3 rounded bg-muted" />
            </div>
          )}

          {/* Tags skeleton */}
          {!compact && (
            <div className="flex gap-2 mt-3">
              <div className="h-5 w-12 rounded-full bg-muted" />
              <div className="h-5 w-16 rounded-full bg-muted" />
            </div>
          )}
        </div>
      ))}
    </>
  );
}

interface SkeletonListProps {
  rows?: number;
}

/**
 * Skeleton placeholder for list items
 */
export function SkeletonList({ rows = 3 }: SkeletonListProps) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 animate-pulse">
          <div className="h-4 w-4 rounded bg-muted" />
          <div className="h-4 flex-1 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

interface SkeletonTextProps {
  lines?: number;
  className?: string;
}

/**
 * Skeleton placeholder for text blocks
 */
export function SkeletonText({ lines = 3, className }: SkeletonTextProps) {
  return (
    <div className={cn('space-y-2 animate-pulse', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-3 rounded bg-muted"
          style={{
            width: i === lines - 1 ? '60%' : '100%',
          }}
        />
      ))}
    </div>
  );
}
