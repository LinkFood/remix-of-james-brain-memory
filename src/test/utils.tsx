import React, { ReactElement } from 'react';
import { render, RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from '@/components/ui/sonner';

/**
 * Create a fresh QueryClient for each test
 */
const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        staleTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });

interface WrapperProps {
  children: React.ReactNode;
}

/**
 * Provider wrapper for tests that includes all necessary providers
 */
function AllProviders({ children }: WrapperProps) {
  const queryClient = createTestQueryClient();

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {children}
        <Toaster />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

/**
 * Custom render function that wraps components with all providers
 */
const customRender = (
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) => render(ui, { wrapper: AllProviders, ...options });

// Re-export everything from testing-library
export * from '@testing-library/react';

// Override render with our custom version
export { customRender as render };
