/**
 * Logger utility for consistent logging across the application
 * 
 * In development, logs to console with formatting.
 * In production, can be extended to send to external services.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

interface LogEntry {
  level: LogLevel;
  message: string;
  context?: LogContext;
  timestamp: string;
  url: string;
}

class Logger {
  private isDev = import.meta.env.DEV;

  private formatEntry(level: LogLevel, message: string, context?: LogContext): LogEntry {
    return {
      level,
      message,
      context,
      timestamp: new Date().toISOString(),
      url: typeof window !== 'undefined' ? window.location.href : '',
    };
  }

  private send(entry: LogEntry) {
    // In development, use console
    if (this.isDev) {
      const prefix = `[${entry.level.toUpperCase()}]`;
      const consoleMethod =
        entry.level === 'error'
          ? 'error'
          : entry.level === 'warn'
            ? 'warn'
            : 'log';

      if (entry.context && Object.keys(entry.context).length > 0) {
        console[consoleMethod](prefix, entry.message, entry.context);
      } else {
        console[consoleMethod](prefix, entry.message);
      }
      return;
    }

    // In production, could send to external service
    // TODO: Integrate with Sentry or similar
    // fetch('/api/logs', { method: 'POST', body: JSON.stringify(entry) });
  }

  /**
   * Log a debug message (only in development)
   */
  debug(message: string, context?: LogContext) {
    if (this.isDev) {
      this.send(this.formatEntry('debug', message, context));
    }
  }

  /**
   * Log an info message
   */
  info(message: string, context?: LogContext) {
    this.send(this.formatEntry('info', message, context));
  }

  /**
   * Log a warning message
   */
  warn(message: string, context?: LogContext) {
    this.send(this.formatEntry('warn', message, context));
  }

  /**
   * Log an error with optional Error object
   */
  error(message: string, error?: Error | unknown, context?: LogContext) {
    const errorContext: LogContext = { ...context };

    if (error instanceof Error) {
      errorContext.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    } else if (error !== undefined) {
      errorContext.error = String(error);
    }

    this.send(this.formatEntry('error', message, errorContext));
  }

  /**
   * Time an operation and log the duration
   */
  time(label: string): () => void {
    const start = performance.now();
    return () => {
      const duration = Math.round(performance.now() - start);
      this.debug(`${label} completed`, { durationMs: duration });
    };
  }
}

export const logger = new Logger();
