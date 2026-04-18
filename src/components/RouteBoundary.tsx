/**
 * RouteBoundary — per-route React error boundary.
 *
 * Wraps each <Route> element in App.tsx so a crash in one page (e.g.
 * BookEquityCurve LN10, ChatPanel stack overflow) is isolated and does not
 * nuke the whole shell. The top-level <ErrorBoundary> in App.tsx remains as
 * the last-resort safety net for anything outside routing (providers, layout,
 * etc.).
 *
 * Features:
 *   - Renders a compact card with the route name, a short explanation, and
 *     the truncated error message (full stack hidden but copyable).
 *   - "Retry" — bumps an internal resetKey so the children remount. If the
 *     error was transient (a bad data fetch that has since recovered, a
 *     one-off render race), this gets the user back in. If it throws again
 *     on remount, the boundary catches it again.
 *   - "Copy error details" — puts `name\nmessage\nstack\ncomponentStack`
 *     onto the clipboard for pasting into Slack / a bug report.
 *   - "Tell James" — mailto: draft with the error pre-filled. The plan
 *     allowed for a Slack webhook here if one is exposed to the browser;
 *     ct-slack-slash is HMAC-gated and not callable from the client, so we
 *     fall back to mailto as the plan explicitly permitted.
 *   - Navigation links back to the working parts of the app (Home, Health,
 *     Book, Scorecard).
 *   - Best-effort insert into `ct_ui_errors` so crashes show up on /health
 *     for post-mortem. If the insert itself fails, we swallow — the boundary
 *     must never throw.
 */

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, RefreshCw, ClipboardCopy, Mail, Home, Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { supabase } from '@/integrations/supabase/client';

interface Props {
  route: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
  resetKey: number;
}

const MAX_MESSAGE_CHARS = 200;

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function getSessionId(): string | null {
  try {
    const key = 'ct_session_id';
    let id = localStorage.getItem(key);
    if (!id) {
      id = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return null;
  }
}

export class RouteBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    componentStack: null,
    resetKey: 0,
  };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[RouteBoundary ${this.props.route}] caught error:`, error, errorInfo);

    this.setState({ componentStack: errorInfo.componentStack ?? null });

    // Best-effort log to ct_ui_errors. Never throw from here.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase.from('ct_ui_errors' as any) as any)
        .insert({
          route: this.props.route,
          error_name: error.name ?? 'Error',
          error_message: error.message ?? '',
          error_stack: [error.stack, errorInfo.componentStack].filter(Boolean).join('\n\n'),
          user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
          session_id: getSessionId(),
          resolved: false,
        })
        .then((res: { error: unknown } | null) => {
          if (res?.error) {
            console.warn('[RouteBoundary] ct_ui_errors insert failed (non-fatal):', res.error);
          }
        });
    } catch (logErr) {
      console.warn('[RouteBoundary] ct_ui_errors insert threw (swallowed):', logErr);
    }
  }

  private handleRetry = () => {
    // Bump resetKey -> child tree remounts. Clear error state so we render
    // children again; if they throw on remount, componentDidCatch fires.
    this.setState((prev) => ({
      hasError: false,
      error: null,
      componentStack: null,
      resetKey: prev.resetKey + 1,
    }));
  };

  private handleCopy = async () => {
    const { error, componentStack } = this.state;
    const payload = [
      `Route: ${this.props.route}`,
      `Time: ${new Date().toISOString()}`,
      `User-Agent: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'}`,
      '',
      `Name: ${error?.name ?? 'Error'}`,
      `Message: ${error?.message ?? ''}`,
      '',
      'Stack:',
      error?.stack ?? '(no stack)',
      '',
      'Component stack:',
      componentStack ?? '(no component stack)',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(payload);
    } catch (e) {
      console.warn('[RouteBoundary] clipboard write failed:', e);
    }
  };

  private handleTellJames = () => {
    const { error } = this.state;
    const subject = encodeURIComponent('Co-Trader UI crash');
    const body = encodeURIComponent(
      [
        `Route: ${this.props.route}`,
        `Time: ${new Date().toISOString()}`,
        '',
        `Error: ${error?.name ?? 'Error'}: ${error?.message ?? ''}`,
        '',
        '(Paste full error details here — use "Copy error details" to grab them.)',
      ].join('\n')
    );
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  };

  public render() {
    if (!this.state.hasError) {
      // key forces a fresh subtree on retry. Stable when not in error state.
      return <React.Fragment key={this.state.resetKey}>{this.props.children}</React.Fragment>;
    }

    const { error } = this.state;
    const shortMsg = truncate(error?.message ?? String(error ?? 'Unknown error'), MAX_MESSAGE_CHARS);

    return (
      <div className="min-h-[60vh] flex items-center justify-center p-4">
        <Card className="max-w-xl w-full p-6 space-y-4 border-destructive/40">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-md bg-destructive/10 shrink-0">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">
                <code className="font-mono text-sm">{this.props.route}</code> failed to render
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                This page crashed. Other pages are still working.
              </p>
            </div>
          </div>

          <div className="p-3 rounded-md bg-muted/50 border border-border">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
              {error?.name ?? 'Error'}
            </div>
            <p className="text-xs font-mono text-foreground/80 break-all whitespace-pre-wrap">
              {shortMsg || '(no message)'}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={this.handleRetry}>
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              Retry
            </Button>
            <Button size="sm" variant="outline" onClick={this.handleCopy}>
              <ClipboardCopy className="w-3.5 h-3.5 mr-1.5" />
              Copy error details
            </Button>
            <Button size="sm" variant="outline" onClick={this.handleTellJames}>
              <Mail className="w-3.5 h-3.5 mr-1.5" />
              Tell James
            </Button>
          </div>

          <div className="border-t border-border pt-3">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
              Try another page
            </div>
            <div className="flex flex-wrap gap-3 text-xs">
              <Link to="/" className="inline-flex items-center gap-1 text-primary hover:underline">
                <Home className="w-3 h-3" />
                Home
              </Link>
              <Link to="/health" className="inline-flex items-center gap-1 text-primary hover:underline">
                <Activity className="w-3 h-3" />
                Health
              </Link>
              <Link to="/book" className="text-primary hover:underline">
                Book
              </Link>
              <Link to="/scorecard" className="text-primary hover:underline">
                Scorecard
              </Link>
              <Link to="/session" className="text-primary hover:underline">
                Timeline
              </Link>
            </div>
          </div>
        </Card>
      </div>
    );
  }
}

export default RouteBoundary;
