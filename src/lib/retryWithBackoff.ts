import { toast } from "sonner";

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, max: number) => void;
  toastId?: string;
  showToast?: boolean;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    onRetry,
    toastId,
    showToast = false,
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      // Dismiss retry toast on success
      if (toastId) {
        toast.dismiss(toastId);
      }
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt < maxRetries) {
        // Calculate exponential backoff delay
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        
        // Notify about retry
        if (onRetry) {
          onRetry(attempt, maxRetries);
        }
        
        if (showToast && toastId) {
          toast.loading(`Connection issue - retrying... (${attempt}/${maxRetries})`, { id: toastId });
        }
        
        // Wait before next retry
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // Dismiss retry toast on final failure
  if (toastId) {
    toast.dismiss(toastId);
  }

  throw lastError;
}
