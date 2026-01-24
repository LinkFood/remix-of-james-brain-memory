/**
 * Sentry Error Tracking Configuration
 * 
 * Initializes Sentry for production error monitoring.
 * Only activates in production mode with a valid DSN.
 * 
 * @module lib/sentry
 */

import * as Sentry from '@sentry/react';

/**
 * Initialize Sentry error tracking
 * Call this once at application startup (main.tsx)
 */
export function initSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  const isProd = import.meta.env.PROD;

  // Only initialize in production with a valid DSN
  if (!isProd || !dsn) {
    if (!isProd) {
      console.log('[Sentry] Skipped initialization (development mode)');
    }
    return;
  }

  Sentry.init({
    dsn,
    environment: 'production',
    
    // Performance monitoring
    tracesSampleRate: 0.1, // 10% of transactions
    
    // Session replay for debugging (optional - captures user sessions)
    replaysSessionSampleRate: 0.1, // 10% of sessions
    replaysOnErrorSampleRate: 1.0, // 100% of sessions with errors
    
    // Filter out common non-actionable errors
    ignoreErrors: [
      // Browser extensions
      'top.GLOBALS',
      'chrome-extension://',
      'moz-extension://',
      // Network errors that users experience
      'Network request failed',
      'Failed to fetch',
      'Load failed',
      // ResizeObserver spam
      'ResizeObserver loop',
    ],
    
    // Before sending, add extra context
    beforeSend(event, hint) {
      // Add current URL
      if (typeof window !== 'undefined') {
        event.extra = {
          ...event.extra,
          currentUrl: window.location.href,
        };
      }
      
      return event;
    },
  });

  console.log('[Sentry] Initialized for production');
}

/**
 * Set user context for Sentry
 * Call when user logs in
 */
export function setSentryUser(userId: string, email?: string) {
  if (!import.meta.env.PROD) return;
  
  Sentry.setUser({
    id: userId,
    email,
  });
}

/**
 * Clear user context from Sentry
 * Call when user logs out
 */
export function clearSentryUser() {
  if (!import.meta.env.PROD) return;
  
  Sentry.setUser(null);
}

/**
 * Capture an exception with Sentry
 * Use this for manual error reporting
 */
export function captureException(error: Error | unknown, context?: Record<string, unknown>) {
  if (!import.meta.env.PROD) {
    console.error('[Sentry would capture]:', error, context);
    return;
  }
  
  Sentry.captureException(error, {
    extra: context,
  });
}

/**
 * Add a breadcrumb for debugging
 * Breadcrumbs appear in the Sentry UI to show what happened before an error
 */
export function addBreadcrumb(
  message: string, 
  category: string = 'app', 
  level: 'debug' | 'info' | 'warning' | 'error' = 'info'
) {
  if (!import.meta.env.PROD) return;
  
  Sentry.addBreadcrumb({
    message,
    category,
    level,
    timestamp: Date.now() / 1000,
  });
}

// Re-export Sentry for direct access if needed
export { Sentry };
