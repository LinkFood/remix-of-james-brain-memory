import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  label?: string;
}

interface State {
  hasError: boolean;
  errMsg?: string;
}

/**
 * ChartSafe — error boundary specifically for Recharts subtrees.
 *
 * Why it exists: decimal.js (used by Recharts for precision math) throws
 * `[DecimalError] LN10 precision limit exceeded` when it tries to compute
 * log ticks on an axis domain containing NaN, Infinity, or an empty
 * Math.min/max spread. A single bad row in a dataset takes down the whole
 * page via the top-level ErrorBoundary. That's unacceptable for a 20+
 * panel dashboard.
 *
 * Wrap every Recharts chart in <ChartSafe>...</ChartSafe>. If the chart
 * subtree throws, we render a compact fallback and keep everything else
 * on the page alive. We also log to console so it's still debuggable.
 */
export class ChartSafe extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(err: unknown): State {
    const msg = err instanceof Error ? err.message : String(err);
    return { hasError: true, errMsg: msg };
  }

  componentDidCatch(err: unknown, info: unknown): void {
    // eslint-disable-next-line no-console
    console.error('[ChartSafe] chart crashed:', this.props.label, err, info);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="flex items-center justify-center h-full min-h-[60px] text-[10px] text-muted-foreground/60 border border-dashed border-border/40 rounded">
            chart unavailable{this.props.label ? ` — ${this.props.label}` : ''}
          </div>
        )
      );
    }
    return this.props.children;
  }
}
